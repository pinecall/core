/**
 * Live view — the terminal renderer behind `pinecall run`.
 *
 * One event model, two renderers:
 *
 *   TTY      a rolling transcript where the CURRENT line (the caller's interim
 *            words, the bot's line growing word by word, or the turn state)
 *            is redrawn in place — `\r` + erase-line, only ever the LAST line,
 *            so scrollback stays sane. Finalised lines are printed once.
 *
 *   non-TTY  one line per FINAL event, prefixed with the time since the call
 *            started, no cursor movement and no escape codes — logs and CI
 *            keep working.
 *
 * Everything is written through the injected `out`, so tests drive it with a
 * fake stream and a fake clock; nothing in here touches process.stdout.
 *
 * ── What is state and what is paint ──────────────────────────────────────
 *
 * This file no longer decides WHAT was said — only how to draw it. The event →
 * conversation state machine lives in `./console/transcript-reducer.ts` and is
 * shared with the web console's CallsModel and with the browser app, so the
 * three observers of a `pinecall run` process cannot drift. The view owns a
 * store, subscribes agents to it, and paints the effects it emits:
 *
 *   session.started / session.ended · ringing
 *   caller.line · agent.line · tool.call · tool.result
 *   draft            ← the live last line moved (interim, bot words, turn state)
 *   wa.message / wa.response
 *
 * The semantics (interims replace, the bot line is what has been HEARD, chat
 * replies settle, an unannounced session gets an implicit context) are
 * documented in the reducer.
 */

import { palette, stripAnsi, type Palette } from "./ui.js";
import {
    createTranscriptStore,
    type CallSnapshot,
    type TranscriptEffect,
    type TranscriptState,
    type TranscriptStore,
} from "./console/transcript-reducer.js";

// ── Public surface ───────────────────────────────────────────────────────

/** The slice of a writable stream the view needs. */
export interface LiveViewStream {
    write(chunk: string): unknown;
    columns?: number;
}

export interface LiveViewOptions {
    /** Where to render — process.stdout in the runner, a fake in tests. */
    out: LiveViewStream;
    /** Interactive terminal: redraw the last line in place. */
    tty: boolean;
    /** ANSI colours (false under NO_COLOR or when not a TTY). */
    color: boolean;
    /** Debug mode: print every event name + payload summary (both renderers). */
    events?: boolean;
    /** Milliseconds clock — injectable for tests. Default Date.now. */
    clock?: () => number;
    /** Terminal width for the redrawn line. Default out.columns ?? 80. */
    columns?: number;
    /**
     * How long a text reply (chat, or a session whose channel is unknown) waits
     * for more chunks — or for `bot.word`s that would make it a voice line —
     * before it is fixed as the agent line. Default 300 ms.
     */
    settleMs?: number;
}

/** The slice of Agent the view subscribes to. */
export interface LiveViewAgent {
    id: string;
    on(event: string, handler: (...args: any[]) => void): unknown;
    off(event: string, handler: (...args: any[]) => void): unknown;
}

/** The slice of Call the view reads. */
export interface LiveViewCall {
    id: string;
    from?: string;
    to?: string;
    direction?: string;
    transport?: string;
    duration?: number;
}

export interface LiveView {
    /** Subscribe to an agent's events. Returns the matching detach. */
    attach(agent: LiveViewAgent): () => void;
    /** Unsubscribe an agent attached earlier. */
    detach(agent: LiveViewAgent): void;
    /** Print a plain line (boot banner, notices) through the same stream, keeping the live line intact. */
    print(line: string): void;
    /** Print a tool result (`✓ …`) under the call the tool ran in. */
    toolResult(agent: LiveViewAgent, call: LiveViewCall | undefined, result: unknown): void;
    /** Format a JSON value for the terminal — exposed so the runner shares one colouriser. */
    json(value: unknown, inline?: boolean): string;
    /** Turn the every-event debug mode on or off at runtime (the runner's `e` key). */
    setEvents(on: boolean): void;
    /** Whether debug mode is on right now. */
    readonly events: boolean;
    /** The conversation state — shared with the web console so the two cannot drift. */
    readonly store: TranscriptStore;
    /** The palette in use (respects `color`). */
    readonly c: Palette;
}

// ── Internals ────────────────────────────────────────────────────────────

const INDENT = "  ";
const TOOL_INDENT = "          ";
/** Off a TTY the timestamp leads the line, so the tool indent goes after it. */
const TOOL_GAP = "        ";
const LABEL_WIDTH = 6; // "caller"

/** Events subscribed in debug mode — every typed AgentEvents name that carries a call or session. */
const DEBUG_EVENTS = [
    "call.started", "call.ended", "call.ringing", "call.preparingTimeout", "chat.started", "whatsapp.started",
    "speech.started", "speech.ended", "user.speaking", "user.message",
    "eager.turn", "turn.pause", "turn.end", "turn.resumed", "turn.continued",
    "bot.speaking", "bot.word", "bot.finished", "bot.interrupted",
    "message.confirmed", "reply.rejected", "audio.metrics",
    "session.idleWarning", "session.timeout", "session.paused", "session.resumed",
    "llm.toolCall", "skill.loaded", "skill.unloaded", "memory.ops",
    "channel.added", "channel.configured", "channel.removed",
    "whatsapp.message", "whatsapp.response", "whatsapp.status",
    "whatsapp.sessionStarted", "whatsapp.sessionEnded",
];

export function createLiveView(opts: LiveViewOptions): LiveView {
    const out = opts.out;
    const tty = opts.tty;
    let debug = opts.events === true;
    const clock = opts.clock ?? (() => Date.now());
    const c = palette(opts.color);

    const store = createTranscriptStore({ clock, settleMs: opts.settleMs });
    const calls = store.live;

    /** Attached agents: the emitter, its debug subscriptions, and the store's detach. */
    interface Attached {
        agent: LiveViewAgent;
        debugSubs: Array<[string, (...a: any[]) => void]>;
        release: () => void;
    }
    const agents = new Map<string, Attached>();
    /** The redrawable last line (TTY only). null = cursor sits on a fresh line. */
    let live: string | null = null;

    // ── Low-level writing ────────────────────────────────────────────

    const width = () => opts.columns ?? out.columns ?? 80;

    /** Print a finished line. In a TTY the live line is cleared first and redrawn after. */
    function emitLine(line: string): void {
        if (tty && live !== null) {
            out.write(`\r\x1b[2K${line}\n${live}`);
        } else {
            out.write(`${line}\n`);
        }
    }

    /** Replace the live last line (TTY). Ignored on non-TTY — nothing there is final. */
    function setLive(line: string | null): void {
        if (!tty) return;
        if (line === null) {
            if (live !== null) out.write("\r\x1b[2K");
            live = null;
            return;
        }
        // One physical line, always: a newline inside it would break the redraw.
        const fitted = fit(line.replace(/\r?\n/g, " ⏎ "), width() - 1);
        out.write(`\r\x1b[2K${fitted}`);
        live = fitted;
    }

    /** Keep a line inside the terminal width: keep the start, elide the middle, keep the tail (the newest words). */
    function fit(line: string, max: number): string {
        const visible = stripAnsi(line);
        if (visible.length <= max || max < 16) return line;
        // Work on the plain text — colours on a redrawn line are cosmetic, legibility wins.
        const head = visible.slice(0, 12);
        const tail = visible.slice(visible.length - (max - 13));
        return `${head}…${tail}`;
    }

    // ── Prefixes and timing ─────────────────────────────────────────

    const rel = (cs: CallSnapshot | undefined) =>
        cs ? `t+${((clock() - cs.startedAt) / 1000).toFixed(1)}s` : "";

    /**
     * `extra` counts calls that are no longer in the store but still being
     * drawn — the "call ended" line belongs to the session that just left, so
     * it keeps the prefix it had while it was live.
     */
    function prefix(agentId: string, cs?: CallSnapshot, extra = 0): string {
        let p = "";
        if (agents.size > 1) p += c.dim(`[${agentId}] `);
        if (cs && calls.size + extra > 1) p += c.dim(`[${shortId(cs.id)}] `);
        if (!tty && cs) p += c.dim(rel(cs).padEnd(8)) + " ";
        return p;
    }

    const shortId = (id: string) => (id.length > 6 ? id.slice(-6) : id);

    /** Indent for tool lines: deep in a TTY; off a TTY the timestamp leads and the gap follows it. */
    const toolIndent = (agentId: string, cs?: CallSnapshot) =>
        tty ? `${TOOL_INDENT}${prefix(agentId, cs)}` : `${INDENT}${prefix(agentId, cs)}${TOOL_GAP}`;

    const agentLabel = (id: string) => (id.length <= LABEL_WIDTH ? id.padEnd(LABEL_WIDTH) : id);

    // ── Transcript lines ────────────────────────────────────────────

    function callerLine(cs: CallSnapshot, text: string): void {
        emitLine(`${INDENT}${prefix(cs.agent, cs)}${c.cyan("caller")} ${c.dim("›")} ${text}`);
    }

    function agentLine(cs: CallSnapshot, text: string, cut = false): void {
        const marker = cut ? ` ${c.dim("⏏")}` : "";
        const label = agentLabel(cs.agent);
        // A multi-line reply (chat) continues under its own label.
        const body = text.replace(/\r?\n/g, `\n${INDENT}${" ".repeat(stripAnsi(prefix(cs.agent, cs)).length + label.length + 3)}`);
        emitLine(`${INDENT}${prefix(cs.agent, cs)}${c.purple(label)} ${c.dim("›")} ${body}${marker}`);
    }

    /** Redraw the last line for the call that last moved: interim caller words, the growing bot line, or the turn state. */
    function refresh(cs: CallSnapshot): void {
        if (!tty) return;
        const status = `${c.dim("·")} ${stateGlyph(cs.state)} ${c.dim(rel(cs))}`;
        const pre = `${INDENT}${prefix(cs.agent, cs)}`;
        const bot = cs.draft.agent;
        if (bot !== undefined && cs.state === "speaking") {
            setLive(`${pre}${c.purple(agentLabel(cs.agent))} ${c.dim("›")} ${bot}${bot ? " " : ""}${status}`);
        } else if (cs.draft.caller) {
            setLive(`${pre}${c.cyan("caller")} ${c.dim("›")} ${cs.draft.caller} ${status}`);
        } else {
            setLive(`${pre}${stateGlyph(cs.state)} ${c.dim(rel(cs))}`);
        }
    }

    function stateGlyph(state: TranscriptState): string {
        switch (state) {
            case "thinking": return `${c.yellow("●")} thinking`;
            case "pause": return `${c.dim("●")} pause`;
            case "speaking": return `${c.purple("●")} speaking`;
            default: return `${c.green("●")} listening`;
        }
    }

    // ── Effects → paint ─────────────────────────────────────────────

    store.on((e: TranscriptEffect) => {
        switch (e.kind) {
            case "session.started": {
                const cs = e.call;
                const when = tty ? ` ${c.dim("—")} ${c.dim(wallClock(clock()))}` : "";
                if (e.implicit) {
                    // Nobody announced this session (pinecall chat, the MCP chat tool, an llm.chat client).
                    emitLine(`${INDENT}${prefix(cs.agent, cs)}${c.green("☎")}  session ${c.dim("—")} ${c.bold(cs.peer || "chat")} ${c.dim(`· ${cs.channel}`)}${when}`);
                } else {
                    const dir = cs.direction === "outbound" ? "outgoing" : "incoming";
                    const kind = cs.channel === "chat" ? "chat" : cs.channel === "whatsapp" ? "whatsapp" : "call";
                    emitLine(`${INDENT}${prefix(cs.agent, cs)}${c.green("☎")}  ${dir} ${kind} ${c.dim("—")} ${c.bold(cs.peer || "unknown")} ${c.dim(`· ${cs.channel}`)}${when}`);
                }
                return;
            }
            case "session.ended": {
                const cs = e.call;
                const secs = e.durationS;
                const dur = `${secs < 10 ? secs.toFixed(1) : Math.round(secs)}s`;
                setLive(null);
                emitLine(`${INDENT}${prefix(cs.agent, cs, 1)}${c.dim("☎")}  call ended ${c.dim("—")} ${c.dim(e.reason)} ${c.dim(`(${dur})`)}`);
                emitLine("");
                // Another call still running? Put its state back on the last line.
                const next = calls.values().next();
                if (!next.done) refresh(next.value);
                return;
            }
            case "ringing":
                emitLine(`${INDENT}${prefix(e.agent)}${c.green("☎")}  ringing ${c.dim("—")} ${c.bold(e.from || "unknown")}`);
                return;
            case "caller.line":
                callerLine(e.call, e.text);
                return;
            case "agent.line":
                agentLine(e.call, e.text, e.cut);
                return;
            case "tool.call": {
                const argsStr = typeof e.args === "string" ? e.args : json(e.args, true);
                emitLine(`${toolIndent(e.agent, e.call)}${c.yellow("⚡")} ${c.yellow(c.bold(e.name))}(${argsStr})`);
                return;
            }
            case "tool.result": {
                // Short results stay on the ✓ line; long objects go pretty, one key per line.
                const inline = json(e.result, true);
                const display = stripAnsi(inline).length <= 72 ? inline : json(e.result);
                if (!display) return;
                emitLine(`${toolIndent(e.agent, e.call)}${c.green("✓")} ${display}`);
                return;
            }
            case "draft":
                refresh(e.call);
                return;
            case "wa.message":
                if (e.text) emitLine(`${INDENT}${prefix(e.agent)}${c.cyan(e.who)} ${c.dim("›")} ${e.text}`);
                return;
            case "wa.response": {
                const human = e.source === "human" ? ` ${c.dim("(human)")}` : "";
                if (e.text) emitLine(`${INDENT}${prefix(e.agent)}${c.purple(agentLabel(e.agent))} ${c.dim("›")} ${e.text}${human}`);
                return;
            }
        }
    });

    // ── Debug: every event, one line ────────────────────────────────

    const onDebug = (agent: LiveViewAgent, name: string) => (...args: unknown[]) => {
        const call = findCall(name, args);
        const cs = call ? calls.get(call.id) : undefined;
        const stamp = tty && cs ? `${c.dim(rel(cs))} ` : "";
        emitLine(`${INDENT}${prefix(agent.id, cs)}${stamp}${c.dim("·")} ${c.dim(name)} ${c.dim(summarize(name, args))}`);
    };

    function findCall(name: string, args: unknown[]): LiveViewCall | undefined {
        if (name === "call.started" || name === "call.ended") return args[0] as LiveViewCall;
        const second = args[1];
        if (second && typeof second === "object" && "id" in (second as object)) return second as LiveViewCall;
        return undefined;
    }

    // ── attach / detach ─────────────────────────────────────────────

    function attach(agent: LiveViewAgent): () => void {
        if (agents.has(agent.id)) return () => detach(agent);
        // Registered first: prefixes read agents.size, and the first line of
        // the first event must already know how many agents there are.
        const entry: Attached = { agent, debugSubs: [], release: () => {} };
        agents.set(agent.id, entry);
        // The store subscribes before the debug handlers, so a transcript line
        // still lands before the debug line that describes the same event.
        entry.release = store.attach(agent);
        if (debug) subscribeDebug(entry);
        return () => detach(agent);
    }

    function detach(agent: LiveViewAgent): void {
        const entry = agents.get(agent.id);
        if (!entry) return;
        unsubscribeDebug(entry);
        entry.release();
        agents.delete(agent.id);
    }

    function subscribeDebug(entry: Attached): void {
        if (entry.debugSubs.length > 0) return;
        for (const name of DEBUG_EVENTS) {
            const handler = onDebug(entry.agent, name);
            entry.debugSubs.push([name, handler]);
            entry.agent.on(name, handler);
        }
    }

    function unsubscribeDebug(entry: Attached): void {
        for (const [name, handler] of entry.debugSubs) entry.agent.off(name, handler);
        entry.debugSubs.length = 0;
    }

    /** `e` at runtime: start (or stop) printing every event, without a restart. */
    function setEvents(on: boolean): void {
        if (on === debug) return;
        debug = on;
        for (const entry of agents.values()) {
            if (on) subscribeDebug(entry);
            else unsubscribeDebug(entry);
        }
    }

    // ── Public helpers ──────────────────────────────────────────────

    function print(line: string): void {
        emitLine(line);
    }

    function toolResult(agent: LiveViewAgent, call: LiveViewCall | undefined, result: unknown): void {
        store.toolResult(agent.id, call, result);
    }

    /** Colourise a JSON value: keys cyan, strings green, numbers yellow, booleans purple. */
    function json(value: unknown, inline = false): string {
        if (value === null || value === undefined) return c.dim("null");
        if (typeof value === "string") return c.green(`"${value}"`);
        if (typeof value === "number") return c.yellow(String(value));
        if (typeof value === "boolean") return c.purple(String(value));

        if (Array.isArray(value)) {
            if (value.length === 0) return c.dim("[]");
            return `[${value.map((v) => json(v, inline)).join(c.dim(", "))}]`;
        }

        if (typeof value === "object") {
            const entries = Object.entries(value as Record<string, unknown>);
            if (entries.length === 0) return c.dim("{}");
            if (inline) {
                return entries.map(([k, v]) => `${c.cyan(k)}${c.dim(":")} ${json(v, true)}`).join(c.dim(", "));
            }
            const parts = entries.map(([k, v]) => `            ${c.cyan(k)}${c.dim(":")} ${json(v, false)}`);
            return `\n${parts.join("\n")}`;
        }

        return String(value);
    }

    return {
        attach, detach, print, toolResult, json, setEvents, store, c,
        get events() { return debug; },
    };
}

// ── Pure helpers ─────────────────────────────────────────────────────────

function wallClock(ms: number): string {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** One-line payload summary for debug mode: the event's own fields, compact, capped. */
export function summarize(name: string, args: unknown[]): string {
    const MAX = 110;
    let text: string;
    if (name === "call.started" || name === "call.ended") {
        const call = args[0] as Partial<LiveViewCall> | undefined;
        const o: Record<string, unknown> = {
            id: call?.id, from: call?.from, to: call?.to, direction: call?.direction, transport: call?.transport,
        };
        if (name === "call.ended") o.reason = args[1];
        text = compact(o);
    } else {
        const first = args[0];
        if (first && typeof first === "object") {
            const o: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(first as Record<string, unknown>)) {
                if (k === "event" || k === "callId") continue;
                if (typeof v === "function") continue;
                o[k] = v;
            }
            text = compact(o);
        } else {
            text = first === undefined ? "" : compact(first);
        }
    }
    return text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text;
}

function compact(value: unknown): string {
    try {
        const s = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v));
        return s === undefined ? "" : s.replace(/"([A-Za-z_][A-Za-z0-9_]*)":/g, "$1:");
    } catch {
        return String(value);
    }
}

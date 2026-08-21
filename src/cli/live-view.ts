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
 * What it listens to is exactly what the SDK emits (src/domain/agent.ts):
 *   call.started / call.ended / call.ringing
 *   speech.started · user.speaking {text} · user.message {text}
 *   eager.turn · turn.pause · turn.end · turn.resumed · turn.continued
 *   bot.speaking {text} · bot.word {word} · bot.finished · bot.interrupted
 *   llm.toolCall {toolCalls[]}
 *   whatsapp.message {from,name,text} · whatsapp.response {to,text}
 *
 * The bot's line is what has been HEARD: on voice, `bot.speaking` may carry
 * the whole text up front but nothing is shown until `bot.word` plays it;
 * chat and WhatsApp have no audio and no words, so there `bot.speaking` IS
 * the line (chunks are appended as they stream).
 */

import { palette, stripAnsi, type Palette } from "./ui.js";

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
    /** The palette in use (respects `color`). */
    readonly c: Palette;
}

// ── Internals ────────────────────────────────────────────────────────────

type TurnState = "listening" | "thinking" | "pause" | "speaking";

interface CallState {
    id: string;
    agentId: string;
    label: string;
    transport: string;
    startedAt: number;
    /** Interim caller text (voice) — replaced on each user.speaking, fixed on user.message. */
    interim: string;
    /** The bot line being built. null = no utterance in flight. */
    bot: string | null;
    /** Full text announced by bot.speaking (voice fallback when no words arrive). */
    botAnnounced: string;
    state: TurnState;
}

const INDENT = "  ";
const TOOL_INDENT = "          ";
/** Off a TTY the timestamp leads the line, so the tool indent goes after it. */
const TOOL_GAP = "        ";
const LABEL_WIDTH = 6; // "caller"

/** Events subscribed in debug mode — every typed AgentEvents name that carries a call or session. */
const DEBUG_EVENTS = [
    "call.started", "call.ended", "call.ringing", "call.preparingTimeout",
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
    const debug = opts.events === true;
    const clock = opts.clock ?? (() => Date.now());
    const c = palette(opts.color);

    const agents = new Map<string, Array<[string, (...a: any[]) => void]>>();
    const calls = new Map<string, CallState>();
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
        const fitted = fit(line, width() - 1);
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

    const rel = (cs: CallState | undefined) =>
        cs ? `t+${((clock() - cs.startedAt) / 1000).toFixed(1)}s` : "";

    function prefix(agentId: string, cs?: CallState): string {
        let p = "";
        if (agents.size > 1) p += c.dim(`[${agentId}] `);
        if (cs && calls.size > 1) p += c.dim(`[${shortId(cs.id)}] `);
        if (!tty && cs) p += c.dim(rel(cs).padEnd(8)) + " ";
        return p;
    }

    const shortId = (id: string) => (id.length > 6 ? id.slice(-6) : id);

    /** Indent for tool lines: deep in a TTY; off a TTY the timestamp leads and the gap follows it. */
    const toolIndent = (agentId: string, cs?: CallState) =>
        tty ? `${TOOL_INDENT}${prefix(agentId, cs)}` : `${INDENT}${prefix(agentId, cs)}${TOOL_GAP}`;

    const agentLabel = (id: string) => (id.length <= LABEL_WIDTH ? id.padEnd(LABEL_WIDTH) : id);

    // ── Transcript lines ────────────────────────────────────────────

    function callerLine(cs: CallState, text: string): void {
        emitLine(`${INDENT}${prefix(cs.agentId, cs)}${c.cyan("caller")} ${c.dim("›")} ${text}`);
    }

    function agentLine(cs: CallState, text: string, cut = false): void {
        const marker = cut ? ` ${c.dim("⏏")}` : "";
        emitLine(`${INDENT}${prefix(cs.agentId, cs)}${c.purple(cs.label)} ${c.dim("›")} ${text}${marker}`);
    }

    /** Redraw the last line for the call that last moved: interim caller words, the growing bot line, or the turn state. */
    function refresh(cs: CallState): void {
        if (!tty) return;
        const status = `${c.dim("·")} ${stateGlyph(cs.state)} ${c.dim(rel(cs))}`;
        const pre = `${INDENT}${prefix(cs.agentId, cs)}`;
        if (cs.bot !== null && cs.state === "speaking") {
            setLive(`${pre}${c.purple(cs.label)} ${c.dim("›")} ${cs.bot}${cs.bot ? " " : ""}${status}`);
        } else if (cs.interim) {
            setLive(`${pre}${c.cyan("caller")} ${c.dim("›")} ${cs.interim} ${status}`);
        } else {
            setLive(`${pre}${stateGlyph(cs.state)} ${c.dim(rel(cs))}`);
        }
    }

    function stateGlyph(state: TurnState): string {
        switch (state) {
            case "listening": return `${c.green("●")} listening`;
            case "thinking": return `${c.yellow("●")} thinking`;
            case "pause": return `${c.dim("●")} pause`;
            case "speaking": return `${c.purple("●")} speaking`;
        }
    }

    function setState(cs: CallState, state: TurnState): void {
        cs.state = state;
        refresh(cs);
    }

    /** Close the bot line in flight, if any. */
    function finishBot(cs: CallState, cut = false): void {
        if (cs.bot === null) return;
        const text = cs.bot || cs.botAnnounced;
        if (text) agentLine(cs, text, cut);
        cs.bot = null;
        cs.botAnnounced = "";
    }

    const isText = (transport: string) => transport === "chat" || transport === "whatsapp";

    /** Append a spoken word with single-space joining. */
    function appendWord(line: string, word: string): string {
        const w = word.trim();
        if (!w) return line;
        return line ? `${line} ${w}` : w;
    }

    // ── Event handlers ──────────────────────────────────────────────

    function onCallStarted(agent: LiveViewAgent, call: LiveViewCall): void {
        if (calls.has(call.id)) return;
        const cs: CallState = {
            id: call.id,
            agentId: agent.id,
            label: agentLabel(agent.id),
            transport: call.transport ?? "unknown",
            startedAt: clock(),
            interim: "",
            bot: null,
            botAnnounced: "",
            state: "listening",
        };
        calls.set(call.id, cs);
        const dir = call.direction === "outbound" ? "outgoing" : "incoming";
        const peer = (call.direction === "outbound" ? call.to : call.from) || "unknown";
        const kind = cs.transport === "chat" ? "chat" : cs.transport === "whatsapp" ? "whatsapp" : "call";
        const when = tty ? ` ${c.dim("—")} ${c.dim(wallClock(clock()))}` : "";
        emitLine(`${INDENT}${prefix(agent.id, cs)}${c.green("☎")}  ${dir} ${kind} ${c.dim("—")} ${c.bold(peer)} ${c.dim(`· ${cs.transport}`)}${when}`);
        refresh(cs);
    }

    function onCallEnded(agent: LiveViewAgent, call: LiveViewCall, reason: string): void {
        const cs = calls.get(call.id);
        if (!cs) return;
        finishBot(cs);
        cs.interim = "";
        const secs = call.duration && call.duration > 0 ? call.duration : (clock() - cs.startedAt) / 1000;
        const dur = `${secs < 10 ? secs.toFixed(1) : Math.round(secs)}s`;
        setLive(null);
        emitLine(`${INDENT}${prefix(agent.id, cs)}${c.dim("☎")}  call ended ${c.dim("—")} ${c.dim(reason)} ${c.dim(`(${dur})`)}`);
        emitLine("");
        calls.delete(call.id);
        // Another call still running? Put its state back on the last line.
        const next = calls.values().next();
        if (!next.done) refresh(next.value);
    }

    function onRinging(agent: LiveViewAgent, ringing: { from?: string; to?: string }): void {
        emitLine(`${INDENT}${prefix(agent.id)}${c.green("☎")}  ringing ${c.dim("—")} ${c.bold(ringing.from || "unknown")}`);
    }

    function withCall(fn: (cs: CallState, event: any) => void) {
        return (event: any, call: LiveViewCall | undefined) => {
            const cs = call ? calls.get(call.id) : undefined;
            if (cs) fn(cs, event);
        };
    }

    const onSpeechStarted = withCall((cs) => {
        if (cs.state !== "speaking") setState(cs, "listening");
    });

    const onUserSpeaking = withCall((cs, event) => {
        const text = typeof event?.text === "string" ? event.text : "";
        cs.interim = text;
        if (cs.state !== "listening") cs.state = "listening";
        refresh(cs);
    });

    const onUserMessage = withCall((cs, event) => {
        const text = typeof event?.text === "string" ? event.text : "";
        // A bot line still open on a text channel (chat): the user replied, so it is done.
        if (isText(cs.transport)) finishBot(cs);
        cs.interim = "";
        if (text) callerLine(cs, text);
        // Chat has no turn detector — the model starts right away.
        setState(cs, isText(cs.transport) ? "thinking" : cs.state);
    });

    const onThinking = withCall((cs) => setState(cs, "thinking"));
    const onPause = withCall((cs) => setState(cs, "pause"));
    const onListening = withCall((cs) => setState(cs, "listening"));

    const onBotSpeaking = withCall((cs, event) => {
        const text = typeof event?.text === "string" ? event.text : "";
        if (isText(cs.transport)) {
            // Chunks stream in; bot.speaking IS the line.
            cs.bot = (cs.bot ?? "") + text;
        } else {
            // A new utterance: close the previous one (no bot.finished arrived), start empty.
            if (cs.bot !== null && cs.state === "speaking") finishBot(cs);
            cs.bot = "";
            cs.botAnnounced = text;
        }
        setState(cs, "speaking");
    });

    const onBotWord = withCall((cs, event) => {
        const word = typeof event?.word === "string" ? event.word : "";
        if (cs.bot === null) cs.bot = "";
        cs.bot = appendWord(cs.bot, word);
        cs.state = "speaking";
        refresh(cs);
    });

    const onBotFinished = withCall((cs) => {
        finishBot(cs);
        setState(cs, "listening");
    });

    const onBotInterrupted = withCall((cs) => {
        finishBot(cs, true);
        setState(cs, "listening");
    });

    const onToolCall = (agent: LiveViewAgent) => (event: any, call: LiveViewCall | undefined) => {
        const cs = call ? calls.get(call.id) : undefined;
        const items: Array<{ name?: string; arguments?: unknown }> =
            Array.isArray(event?.toolCalls) ? event.toolCalls : [];
        for (const item of items) {
            const name = item.name || "unknown";
            const args = parseArgs(item.arguments);
            const argsStr = typeof args === "string" ? args : json(args, true);
            emitLine(`${toolIndent(agent.id, cs)}${c.yellow("⚡")} ${c.yellow(c.bold(name))}(${argsStr})`);
        }
        if (cs) setState(cs, "thinking");
    };

    const onWaMessage = (agent: LiveViewAgent) => (event: any) => {
        const who = event?.name || event?.from || "whatsapp";
        const text = typeof event?.text === "string" ? event.text : "";
        if (text) emitLine(`${INDENT}${prefix(agent.id)}${c.cyan(String(who))} ${c.dim("›")} ${text}`);
    };

    const onWaResponse = (agent: LiveViewAgent) => (event: any) => {
        const text = typeof event?.text === "string" ? event.text : "";
        const human = event?.source === "human" ? ` ${c.dim("(human)")}` : "";
        if (text) emitLine(`${INDENT}${prefix(agent.id)}${c.purple(agentLabel(agent.id))} ${c.dim("›")} ${text}${human}`);
    };

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
        const subs: Array<[string, (...a: any[]) => void]> = [];
        const on = (event: string, handler: (...a: any[]) => void) => {
            subs.push([event, handler]);
            agent.on(event, handler);
        };

        on("call.started", (call: LiveViewCall) => onCallStarted(agent, call));
        on("call.ended", (call: LiveViewCall, reason: string) => onCallEnded(agent, call, reason ?? ""));
        on("call.ringing", (ringing: { from?: string; to?: string }) => onRinging(agent, ringing));
        on("speech.started", onSpeechStarted);
        on("user.speaking", onUserSpeaking);
        on("user.message", onUserMessage);
        on("eager.turn", onThinking);
        on("turn.end", onThinking);
        on("turn.pause", onPause);
        on("turn.resumed", onListening);
        on("turn.continued", onListening);
        on("bot.speaking", onBotSpeaking);
        on("bot.word", onBotWord);
        on("bot.finished", onBotFinished);
        on("bot.interrupted", onBotInterrupted);
        on("llm.toolCall", onToolCall(agent));
        on("whatsapp.message", onWaMessage(agent));
        on("whatsapp.response", onWaResponse(agent));

        if (debug) {
            for (const name of DEBUG_EVENTS) on(name, onDebug(agent, name));
        }

        agents.set(agent.id, subs);
        return () => detach(agent);
    }

    function detach(agent: LiveViewAgent): void {
        const subs = agents.get(agent.id);
        if (!subs) return;
        for (const [event, handler] of subs) agent.off(event, handler);
        agents.delete(agent.id);
    }

    // ── Public helpers ──────────────────────────────────────────────

    function print(line: string): void {
        emitLine(line);
    }

    function toolResult(agent: LiveViewAgent, call: LiveViewCall | undefined, result: unknown): void {
        const cs = call ? calls.get(call.id) : undefined;
        // Short results stay on the ✓ line; long objects go pretty, one key per line.
        const inline = json(result, true);
        const display = stripAnsi(inline).length <= 72 ? inline : json(result);
        if (!display) return;
        emitLine(`${toolIndent(agent.id, cs)}${c.green("✓")} ${display}`);
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

    return { attach, detach, print, toolResult, json, c };
}

// ── Pure helpers ─────────────────────────────────────────────────────────

/** Tool arguments arrive as a JSON string on the wire; older shapes may already be objects. */
function parseArgs(args: unknown): unknown {
    if (typeof args !== "string") return args ?? {};
    if (!args.trim()) return {};
    try {
        return JSON.parse(args);
    } catch {
        return args;
    }
}

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

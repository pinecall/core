/**
 * Transcript reducer — the ONE event → conversation state machine.
 *
 * `pinecall run` has three observers of the same agent events: the terminal
 * live view (src/cli/live-view.ts), the console server's CallsModel
 * (src/cli/console/calls-model.ts) and the web console in the browser. They
 * must never disagree about what was said, so none of them owns the logic:
 * they all feed the store below and render what comes out.
 *
 *   store.feed(agentId, "user.speaking", [{ text }, call])
 *        │
 *        ├── updates the CallSnapshot (the state anybody can read)
 *        └── emits effects: "a caller line was finalised", "the draft moved",
 *            "a tool ran", "the session ended" — one per thing a renderer
 *            would draw, in the order it should draw them.
 *
 * The semantics are exactly the ones the terminal view shipped with:
 *
 *   - `user.speaking` is interim: it REPLACES the caller draft; `user.message`
 *     fixes it as a line.
 *   - on voice, `bot.speaking` may carry the whole reply up front but nothing
 *     is shown until `bot.word` plays it — the line is what has been HEARD.
 *   - chat and WhatsApp have no audio and no words, so there `bot.speaking` IS
 *     the line: chunks are coalesced as they stream and fixed after a short
 *     settle (or on the next event).
 *   - a session that never announced itself (`pinecall chat`, the MCP chat
 *     tool, any llm.chat client) gets an implicit context on its first event.
 *   - `bot.interrupted` closes the line with a cut marker.
 *
 * Dependency-free and side-effect-free at import time on purpose: the browser
 * console imports this very file through a Vite alias, so it must not reach
 * for node:*, for the SDK's Agent type, or for anything at module scope.
 * Timers are injectable for the same reason (and so tests can drive them).
 *
 * Importable as `@pinecall/sdk/console`, or by relative path from the repo.
 */

// ── The state anybody can read ───────────────────────────────────────────

export type TranscriptChannel = "phone" | "webrtc" | "chat" | "whatsapp" | "unknown";

export type TranscriptState = "ringing" | "listening" | "thinking" | "pause" | "speaking" | "ended";

/** One finalised thing in the conversation. */
export interface TranscriptLine {
    who: "caller" | "agent" | "tool";
    /** What was said — for a tool line, a short rendering of the call. */
    text: string;
    at: number;
    final: boolean;
    /** The agent was cut off mid-utterance (bot.interrupted). */
    cut?: boolean;
    tool?: { name: string; args?: unknown; result?: unknown };
}

/** A call/session as the console shows it. Plain JSON — it goes over HTTP as-is. */
export interface CallSnapshot {
    id: string;
    agent: string;
    channel: TranscriptChannel;
    direction?: string;
    peer?: string;
    startedAt: number;
    endedAt?: number;
    durationS?: number;
    reason?: string;
    state: TranscriptState;
    lines: TranscriptLine[];
    /** What is in flight right now: the caller's interim words, the agent's growing line. */
    draft: { caller?: string; agent?: string };
}

/** The slice of a Call the reducer reads (matches the SDK's Call and the SSE payloads). */
export interface TranscriptCall {
    id: string;
    from?: string;
    to?: string;
    direction?: string;
    transport?: string;
    duration?: number;
}

// ── What a renderer is told ──────────────────────────────────────────────

export type TranscriptEffect =
    | { kind: "session.started"; agent: string; call: CallSnapshot; implicit: boolean }
    | { kind: "session.ended"; agent: string; call: CallSnapshot; reason: string; durationS: number }
    | { kind: "ringing"; agent: string; from?: string; to?: string }
    | { kind: "caller.line"; agent: string; call: CallSnapshot; text: string }
    | { kind: "agent.line"; agent: string; call: CallSnapshot; text: string; cut: boolean }
    | { kind: "tool.call"; agent: string; call?: CallSnapshot; name: string; args: unknown }
    | { kind: "tool.result"; agent: string; call?: CallSnapshot; name?: string; result: unknown }
    /** The draft or the turn state moved — redraw the live line / the open bubble. */
    | { kind: "draft"; agent: string; call: CallSnapshot }
    | { kind: "wa.message"; agent: string; who: string; text: string }
    | { kind: "wa.response"; agent: string; text: string; source?: string };

/** Every event the store subscribes to — one list, so no observer can drift. */
export const TRANSCRIPT_EVENTS = [
    "call.started", "call.ended", "call.ringing",
    "chat.started", "whatsapp.started",
    "speech.started", "user.speaking", "user.message",
    "eager.turn", "turn.end", "turn.pause", "turn.resumed", "turn.continued",
    "bot.speaking", "bot.word", "bot.finished", "bot.interrupted",
    "llm.toolCall",
    "whatsapp.message", "whatsapp.response",
] as const;

export type TranscriptEventName = (typeof TRANSCRIPT_EVENTS)[number];

// ── Options and surface ──────────────────────────────────────────────────

export interface TranscriptTimers {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
}

export interface TranscriptStoreOptions {
    /** Milliseconds clock — injectable for tests. Default Date.now. */
    clock?: () => number;
    /**
     * How long a text reply (chat, or a session whose channel is unknown) waits
     * for more chunks — or for `bot.word`s that would make it a voice line —
     * before it is fixed as the agent line. Default 300 ms.
     */
    settleMs?: number;
    /** How many ended sessions to keep. Default 50. */
    keepEnded?: number;
    /** setTimeout/clearTimeout, injectable so this module imports nothing. */
    timers?: TranscriptTimers;
}

/** The slice of Agent the store subscribes to — structural, so no SDK import. */
export interface TranscriptEmitter {
    id: string;
    on(event: string, handler: (...args: any[]) => void): unknown;
    off(event: string, handler: (...args: any[]) => void): unknown;
}

export interface TranscriptStore {
    /** Subscribe to an agent's events. Idempotent per id. Returns the matching detach. */
    attach(agent: TranscriptEmitter): () => void;
    /** Feed one agent event, with the handler's raw arguments. */
    feed(agentId: string, name: string, args: unknown[]): void;
    /**
     * A tool returned. Tool results are not an event — the SDK auto-executes
     * tools — so the runner's execute wrapper hands them in here.
     */
    toolResult(agentId: string, call: TranscriptCall | undefined, result: unknown): void;
    /** Drop everything an agent owns (pending timers included). */
    detach(agentId: string): void;
    /** Subscribe to effects. Returns the unsubscribe. */
    on(listener: (effect: TranscriptEffect) => void): () => void;
    /** Sessions in flight, by id — insertion ordered. */
    readonly live: ReadonlyMap<string, CallSnapshot>;
    /** Live + the last `keepEnded` ended sessions, newest first. */
    snapshots(): CallSnapshot[];
    get(id: string): CallSnapshot | undefined;
    /** Release every pending timer (process exit). */
    dispose(): void;
}

// ── Internals kept off the snapshot (so it stays JSON the UI can eat) ────

interface Internal {
    /** The bot line being built. null = no utterance in flight. */
    bot: string | null;
    /** Full text announced by bot.speaking (voice fallback when no words arrive). */
    botAnnounced: string;
    /** bot.word count of the utterance in flight — decides text vs voice when the channel is unknown. */
    words: number;
    /** Pending settle timer for a text reply (chat / unknown channel). */
    settle: unknown;
    /** Opened on the first event of a session that never sent call.started. */
    implicit: boolean;
    /** Everything the agent said this turn — a re-sent or cumulative bot.speaking must not print it twice. */
    lastBot: string;
    /** `event:messageId` pairs already applied — a re-sent wire/SSE frame must never produce a second bubble. */
    applied: Set<string>;
    /** `text -> ts` for messageId-less `user.message` (chat) — dedupes a re-sent frame within 2s. */
    recentUserText: Map<string, number>;
}

/**
 * True (and records it) when (event, messageId) was already applied for this
 * call — belt-and-braces against a duplicated wire/SSE frame. A messageId-less
 * `user.message` (chat has none) falls back to callId+text within 2s.
 */
function alreadyApplied(i: Internal, event: string, messageId: string, text: string, now: number): boolean {
    if (messageId) {
        const key = `${event}:${messageId}`;
        if (i.applied.has(key)) return true;
        i.applied.add(key);
        return false;
    }
    if (event !== "user.message") return false;
    const last = i.recentUserText.get(text);
    if (last !== undefined && now - last < 2000) return true;
    i.recentUserText.set(text, now);
    return false;
}

const DEFAULT_TIMERS: TranscriptTimers = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createTranscriptStore(opts: TranscriptStoreOptions = {}): TranscriptStore {
    const clock = opts.clock ?? (() => Date.now());
    const settleMs = opts.settleMs ?? 300;
    const keepEnded = opts.keepEnded ?? 50;
    const timers = opts.timers ?? DEFAULT_TIMERS;

    const live = new Map<string, CallSnapshot>();
    const internals = new Map<string, Internal>();
    const ended: CallSnapshot[] = []; // newest first
    const listeners = new Set<(effect: TranscriptEffect) => void>();

    const emit = (effect: TranscriptEffect) => {
        for (const l of listeners) l(effect);
    };

    const inner = (cs: CallSnapshot): Internal => internals.get(cs.id)!;

    // ── Session lifecycle ────────────────────────────────────────────

    function open(agentId: string, call: TranscriptCall, implicit: boolean): CallSnapshot {
        const known = live.get(call.id);
        if (known) return known;
        const channel = toChannel(call.transport);
        const cs: CallSnapshot = {
            id: call.id,
            agent: agentId,
            channel,
            direction: call.direction,
            peer: implicit
                ? call.from || undefined
                : (call.direction === "outbound" ? call.to : call.from) || undefined,
            startedAt: clock(),
            state: "listening",
            lines: [],
            draft: {},
        };
        live.set(cs.id, cs);
        internals.set(cs.id, {
            bot: null, botAnnounced: "", words: 0, settle: null, implicit, lastBot: "",
            applied: new Set(), recentUserText: new Map(),
        });
        emit({ kind: "session.started", agent: agentId, call: cs, implicit });
        emit({ kind: "draft", agent: agentId, call: cs });
        return cs;
    }

    /**
     * The context an event belongs to — opened implicitly when the session never
     * sent call.started / chat.started. Without a call object at all the
     * context is per agent (one implicit session per agent at a time).
     */
    function contextFor(agentId: string, call: TranscriptCall | undefined): CallSnapshot {
        const id = call?.id || `${agentId}:implicit`;
        const known = live.get(id);
        if (known) return known;
        return open(agentId, {
            id,
            from: call?.from,
            to: call?.to,
            direction: call?.direction,
            transport: call?.transport ?? "unknown",
        }, true);
    }

    /** The known context of an event, or the agent's implicit session when the event carries no call. */
    function lookup(agentId: string, call: TranscriptCall | undefined): CallSnapshot | undefined {
        return call ? live.get(call.id) : live.get(`${agentId}:implicit`);
    }

    function close(agentId: string, call: TranscriptCall, reason: string): void {
        const cs = live.get(call.id) ?? live.get(`${agentId}:implicit`);
        if (!cs) return;
        finishBot(cs);
        cs.draft.caller = undefined;
        cs.draft.agent = undefined;
        const secs = call.duration && call.duration > 0 ? call.duration : (clock() - cs.startedAt) / 1000;
        cs.endedAt = clock();
        cs.durationS = secs;
        cs.reason = reason;
        cs.state = "ended";
        live.delete(cs.id);
        clearSettle(cs);
        internals.delete(cs.id);
        ended.unshift(cs);
        while (ended.length > keepEnded) ended.pop();
        emit({ kind: "session.ended", agent: agentId, call: cs, reason, durationS: secs });
    }

    // ── Lines and drafts ─────────────────────────────────────────────

    function callerLine(cs: CallSnapshot, text: string): void {
        cs.lines.push({ who: "caller", text, at: clock(), final: true });
        emit({ kind: "caller.line", agent: cs.agent, call: cs, text });
    }

    function agentLine(cs: CallSnapshot, text: string, cut: boolean): void {
        cs.lines.push({ who: "agent", text, at: clock(), final: true, ...(cut ? { cut: true } : {}) });
        const i = inner(cs);
        i.lastBot = i.lastBot ? `${i.lastBot}\n${text}` : text;
        emit({ kind: "agent.line", agent: cs.agent, call: cs, text, cut });
    }

    function refresh(cs: CallSnapshot): void {
        const i = inner(cs);
        cs.draft.agent = i.bot === null ? undefined : i.bot;
        emit({ kind: "draft", agent: cs.agent, call: cs });
    }

    function setState(cs: CallSnapshot, state: TranscriptState): void {
        cs.state = state;
        refresh(cs);
    }

    /** Close the bot line in flight, if any. */
    function finishBot(cs: CallSnapshot, cut = false): void {
        clearSettle(cs);
        const i = internals.get(cs.id);
        if (!i || i.bot === null) return;
        const text = i.bot || i.botAnnounced;
        if (text) agentLine(cs, text, cut);
        i.bot = null;
        i.botAnnounced = "";
        i.words = 0;
        cs.draft.agent = undefined;
    }

    /** Text reply in flight: fix it once no more chunks (and no words) arrive for `settleMs`. */
    function armSettle(cs: CallSnapshot): void {
        clearSettle(cs);
        const i = inner(cs);
        i.settle = timers.set(() => {
            const cur = internals.get(cs.id);
            if (!cur) return;
            cur.settle = null;
            if (cur.bot === null || cur.words > 0) return;
            finishBot(cs);
            setState(cs, "listening");
        }, settleMs);
    }

    function clearSettle(cs: CallSnapshot): void {
        const i = internals.get(cs.id);
        if (!i) return;
        if (i.settle) timers.clear(i.settle);
        i.settle = null;
    }

    const isTextual = (cs: CallSnapshot) =>
        cs.channel === "chat" || cs.channel === "whatsapp" || cs.channel === "unknown";

    // ── Feed ─────────────────────────────────────────────────────────

    function feed(agentId: string, name: string, args: unknown[]): void {
        const first = args[0] as any;
        const second = args[1] as TranscriptCall | undefined;

        switch (name) {
            case "call.started":
            case "chat.started":
            case "whatsapp.started":
                open(agentId, first as TranscriptCall, false);
                return;

            case "call.ended":
                close(agentId, first as TranscriptCall, (args[1] as string) ?? "");
                return;

            case "call.ringing":
                emit({ kind: "ringing", agent: agentId, from: first?.from, to: first?.to });
                return;

            case "speech.started": {
                const cs = second ? live.get(second.id) : undefined;
                if (cs && cs.state !== "speaking") setState(cs, "listening");
                return;
            }

            case "user.speaking": {
                const cs = second ? live.get(second.id) : undefined;
                if (!cs) return;
                cs.draft.caller = typeof first?.text === "string" ? first.text || undefined : undefined;
                if (cs.state !== "listening") cs.state = "listening";
                refresh(cs);
                return;
            }

            case "user.message": {
                const cs = contextFor(agentId, second);
                const text = typeof first?.text === "string" ? first.text : "";
                const messageId = typeof first?.messageId === "string" ? first.messageId : "";
                if (alreadyApplied(inner(cs), "user.message", messageId, text, clock())) return;
                // A text reply still open (chat / unknown channel): the user replied, so it is done.
                if (isTextual(cs)) finishBot(cs);
                cs.draft.caller = undefined;
                inner(cs).lastBot = "";
                if (text) callerLine(cs, text);
                // Chat has no turn detector — the model starts right away.
                if (isTextual(cs)) setState(cs, "thinking");
                else refresh(cs);
                return;
            }

            case "eager.turn":
            case "turn.end": {
                const cs = second ? live.get(second.id) : undefined;
                if (cs) setState(cs, "thinking");
                return;
            }

            case "turn.pause": {
                const cs = second ? live.get(second.id) : undefined;
                if (cs) setState(cs, "pause");
                return;
            }

            case "turn.resumed":
            case "turn.continued": {
                const cs = second ? live.get(second.id) : undefined;
                if (cs) setState(cs, "listening");
                return;
            }

            case "bot.speaking": {
                const cs = contextFor(agentId, second);
                const i = inner(cs);
                let text = typeof first?.text === "string" ? first.text : "";
                if (isTextual(cs)) {
                    // Chunks stream in; bot.speaking IS the line — fixed once they settle,
                    // unless bot.words arrive and prove this is voice after all.
                    if (i.words > 0) finishBot(cs); // a new utterance after a spoken one
                    if (i.bot === null && i.lastBot) {
                        // The server re-sent the reply already fixed (or the cumulative text
                        // containing it): print nothing, or only what is new.
                        if (i.lastBot.includes(text)) return;
                        if (text.startsWith(i.lastBot)) text = text.slice(i.lastBot.length).replace(/^\s+/, "");
                        if (!text) return;
                    }
                    i.bot = mergeChunk(i.bot ?? "", text);
                    i.words = 0;
                    armSettle(cs);
                } else {
                    // A new utterance: close the previous one (no bot.finished arrived), start empty.
                    if (i.bot !== null && cs.state === "speaking") finishBot(cs);
                    i.bot = "";
                    i.botAnnounced = text;
                }
                setState(cs, "speaking");
                return;
            }

            case "bot.word": {
                const cs = second ? live.get(second.id) : undefined;
                if (!cs) return;
                const i = inner(cs);
                const word = typeof first?.word === "string" ? first.word : "";
                if (i.bot === null) i.bot = "";
                if (i.words === 0 && cs.channel === "unknown" && i.bot) {
                    // Words are playing: the text announced up front is not the line, what is heard is.
                    i.botAnnounced = i.bot;
                    i.bot = "";
                }
                clearSettle(cs);
                i.bot = appendWord(i.bot, word);
                i.words += 1;
                cs.state = "speaking";
                refresh(cs);
                return;
            }

            case "bot.finished": {
                const cs = second ? live.get(second.id) : undefined;
                if (!cs) return;
                const messageId = typeof first?.messageId === "string" ? first.messageId : "";
                if (messageId && alreadyApplied(inner(cs), "bot.finished", messageId, "", clock())) return;
                finishBot(cs);
                setState(cs, "listening");
                return;
            }

            case "bot.interrupted": {
                const cs = second ? live.get(second.id) : undefined;
                if (!cs) return;
                finishBot(cs, true);
                setState(cs, "listening");
                return;
            }

            case "llm.toolCall": {
                const cs = lookup(agentId, second);
                const items: Array<{ name?: string; arguments?: unknown }> =
                    Array.isArray(first?.toolCalls) ? first.toolCalls : [];
                for (const item of items) {
                    const toolName = item.name || "unknown";
                    const toolArgs = parseArgs(item.arguments);
                    if (cs) {
                        cs.lines.push({
                            who: "tool", text: toolName, at: clock(), final: false,
                            tool: { name: toolName, args: toolArgs },
                        });
                    }
                    emit({ kind: "tool.call", agent: agentId, call: cs, name: toolName, args: toolArgs });
                }
                if (cs) setState(cs, "thinking");
                return;
            }

            case "whatsapp.message": {
                const who = String(first?.name || first?.from || "whatsapp");
                const text = typeof first?.text === "string" ? first.text : "";
                if (!text) return;
                // WhatsApp events carry no call: the session (if it announced
                // itself) collects the line, but the renderers draw the wa.*
                // effect — never both.
                waSession(agentId)?.lines.push({ who: "caller", text, at: clock(), final: true });
                emit({ kind: "wa.message", agent: agentId, who, text });
                return;
            }

            case "whatsapp.response": {
                const text = typeof first?.text === "string" ? first.text : "";
                if (!text) return;
                waSession(agentId)?.lines.push({ who: "agent", text, at: clock(), final: true });
                emit({ kind: "wa.response", agent: agentId, text, source: first?.source });
                return;
            }

            default:
                return;
        }
    }

    /** The agent's open WhatsApp session, if it announced itself — WA events carry no call. */
    function waSession(agentId: string): CallSnapshot | undefined {
        for (const cs of live.values()) {
            if (cs.agent === agentId && cs.channel === "whatsapp") return cs;
        }
        return undefined;
    }

    function toolResult(agentId: string, call: TranscriptCall | undefined, result: unknown): void {
        const cs = lookup(agentId, call);
        let name: string | undefined;
        if (cs) {
            // Attach to the newest tool line still waiting for its result.
            for (let i = cs.lines.length - 1; i >= 0; i--) {
                const line = cs.lines[i]!;
                if (line.who === "tool" && !line.final) {
                    line.final = true;
                    line.tool = { ...line.tool!, result };
                    name = line.tool.name;
                    break;
                }
            }
        }
        emit({ kind: "tool.result", agent: agentId, call: cs, ...(name ? { name } : {}), result });
    }

    const subs = new Map<string, Array<[string, (...a: any[]) => void]>>();

    function attach(agent: TranscriptEmitter): () => void {
        if (subs.has(agent.id)) return () => detachAgent(agent);
        const mine: Array<[string, (...a: any[]) => void]> = [];
        for (const name of TRANSCRIPT_EVENTS) {
            const handler = (...args: any[]) => feed(agent.id, name, args);
            mine.push([name, handler]);
            agent.on(name, handler);
        }
        subs.set(agent.id, mine);
        return () => detachAgent(agent);
    }

    function detachAgent(agent: TranscriptEmitter): void {
        const mine = subs.get(agent.id);
        if (mine) {
            for (const [name, handler] of mine) agent.off(name, handler);
            subs.delete(agent.id);
        }
        detach(agent.id);
    }

    function detach(agentId: string): void {
        for (const cs of [...live.values()]) {
            if (cs.agent !== agentId) continue;
            clearSettle(cs);
        }
    }

    function dispose(): void {
        for (const cs of live.values()) clearSettle(cs);
        listeners.clear();
    }

    function snapshots(): CallSnapshot[] {
        const open = [...live.values()].sort((a, b) => b.startedAt - a.startedAt);
        return [...open, ...ended];
    }

    return {
        attach,
        feed,
        toolResult,
        detach,
        on(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        live,
        snapshots,
        get: (id) => live.get(id) ?? ended.find((c) => c.id === id),
        dispose,
    };
}

// ── Pure helpers (shared with the renderers) ─────────────────────────────

/** Map the SDK's transport to the console's channel vocabulary. */
export function toChannel(transport: string | undefined): TranscriptChannel {
    switch (transport) {
        case "phone":
        case "webrtc":
        case "chat":
        case "whatsapp":
            return transport;
        default:
            return "unknown";
    }
}

/** Merge a streamed chunk: servers send deltas (append) or the growing text so far (replace). */
export function mergeChunk(cur: string, text: string): string {
    if (!cur) return text;
    if (text.startsWith(cur)) return text;
    return cur + text;
}

/** Append a spoken word with single-space joining. */
export function appendWord(line: string, word: string): string {
    const w = word.trim();
    if (!w) return line;
    return line ? `${line} ${w}` : w;
}

/** Tool arguments arrive as a JSON string on the wire; older shapes may already be objects. */
export function parseArgs(args: unknown): unknown {
    if (typeof args !== "string") return args ?? {};
    if (!args.trim()) return {};
    try {
        return JSON.parse(args);
    } catch {
        return args;
    }
}

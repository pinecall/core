/**
 * Transcript reducer — the event → calls model of the web console.
 *
 * ONE semantics, three renderers: the terminal live view (src/cli/live-view.ts),
 * the runner's in-process CallsModel and this browser app all turn the SAME
 * agent events into the SAME transcript. This module is the browser half: a
 * pure, dependency-free TypeScript module (no React, no DOM, no timers) so the
 * runner's `src/cli/console/transcript-reducer.ts` can replace it verbatim once
 * both land — nothing here imports anything.
 *
 * The semantics, copied from the live view:
 *   · `user.speaking` is INTERIM caller text — it replaces itself and is
 *     replaced by the final `user.message`.
 *   · on voice the agent's line is what has been HEARD: `bot.speaking` may
 *     carry the whole reply up front, but the line grows word by word on
 *     `bot.word` and is fixed on `bot.finished` — or marked cut (`⏏`) on
 *     `bot.interrupted`.
 *   · chat / WhatsApp have no audio and no words, so there `bot.speaking` IS
 *     the line: chunks are merged (delta or cumulative) as they stream and the
 *     line is fixed once they settle — `settle()` below, called by the UI on a
 *     timer, keeps the reducer itself free of clocks.
 *   · tool calls render inline (`⚡ name(args)` → `✓ result`).
 *   · a session that never announced itself (`pinecall chat`, the MCP chat
 *     tool, any llm.chat client) gets an implicit call on its first event.
 *
 * Events arrive over SSE already flattened by src/stream/event-data.ts:
 *   `{ agent, callId?, from?, to?, direction?, transport?, duration?, reason?, ...payload }`
 */

// ── The contract shape (frozen with the runner's console server) ─────────

export type CallChannel = "phone" | "webrtc" | "chat" | "whatsapp";
export type CallState = "ringing" | "listening" | "thinking" | "speaking" | "ended";

export interface ToolLine {
    name: string;
    args?: unknown;
    result?: unknown;
}

export interface Line {
    who: "caller" | "agent" | "tool";
    text: string;
    /** ms since epoch. */
    at: number;
    final: boolean;
    /** The agent was interrupted mid-line (`⏏`). */
    cut?: boolean;
    tool?: ToolLine;
}

export interface CallSnapshot {
    id: string;
    agent: string;
    channel: CallChannel;
    direction?: string;
    peer?: string;
    startedAt: number;
    endedAt?: number;
    durationS?: number;
    reason?: string;
    state: CallState;
    lines: Line[];
    /** What is being said right now — replaced, not appended. */
    draft: { caller?: string; agent?: string };
}

/** One SSE frame. */
export interface ConsoleEvent {
    name: string;
    data: Record<string, unknown>;
    /** Arrival time (ms). Defaults to Date.now() at the call site. */
    at: number;
}

/** Per-call bookkeeping the snapshot itself does not carry. */
interface Live {
    /** Text announced up front by `bot.speaking` — the fallback when no words play. */
    announced: string;
    /** `bot.word` count of the utterance in flight: >0 proves this is voice. */
    words: number;
    /** When the last chat chunk arrived — `settle()` fixes the line after it. */
    lastChunkAt: number;
    /** Everything the agent said this turn: a re-sent bot.speaking must not double it. */
    lastBot: string;
    /** Opened without a call.started / chat.started. */
    implicit: boolean;
    /** `event:messageId` pairs already applied — a re-sent SSE frame must never produce a second bubble. */
    applied: Set<string>;
    /** `text -> ts` for messageId-less `user.message` (chat) — dedupes a re-sent frame within 2s. */
    recentUserText: Map<string, number>;
}

/**
 * True (and records it) when (event, messageId) was already applied for this
 * call — belt-and-braces against a duplicated SSE frame. A messageId-less
 * `user.message` (chat has none) falls back to callId+text within 2s.
 */
function alreadyApplied(l: Live, event: string, messageId: string, text: string, now: number): boolean {
    if (messageId) {
        const key = `${event}:${messageId}`;
        if (l.applied.has(key)) return true;
        l.applied.add(key);
        return false;
    }
    if (event !== "user.message") return false;
    const last = l.recentUserText.get(text);
    if (last !== undefined && now - last < 2000) return true;
    l.recentUserText.set(text, now);
    return false;
}

export interface ConsoleState {
    /** Newest first; live calls sort ahead of ended ones in the UI, not here. */
    calls: CallSnapshot[];
    /** @internal per-call scratch, keyed by call id. */
    live: Record<string, Live>;
}

export const initialState: ConsoleState = { calls: [], live: {} };

/** Seed from `console.hello` / `GET /api/calls` — snapshots replace everything. */
export function seed(calls: CallSnapshot[]): ConsoleState {
    const live: Record<string, Live> = {};
    for (const c of calls) live[c.id] = freshLive();
    return { calls: calls.map(normalize), live };
}

const freshLive = (): Live => ({
    announced: "", words: 0, lastChunkAt: 0, lastBot: "", implicit: false,
    applied: new Set(), recentUserText: new Map(),
});

const normalize = (c: CallSnapshot): CallSnapshot => ({ ...c, lines: c.lines ?? [], draft: c.draft ?? {} });

// ── The reducer ──────────────────────────────────────────────────────────

/** Apply one event. Always returns a new state when something changed. */
export function apply(state: ConsoleState, event: ConsoleEvent): ConsoleState {
    const { name, data, at } = event;
    const agent = str(data.agent) || "agent";
    const id = str(data.callId) || `${agent}:implicit`;

    switch (name) {
        // Frames that are not call events.
        case "connected":
        case "console.hello":
            return state;

        case "call.ringing": {
            const peer = str(data.from) || str(data.to);
            return upsert(state, id, agent, data, at, (c) => ({ ...c, state: "ringing", peer: c.peer || peer }));
        }

        case "call.started":
        case "chat.started":
        case "whatsapp.started": {
            // A ringing call is already on the list — it is answered, not reopened.
            const next = open(state, id, agent, data, at, false);
            const peer = (str(data.direction) === "outbound" ? str(data.to) : str(data.from)) || undefined;
            return patch(next, id, (c) => ({
                ...c,
                state: "listening",
                channel: str(data.transport) ? channelOf(str(data.transport), false) : c.channel,
                direction: str(data.direction) || c.direction,
                peer: peer || c.peer,
            }));
        }

        case "call.ended": {
            const found = find(state, id);
            if (!found) return state;
            let next = finishAgentLine(state, id, at, false);
            const started = find(next, id)!.startedAt;
            const secs = num(data.duration) ?? (at - started) / 1000;
            return patch(next, id, (c) => ({
                ...c,
                state: "ended",
                endedAt: at,
                durationS: Math.round(secs * 10) / 10,
                reason: str(data.reason) || c.reason,
                draft: {},
            }));
        }

        case "speech.started":
            return known(state, id) ? patch(state, id, (c) => (c.state === "speaking" ? c : { ...c, state: "listening" })) : state;

        case "user.speaking": {
            if (!known(state, id)) return state; // interims never open a session
            const text = str(data.text);
            return patch(state, id, (c) => ({ ...c, state: "listening", draft: { ...c.draft, caller: text } }));
        }

        case "user.message": {
            let next = open(state, id, agent, data, at, true);
            const text = str(data.text);
            const messageId = str(data.messageId);
            const l = next.live[id];
            if (l && alreadyApplied(l, "user.message", messageId, text, at)) return next;
            const call = find(next, id)!;
            // A text reply still in flight: the user replied, so it is done.
            if (isTextual(call)) next = finishAgentLine(next, id, at, false);
            next = patch(next, id, (c) => ({
                ...c,
                lines: text ? [...c.lines, { who: "caller", text, at, final: true }] : c.lines,
                draft: { ...c.draft, caller: undefined },
                // Chat has no turn detector — the model starts right away.
                state: isTextual(c) ? "thinking" : c.state,
            }));
            return withLive(next, id, (l) => ({ ...l, lastBot: "" }));
        }

        case "eager.turn":
        case "turn.end":
            return known(state, id) ? patch(state, id, (c) => ({ ...c, state: "thinking" })) : state;

        // A paused turn is the agent still waiting on the caller.
        case "turn.pause":
        case "turn.resumed":
        case "turn.continued":
            return known(state, id) ? patch(state, id, (c) => ({ ...c, state: "listening" })) : state;

        case "bot.speaking": {
            let next = open(state, id, agent, data, at, true);
            const call = find(next, id)!;
            let text = str(data.text);
            if (isTextual(call)) {
                const l = next.live[id];
                // A new utterance after a spoken one closes the previous line.
                if (l.words > 0) next = finishAgentLine(next, id, at, false);
                const cur = find(next, id)!.draft.agent;
                const last = next.live[id].lastBot;
                if (cur === undefined && last) {
                    // The server re-sent a reply already fixed (or the cumulative
                    // text containing it): print nothing, or only what is new.
                    if (last.includes(text)) return next;
                    if (text.startsWith(last)) text = text.slice(last.length).replace(/^\s+/, "");
                    if (!text) return next;
                }
                const merged = mergeChunk(cur ?? "", text);
                next = patch(next, id, (c) => ({ ...c, state: "speaking", draft: { ...c.draft, agent: merged } }));
                return withLive(next, id, (li) => ({ ...li, words: 0, lastChunkAt: at }));
            }
            // Voice: close the utterance in flight (no bot.finished arrived) and
            // start empty — what is heard is the line, not what was announced.
            if (find(next, id)!.draft.agent !== undefined && find(next, id)!.state === "speaking") {
                next = finishAgentLine(next, id, at, false);
            }
            next = patch(next, id, (c) => ({ ...c, state: "speaking", draft: { ...c.draft, agent: "" } }));
            return withLive(next, id, (li) => ({ ...li, announced: text, words: 0 }));
        }

        case "bot.word": {
            if (!known(state, id)) return state;
            const word = str(data.word).trim();
            const l = state.live[id];
            const call = find(state, id)!;
            let line = call.draft.agent ?? "";
            let announced = l.announced;
            if (l.words === 0 && call.channel === "phone" && line && !announced) {
                // Words are playing after a text-looking start: what was announced
                // is not the line — what is heard is.
                announced = line;
                line = "";
            }
            const grown = word ? (line ? `${line} ${word}` : word) : line;
            const next = patch(state, id, (c) => ({ ...c, state: "speaking", draft: { ...c.draft, agent: grown } }));
            return withLive(next, id, (li) => ({ ...li, announced, words: li.words + 1 }));
        }

        case "bot.finished": {
            if (!known(state, id)) return state;
            const l = state.live[id];
            const messageId = str(data.messageId);
            if (l && messageId && alreadyApplied(l, "bot.finished", messageId, "", at)) return state;
            return patch(finishAgentLine(state, id, at, false), id, (c) => ({ ...c, state: "listening" }));
        }

        case "bot.interrupted":
            if (!known(state, id)) return state;
            return patch(finishAgentLine(state, id, at, true), id, (c) => ({ ...c, state: "listening" }));

        case "llm.toolCall": {
            if (!known(state, id)) return state;
            const calls = Array.isArray(data.toolCalls) ? (data.toolCalls as Array<Record<string, unknown>>) : [];
            if (!calls.length) return state;
            const lines: Line[] = calls.map((t) => ({
                who: "tool" as const,
                text: str(t.name) || "unknown",
                at,
                final: false,
                tool: { name: str(t.name) || "unknown", args: parseArgs(t.arguments) },
            }));
            return patch(state, id, (c) => ({ ...c, state: "thinking", lines: [...c.lines, ...lines] }));
        }

        // The runner reports a tool's return value through the same wrapper the
        // terminal view uses; it lands on the pending ⚡ line.
        case "llm.toolResult":
        case "tool.result": {
            if (!known(state, id)) return state;
            const name = str(data.name);
            return patch(state, id, (c) => {
                const i = lastIndex(c.lines, (l) => l.who === "tool" && !l.final && (!name || l.tool?.name === name));
                if (i < 0) return c;
                const lines = c.lines.slice();
                lines[i] = { ...lines[i], final: true, tool: { ...lines[i].tool!, result: data.result } };
                return { ...c, lines };
            });
        }

        // WhatsApp speaks in whole messages — no interims, no words.
        case "whatsapp.message": {
            const next = open(state, id, agent, { ...data, transport: "whatsapp" }, at, true);
            const text = str(data.text);
            return text ? patch(next, id, (c) => ({ ...c, lines: [...c.lines, { who: "caller", text, at, final: true }] })) : next;
        }

        case "whatsapp.response": {
            const next = open(state, id, agent, { ...data, transport: "whatsapp" }, at, true);
            const text = str(data.text);
            return text ? patch(next, id, (c) => ({ ...c, lines: [...c.lines, { who: "agent", text, at, final: true }] })) : next;
        }

        default:
            return state;
    }
}

/**
 * Fix text replies whose chunks have stopped arriving.
 *
 * Chat and WhatsApp have no `bot.finished`: the line is done when nothing more
 * came for `settleMs`. The UI calls this from an interval so the reducer keeps
 * no timers of its own; it is a no-op when nothing is pending.
 */
export function settle(state: ConsoleState, now: number, settleMs = 300): ConsoleState {
    let next = state;
    for (const call of state.calls) {
        const l = next.live[call.id];
        const c = find(next, call.id)!;
        if (!l || c.state === "ended" || c.draft.agent === undefined) continue;
        if (!isTextual(c) || l.words > 0 || now - l.lastChunkAt < settleMs) continue;
        next = patch(finishAgentLine(next, call.id, now, false), call.id, (x) => ({ ...x, state: "listening" }));
    }
    return next;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Open a call if it is not known yet. `implicit` = nobody announced it. */
function open(state: ConsoleState, id: string, agent: string, data: Record<string, unknown>, at: number, implicit: boolean): ConsoleState {
    if (known(state, id)) return state;
    const direction = str(data.direction) || undefined;
    const peer = (direction === "outbound" ? str(data.to) : str(data.from)) || str(data.from) || str(data.to) || undefined;
    const call: CallSnapshot = {
        id,
        agent,
        channel: channelOf(str(data.transport), implicit),
        direction,
        peer,
        startedAt: at,
        state: "listening",
        lines: [],
        draft: {},
    };
    return {
        calls: [call, ...state.calls],
        live: { ...state.live, [id]: { ...freshLive(), implicit } },
    };
}

/** Open-if-needed, then patch — used by events that also carry call fields. */
function upsert(
    state: ConsoleState,
    id: string,
    agent: string,
    data: Record<string, unknown>,
    at: number,
    fn: (c: CallSnapshot) => CallSnapshot,
): ConsoleState {
    return patch(open(state, id, agent, data, at, false), id, fn);
}

function patch(state: ConsoleState, id: string, fn: (c: CallSnapshot) => CallSnapshot): ConsoleState {
    const i = state.calls.findIndex((c) => c.id === id);
    if (i < 0) return state;
    const updated = fn(state.calls[i]);
    if (updated === state.calls[i]) return state;
    const calls = state.calls.slice();
    calls[i] = updated;
    return { ...state, calls };
}

function withLive(state: ConsoleState, id: string, fn: (l: Live) => Live): ConsoleState {
    const cur = state.live[id];
    if (!cur) return state;
    return { ...state, live: { ...state.live, [id]: fn(cur) } };
}

/** Close the agent line in flight, if any. */
function finishAgentLine(state: ConsoleState, id: string, at: number, cut: boolean): ConsoleState {
    const call = find(state, id);
    const l = state.live[id];
    if (!call || !l || call.draft.agent === undefined) return state;
    const text = call.draft.agent || l.announced;
    const next = patch(state, id, (c) => ({
        ...c,
        lines: text ? [...c.lines, { who: "agent", text, at, final: true, ...(cut ? { cut: true } : {}) }] : c.lines,
        draft: { ...c.draft, agent: undefined },
    }));
    return withLive(next, id, (li) => ({
        ...li,
        announced: "",
        words: 0,
        lastBot: text ? (li.lastBot ? `${li.lastBot}\n${text}` : text) : li.lastBot,
    }));
}

const find = (state: ConsoleState, id: string) => state.calls.find((c) => c.id === id);
const known = (state: ConsoleState, id: string) => state.calls.some((c) => c.id === id);

/** No audio for sure — there `bot.speaking` is the line. */
export const isTextual = (c: CallSnapshot) => c.channel === "chat" || c.channel === "whatsapp";

function channelOf(transport: string, implicit: boolean): CallChannel {
    if (transport === "webrtc") return "webrtc";
    if (transport === "chat") return "chat";
    if (transport === "whatsapp") return "whatsapp";
    if (transport) return "phone";
    // Nobody said what this is: an announced call is a phone call, a session
    // that opened itself on a text event is chat.
    return implicit ? "chat" : "phone";
}

/** Servers stream deltas (append) or the growing text so far (replace). */
function mergeChunk(cur: string, text: string): string {
    if (!cur) return text;
    if (text.startsWith(cur)) return text;
    return cur + text;
}

/** Tool arguments arrive as a JSON string on the wire. */
function parseArgs(args: unknown): unknown {
    if (typeof args !== "string") return args ?? {};
    if (!args.trim()) return {};
    try {
        return JSON.parse(args);
    } catch {
        return args;
    }
}

function lastIndex<T>(arr: T[], fn: (v: T) => boolean): number {
    for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) return i;
    return -1;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && v > 0 ? v : undefined);

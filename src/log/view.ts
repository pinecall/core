/**
 * CallLogView — THE reducer (CALL_LOG_SPEC.md §6).
 *
 * "Client SDKs maintain ONE reducer (log → {phase, messages, toolCalls,
 * turns, metrics}) fed by any pipe, deduped by seq."
 *
 * This is the whole point of the module: WS attach, WebRTC DataChannel, GET
 * polling and replay are four pipes carrying one envelope, and they must
 * land on one piece of state-building code. A second reducer would be a
 * second vocabulary in disguise.
 *
 * ── Semantics ────────────────────────────────────────────────────────────
 * Ported from the proven `VoiceSession.handleDataChannelMessage` switch
 * (@pinecall/web, src/core/VoiceSession.ts:303-502) — word reassembly,
 * `mergeUserTurn` interim merging, tool-argument parsing — with four
 * deliberate corrections:
 *
 *   1. NO transport coupling and no `trackedTools` filter. The view exposes
 *      every tool call; a UI that wants a subset filters at render time.
 *      Filtering during reduction makes the state depend on widget config.
 *   2. NO `disconnect()` back-edge. VoiceSession called `this.disconnect()`
 *      from inside the switch (:418) — a reducer reaching into a socket.
 *      Here, terminal facts produce an *intent* on the state; the owner of
 *      the transport decides what to do about it.
 *   3. Duration is derived from entry `ts`, never from wall clock, so a
 *      replay of a finished call reproduces the same state as watching it
 *      live (§10.5).
 *   4. `phase` gains "ended", and `bot.corrected` REPLACES the text of the
 *      entry it supersedes (§2) rather than appending a second bubble.
 *
 * ── Idempotence and order independence ───────────────────────────────────
 * `apply()` is idempotent by `seq` and independent of arrival order. It is
 * not a naive running fold: entries are retained in a seq-keyed map and the
 * state is the fold over them in seq order. Applying an entry newer than
 * everything seen (the live case) folds incrementally in O(1); an
 * out-of-order or backfilled entry rebuilds, which is what correctness
 * costs and what makes in-order === shuffled === resumed.
 */

import type {
    AnyLogEntry,
    CallSummaryData,
    KnownLogEntry,
    TurnLatency,
    TurnRole,
    WordTiming,
} from "./types.js";
import { isKnownLogEntry, isLogEntry } from "./types.js";

// ── State ────────────────────────────────────────────────────────────────

export type CallPhase =
    | "idle"
    | "ringing"
    | "listening"
    | "thinking"
    | "speaking"
    | "ended";

export type MessageRole = "user" | "bot" | "system";

/** One transcript bubble. `seq` is the entry that created it — `bot.corrected.supersedes` points here. */
export interface CallMessage {
    /** The seq of the entry that created this message. Stable identity. */
    seq: number;
    role: MessageRole;
    text: string;
    /** Provider message id (`user.message.id`, `bot.speaking.id`, …). */
    id?: string;
    /** True while a non-final `user.message` is the latest word on this turn. */
    interim?: boolean;
    /** True between `bot.speaking` and `bot.finished`/`bot.interrupted`. */
    speaking?: boolean;
    interrupted?: boolean;
    /** Set on the system bubble that mirrors a `tool.call`. */
    toolCallId?: string;
    /** Word alignment when TTS provided it (`bot.speaking.words`). */
    words?: WordTiming[];
    /** True once a `bot.corrected` entry replaced this text. */
    corrected?: boolean;
}

export interface CallToolCall {
    id: string;
    name: string;
    args: Record<string, unknown>;
    /** seq of the `tool.call` entry. */
    seq: number;
    /** Present once the correlated `tool.result` arrives. */
    result?: unknown;
    ms?: number;
    error?: string;
    done: boolean;
}

export interface CallTurn {
    turn: number;
    role?: TurnRole;
    latency?: TurnLatency;
    startedAt?: number;
    endedAt?: number;
}

export interface CallMetrics {
    /** Rolled-up distributions, present once `call.summary` lands. */
    summary?: CallSummaryData["metrics"];
    cost?: number;
    recordingUrl?: string;
    /** Mean end-to-end latency over the `turn.end` entries seen so far. */
    e2eMean?: number;
    turnCount: number;
}

/**
 * Something the log says should happen to the transport, surfaced instead of
 * done. Correction #2 above: the reducer never touches a socket.
 */
export interface CallIntent {
    kind: "disconnect";
    reason: string;
    seq: number;
}

export interface CallLogState {
    phase: CallPhase;
    messages: CallMessage[];
    toolCalls: CallToolCall[];
    turns: CallTurn[];
    metrics: CallMetrics;
    /** False once `call.ended` is applied. */
    live: boolean;
    /** Highest seq applied. The cursor to resume from (`after=`). */
    lastSeq: number;
    /** Call id, from the first entry that carried one. */
    call: string | null;
    agent: string | null;
    /** Seconds, derived from entry `ts` — never from wall clock. */
    duration: number;
    /** True after `log.caught_up`; never inferred from contiguity (§1). */
    caughtUp: boolean;
    /** Declared gaps (§3). Never silently papered over. */
    gaps: { from: number; resumeFrom: number }[];
    userSpeaking: boolean;
    botSpeaking: boolean;
    /** Reason from `call.ended`, if any. */
    endedReason?: string;
    /** Human takeover state (`handoff.*`). */
    handoff: "none" | "requested" | "active";
    /** Skills currently loaded (`skill.loaded` / `skill.unloaded`). */
    skills: string[];
    /** Latest RAG citations (`docs.sources`). */
    sources: unknown[];
    /** Things the log asked the transport to do (§ correction #2). */
    intents: CallIntent[];
}

function emptyState(): CallLogState {
    return {
        phase: "idle",
        messages: [],
        toolCalls: [],
        turns: [],
        metrics: { turnCount: 0 },
        live: true,
        lastSeq: 0,
        call: null,
        agent: null,
        duration: 0,
        caughtUp: false,
        gaps: [],
        userSpeaking: false,
        botSpeaking: false,
        handoff: "none",
        skills: [],
        sources: [],
        intents: [],
    };
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Merge a user transcript into the CURRENT turn's user bubble — the last
 * user message with no bot reply after it — instead of appending a new one.
 * STT emits several interim AND several final transcripts per turn (Deepgram
 * Flux fires multiple finals), so appending per event duplicates the bubble.
 * A new turn starts only after a bot reply. Ported verbatim in spirit from
 * VoiceSession.ts:38-50.
 */
function mergeUserTurn(
    messages: CallMessage[],
    seq: number,
    id: string,
    text: string,
    interim: boolean,
): void {
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.role === "user") { lastUser = i; break; }
    }
    let botAfter = false;
    for (let i = lastUser + 1; i < messages.length; i++) {
        if (messages[i]!.role === "bot") { botAfter = true; break; }
    }
    if (lastUser >= 0 && !botAfter) {
        const m = messages[lastUser]!;
        m.text = text;
        m.interim = interim;
        m.id = id;
        return;
    }
    messages.push({ seq, role: "user", text, id, interim });
}

/** Tool args arrive parsed or as a JSON string, depending on the provider. */
function parseArgs(args: Record<string, unknown> | string): Record<string, unknown> {
    if (typeof args !== "string") return args ?? {};
    try {
        const parsed: unknown = JSON.parse(args);
        return typeof parsed === "object" && parsed !== null
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

/** A `tool.result` may carry a JSON string; surface the parsed value. */
function parseResult(result: unknown): unknown {
    if (typeof result !== "string") return result;
    try {
        return JSON.parse(result);
    } catch {
        return result;
    }
}

// ── The reducer ──────────────────────────────────────────────────────────

/** Mutable scratch carried across the fold — never part of the public state. */
interface FoldContext {
    /** Live word buffers keyed by bot message id (`bot.word` reassembly). */
    botWords: Map<string, string[]>;
    /** bot message id → index in `messages`. */
    botIndex: Map<string, number>;
    /** tool call id → index in `toolCalls`. */
    toolIndex: Map<string, number>;
    /** turn number → index in `turns`. */
    turnIndex: Map<number, number>;
    /** message seq → index in `messages` (for `bot.corrected.supersedes`). */
    bySeq: Map<number, number>;
    /** ts of the first entry / of `call.started`. */
    startTs: number | null;
    lastTs: number | null;
    e2eSum: number;
    e2eN: number;
}

function emptyContext(): FoldContext {
    return {
        botWords: new Map(),
        botIndex: new Map(),
        toolIndex: new Map(),
        turnIndex: new Map(),
        bySeq: new Map(),
        startTs: null,
        lastTs: null,
        e2eSum: 0,
        e2eN: 0,
    };
}

/**
 * A single log view. Feed it entries from any pipe, in any order, as many
 * times as you like; read `state`.
 */
export class CallLogView {
    #entries = new Map<number, KnownLogEntry>();
    #state: CallLogState = emptyState();
    #ctx: FoldContext = emptyContext();
    #maxSeq = -1;
    #listeners = new Set<(state: CallLogState) => void>();

    /**
     * How many entries to retain for out-of-order rebuilds. The retained
     * window bounds memory on a long call; entries older than the window are
     * still reflected in the state, they just cannot be re-folded. Default
     * 10_000 (the hot buffer is 1000, so this is generous by 10x).
     */
    constructor(private readonly retain = 10_000) {}

    /** Read-only snapshot. Reference changes on every state-affecting apply. */
    get state(): Readonly<CallLogState> {
        return this.#state;
    }

    /** The cursor to resume from: `?after=<lastSeq>`. */
    get lastSeq(): number {
        return this.#state.lastSeq;
    }

    /** Subscribe to state changes. Returns an unsubscribe function. */
    subscribe(fn: (state: CallLogState) => void): () => void {
        this.#listeners.add(fn);
        return () => { this.#listeners.delete(fn); };
    }

    /** The entries this view retains, in seq order — the resume payload. */
    entries(): KnownLogEntry[] {
        return [...this.#entries.keys()].sort((a, b) => a - b).map((s) => this.#entries.get(s)!);
    }

    /** True if this exact seq has already been applied. */
    has(seq: number): boolean {
        return this.#entries.has(seq);
    }

    /**
     * Apply one entry. Idempotent by `seq`, order-independent.
     * Returns true if the view changed.
     */
    apply(entry: AnyLogEntry): boolean {
        if (!isLogEntry(entry)) return false;
        // §1: unknown types MUST be ignored, not rejected.
        if (!isKnownLogEntry(entry)) return false;
        // §1: consumers MUST dedupe by seq — transports overlap.
        if (this.#entries.has(entry.seq)) return false;

        this.#entries.set(entry.seq, entry);

        if (entry.seq > this.#maxSeq) {
            // Live path: strictly newer than anything seen — fold forward.
            this.#maxSeq = entry.seq;
            // New top-level and array references so snapshot consumers
            // (useSyncExternalStore and friends) see a change.
            this.#state = {
                ...this.#state,
                messages: [...this.#state.messages],
                toolCalls: [...this.#state.toolCalls],
                turns: [...this.#state.turns],
            };
            this.#step(this.#state, this.#ctx, entry);
            this.#finish(this.#state, this.#ctx);
            this.#trim();
        } else {
            // Backfill / out-of-order: the fold must run in seq order.
            this.#trim();
            this.#rebuild();
        }

        for (const fn of this.#listeners) fn(this.#state);
        return true;
    }

    /** Apply many. Returns how many changed the view. */
    applyAll(entries: readonly AnyLogEntry[]): number {
        let n = 0;
        for (const e of entries) if (this.apply(e)) n++;
        return n;
    }

    /** Drop everything and start over. */
    reset(): void {
        this.#entries.clear();
        this.#state = emptyState();
        this.#ctx = emptyContext();
        this.#maxSeq = -1;
        for (const fn of this.#listeners) fn(this.#state);
    }

    // ── Internals ──

    #trim(): void {
        if (this.#entries.size <= this.retain) return;
        const keys = [...this.#entries.keys()].sort((a, b) => a - b);
        const drop = keys.length - this.retain;
        for (let i = 0; i < drop; i++) this.#entries.delete(keys[i]!);
    }

    #rebuild(): void {
        const state = emptyState();
        const ctx = emptyContext();
        for (const entry of this.entries()) this.#step(state, ctx, entry);
        this.#finish(state, ctx);
        this.#state = state;
        this.#ctx = ctx;
    }

    #finish(state: CallLogState, ctx: FoldContext): void {
        // Correction #3: duration comes from entry ts, never wall clock.
        state.duration =
            ctx.startTs !== null && ctx.lastTs !== null
                ? Math.max(0, ctx.lastTs - ctx.startTs)
                : 0;
        state.metrics = {
            ...state.metrics,
            turnCount: state.turns.length,
            ...(ctx.e2eN > 0 ? { e2eMean: ctx.e2eSum / ctx.e2eN } : {}),
        };
    }

    /**
     * Fold one entry into `state`. Exhaustive over the closed vocabulary —
     * the `never` in the default arm is the compile-time guarantee that a
     * new §2 type cannot be added without teaching the reducer about it.
     */
    #step(state: CallLogState, ctx: FoldContext, entry: KnownLogEntry): void {
        state.lastSeq = Math.max(state.lastSeq, entry.seq);
        if (entry.call && !state.call) state.call = entry.call;
        if (entry.agent && !state.agent) state.agent = entry.agent;
        if (ctx.startTs === null) ctx.startTs = entry.ts;
        ctx.lastTs = ctx.lastTs === null ? entry.ts : Math.max(ctx.lastTs, entry.ts);

        const messages = state.messages;

        switch (entry.type) {
            // ── Lifecycle ──
            case "call.ringing":
                state.phase = "ringing";
                break;

            case "call.started":
                ctx.startTs = entry.ts;
                state.phase = "listening";
                state.live = true;
                break;

            case "call.ended":
                state.phase = "ended";
                state.live = false;
                state.userSpeaking = false;
                state.botSpeaking = false;
                state.endedReason = entry.data.reason;
                // Correction #2: surface the intent, never call disconnect().
                state.intents = [
                    ...state.intents,
                    { kind: "disconnect", reason: entry.data.reason, seq: entry.seq },
                ];
                break;

            case "call.summary":
                state.metrics = {
                    ...state.metrics,
                    summary: entry.data.metrics,
                    ...(entry.data.cost !== undefined ? { cost: entry.data.cost } : {}),
                    ...(entry.data.recording_url
                        ? { recordingUrl: entry.data.recording_url }
                        : {}),
                };
                state.live = false;
                if (state.phase !== "ended") state.phase = "ended";
                break;

            // ── Speech & transcript ──
            case "user.speaking":
                state.userSpeaking = entry.data.active;
                if (entry.data.active && state.phase !== "ended") state.phase = "listening";
                break;

            case "user.message": {
                if (entry.data.text) {
                    mergeUserTurn(
                        messages,
                        entry.seq,
                        entry.data.id,
                        entry.data.text,
                        !entry.data.final,
                    );
                    this.#reindex(ctx, messages);
                }
                if (entry.data.final) {
                    state.userSpeaking = false;
                    if (state.phase !== "ended") state.phase = "thinking";
                }
                break;
            }

            case "bot.speaking": {
                const id = entry.data.id;
                ctx.botWords.set(id, []);
                const idx = ctx.botIndex.get(id);
                const words = entry.data.words;
                if (idx === undefined) {
                    messages.push({
                        seq: entry.seq,
                        role: "bot",
                        text: entry.data.text ?? "",
                        id,
                        speaking: true,
                        ...(words ? { words } : {}),
                    });
                    this.#reindex(ctx, messages);
                } else {
                    const m = messages[idx]!;
                    if (entry.data.text) m.text = entry.data.text;
                    if (words) m.words = words;
                    m.speaking = true;
                }
                state.botSpeaking = true;
                if (state.phase !== "ended") state.phase = "speaking";
                break;
            }

            case "bot.word": {
                // Ephemeral typing effect. §2's bot.word carries no index, so
                // reassembly is append-in-seq-order — deterministic because the
                // fold always runs in seq order.
                const id = entry.data.id;
                let buf = ctx.botWords.get(id);
                if (!buf) { buf = []; ctx.botWords.set(id, buf); }
                buf.push(entry.data.w);
                const text = buf.join(" ");
                const idx = ctx.botIndex.get(id);
                if (idx === undefined) {
                    messages.push({ seq: entry.seq, role: "bot", text, id, speaking: true });
                    this.#reindex(ctx, messages);
                } else {
                    // Never clobber an authoritative bot.speaking.text with a
                    // partial word buffer.
                    const m = messages[idx]!;
                    if (!m.corrected && buf.length > 0 && m.text.length <= text.length) {
                        m.text = text;
                    }
                    m.speaking = true;
                }
                state.botSpeaking = true;
                if (state.phase !== "ended") state.phase = "speaking";
                break;
            }

            case "bot.finished": {
                const idx = ctx.botIndex.get(entry.data.id);
                if (idx !== undefined) {
                    const m = messages[idx]!;
                    m.speaking = false;
                    // The LLM went straight to a tool call: drop the phantom bubble.
                    if (!m.text) {
                        messages.splice(idx, 1);
                        this.#reindex(ctx, messages);
                    }
                }
                state.botSpeaking = false;
                if (state.phase !== "ended") state.phase = "listening";
                break;
            }

            case "bot.interrupted": {
                const idx = ctx.botIndex.get(entry.data.id);
                if (idx !== undefined) {
                    const m = messages[idx]!;
                    m.speaking = false;
                    m.interrupted = true;
                }
                state.botSpeaking = false;
                if (state.phase !== "ended") state.phase = "listening";
                break;
            }

            case "bot.corrected": {
                // Correction #4 / §2: replace the text of the superseded entry.
                // An event, not a mutation — replay reaches the same place.
                const idx = ctx.bySeq.get(entry.data.supersedes);
                if (idx !== undefined) {
                    const m = messages[idx]!;
                    m.text = entry.data.text;
                    m.corrected = true;
                } else {
                    messages.push({
                        seq: entry.seq,
                        role: "bot",
                        text: entry.data.text,
                        id: entry.data.id,
                        corrected: true,
                    });
                    this.#reindex(ctx, messages);
                }
                break;
            }

            // ── Turns & latency ──
            case "turn.start": {
                const i = ctx.turnIndex.get(entry.data.turn);
                if (i === undefined) {
                    ctx.turnIndex.set(entry.data.turn, state.turns.length);
                    state.turns.push({
                        turn: entry.data.turn,
                        role: entry.data.role,
                        startedAt: entry.ts,
                    });
                } else {
                    state.turns[i] = {
                        ...state.turns[i]!,
                        role: entry.data.role,
                        startedAt: entry.ts,
                    };
                }
                break;
            }

            case "turn.end": {
                const i = ctx.turnIndex.get(entry.data.turn);
                if (i === undefined) {
                    ctx.turnIndex.set(entry.data.turn, state.turns.length);
                    state.turns.push({
                        turn: entry.data.turn,
                        latency: entry.data.latency,
                        endedAt: entry.ts,
                    });
                } else {
                    state.turns[i] = {
                        ...state.turns[i]!,
                        latency: entry.data.latency,
                        endedAt: entry.ts,
                    };
                }
                if (typeof entry.data.latency?.e2e === "number") {
                    ctx.e2eSum += entry.data.latency.e2e;
                    ctx.e2eN += 1;
                }
                break;
            }

            // ── Tools, knowledge, skills ──
            case "tool.call": {
                // Correction #1: no trackedTools filter — expose everything.
                const id = entry.data.id;
                if (ctx.toolIndex.get(id) === undefined) {
                    ctx.toolIndex.set(id, state.toolCalls.length);
                    state.toolCalls.push({
                        id,
                        name: entry.data.name,
                        args: parseArgs(entry.data.args),
                        seq: entry.seq,
                        done: false,
                    });
                    messages.push({
                        seq: entry.seq,
                        role: "system",
                        text: `Using ${entry.data.name}…`,
                        toolCallId: id,
                    });
                    this.#reindex(ctx, messages);
                }
                break;
            }

            case "tool.result": {
                const i = ctx.toolIndex.get(entry.data.id);
                if (i !== undefined) {
                    state.toolCalls[i] = {
                        ...state.toolCalls[i]!,
                        result: parseResult(entry.data.result),
                        ms: entry.data.ms,
                        ...(entry.data.error ? { error: entry.data.error } : {}),
                        done: true,
                    };
                } else {
                    // Result without its call (backlog started mid-pair).
                    ctx.toolIndex.set(entry.data.id, state.toolCalls.length);
                    state.toolCalls.push({
                        id: entry.data.id,
                        name: entry.data.name,
                        args: {},
                        seq: entry.seq,
                        result: parseResult(entry.data.result),
                        ms: entry.data.ms,
                        ...(entry.data.error ? { error: entry.data.error } : {}),
                        done: true,
                    });
                }
                for (const m of messages) {
                    if (m.toolCallId === entry.data.id) {
                        m.text = entry.data.error
                            ? `${entry.data.name} failed`
                            : `${entry.data.name}`;
                    }
                }
                break;
            }

            case "docs.sources":
                state.sources = entry.data.sources ?? [];
                break;

            case "skill.loaded":
                if (!state.skills.includes(entry.data.skill)) {
                    state.skills = [...state.skills, entry.data.skill];
                }
                break;

            case "skill.unloaded":
                state.skills = state.skills.filter((s) => s !== entry.data.skill);
                break;

            // ── Metrics & control ──
            case "audio.metrics":
                // Ephemeral; rolled up into call.summary server-side (§4).
                break;

            case "handoff.requested":
                state.handoff = "requested";
                break;
            case "handoff.active":
                state.handoff = "active";
                break;
            case "handoff.released":
                state.handoff = "none";
                break;

            case "supervisor.said":
            case "supervisor.whispered":
                messages.push({
                    seq: entry.seq,
                    role: "system",
                    text: entry.data.text,
                });
                this.#reindex(ctx, messages);
                break;

            // ── Log control ──
            case "log.caught_up":
                state.caughtUp = true;
                break;

            case "log.gap":
                state.gaps = [
                    ...state.gaps,
                    { from: entry.data.from, resumeFrom: entry.data.resume_from },
                ];
                state.caughtUp = false;
                break;

            default: {
                // Exhaustiveness: adding a §2 type without a case fails to compile.
                const _never: never = entry;
                void _never;
            }
        }
    }

    /** Rebuild the id→index maps after a splice/push. Cheap: messages are small. */
    #reindex(ctx: FoldContext, messages: CallMessage[]): void {
        ctx.botIndex.clear();
        ctx.bySeq.clear();
        for (let i = 0; i < messages.length; i++) {
            const m = messages[i]!;
            ctx.bySeq.set(m.seq, i);
            if (m.role === "bot" && m.id !== undefined) ctx.botIndex.set(m.id, i);
        }
    }
}

/** Build a view from a batch of entries. */
export function createCallLogView(entries?: readonly AnyLogEntry[]): CallLogView {
    const view = new CallLogView();
    if (entries) view.applyAll(entries);
    return view;
}

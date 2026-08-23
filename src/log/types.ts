/**
 * The Call Log — envelope + closed vocabulary (CALL_LOG_SPEC.md §1, §2).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WIRE SHAPE. This module speaks the WIRE, verbatim.
 *
 * Envelope keys are exactly the seven of spec §1 (`seq`, `ts`, `call`,
 * `agent`, `type`, `ephemeral`, `data`) and every key INSIDE `data` is
 * snake_case, exactly as the server appends it. There is deliberately NO
 * codec in the path: the server emits an envelope, the browser applies that
 * same envelope, and `GET /v1/calls/{id}/events` returns the same bytes
 * during the call and after it (spec §10.4). A camelCase translation layer
 * would make "identical" a claim about a transform rather than about bytes.
 *
 * `src/protocol/events.ts` (camelCase, legacy SDK surface) is a DIFFERENT,
 * frozen vocabulary and stays untouched — see spec §8.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * ZERO DEPENDENCIES. Nothing under `src/log/**` imports anything outside
 * itself. The `@pinecall/sdk` root entrypoint pulls in `ws` and node
 * builtins; the `./log` subpath must be usable from a browser bundle, so
 * the isolation is enforced by a test (`tests/log-browser-safe.test.ts`).
 *
 * FORWARD COMPATIBILITY. Unknown `type`s MUST be ignored (§1). The unions
 * below are closed for what a consumer may *rely* on, not for what may
 * arrive: `AnyLogEntry` therefore admits an unknown-type arm, and the
 * reducer's switch is exhaustive over the known arms.
 */

// ── §1 The envelope ──────────────────────────────────────────────────────

/** Every fact a session produces becomes exactly one of these. */
export interface LogEntry<T extends LogEventType = LogEventType, D = LogData<T>> {
    /**
     * Monotonic per call, assigned only at the append point. The cursor AND
     * the dedupe key. May have holes after compaction — never assume
     * contiguity; "caught up" is signalled by `log.caught_up`, never inferred.
     */
    seq: number;
    /** Server wall clock, float seconds. */
    ts: number;
    /** Call id. `null` on the agent's lifecycle-only log (§2, "The agent log"). */
    call: string | null;
    /** Agent id. */
    agent: string;
    /** One vocabulary (§2). No per-channel dialects. */
    type: T;
    /** `true` → delivered live, never persisted (§4). */
    ephemeral: boolean;
    /** Type-specific payload (§2). Additive-only per type. */
    data: D;
}

// ── §2 The vocabulary — data payloads ────────────────────────────────────

export type CallDirection = "inbound" | "outbound";

/** `call.ringing` — outbound: exists before pickup. */
export interface CallRingingData {
    direction: CallDirection;
    from: string;
    to: string;
}

/** `call.started` — `metadata` is the sealed token metadata. */
export interface CallStartedData {
    direction: CallDirection;
    from: string;
    to: string;
    channel: string;
    metadata?: Record<string, unknown>;
}

/** `call.ended` */
export interface CallEndedData {
    reason: string;
    duration: number;
}

/** One latency distribution inside `call.summary`. */
export interface MetricDistribution {
    p50: number;
    p90: number;
    p95: number;
    max: number;
    n: number;
}

export interface CallSummaryMetrics {
    e2e: MetricDistribution;
    asr: MetricDistribution;
    llm_ttft: MetricDistribution;
    tts_ttfb: MetricDistribution;
}

/** `call.summary` — ALWAYS the last entry. History needs no second API. */
export interface CallSummaryData {
    metrics: CallSummaryMetrics;
    cost?: number;
    reason: string;
    /** Recordings are referenced, never embedded (§8). */
    recording_url?: string;
}

/** `user.speaking` — ephemeral. */
export interface UserSpeakingData {
    active: boolean;
}

/** `user.message` — partials ephemeral, finals persisted. */
export interface UserMessageData {
    id: string;
    text: string;
    final: boolean;
    language?: string;
}

/** One word of TTS alignment, carried INSIDE `bot.speaking`. */
export interface WordTiming {
    w: string;
    t0: number;
    t1: number;
}

/** `bot.speaking` — word alignment inside the event when TTS provides it. */
export interface BotSpeakingData {
    id: string;
    text: string;
    words?: WordTiming[];
}

/** `bot.word` — ephemeral; live typing effect only. */
export interface BotWordData {
    id: string;
    w: string;
}

/** `bot.finished` */
export interface BotFinishedData {
    id: string;
}

/** `bot.interrupted` */
export interface BotInterruptedData {
    id: string;
    at_word?: number;
}

/**
 * `bot.corrected` — the transcript self-heals. An EVENT, not a mutation:
 * consumers replace the text of the entry named by `supersedes`.
 */
export interface BotCorrectedData {
    supersedes: number;
    id: string;
    text: string;
}

export type TurnRole = "user" | "bot";

/** `turn.start` */
export interface TurnStartData {
    turn: number;
    role: TurnRole;
}

/** Per-turn latency is first-class. */
export interface TurnLatency {
    vad: number;
    asr: number;
    eou: number;
    llm_ttft: number;
    tts_ttfb: number;
    e2e: number;
}

/** `turn.end` */
export interface TurnEndData {
    turn: number;
    latency: TurnLatency;
}

/** `tool.call` — reaches EVERY audience, correlated with `tool.result` by `id`. */
export interface ToolCallData {
    id: string;
    name: string;
    /** Providers send either a parsed object or a JSON string. Both are legal. */
    args: Record<string, unknown> | string;
}

/** `tool.result` */
export interface ToolResultData {
    id: string;
    name: string;
    result: unknown;
    ms: number;
    error?: string;
}

/** `docs.sources` — RAG citations. */
export interface DocsSourcesData {
    sources: unknown[];
}

/** `skill.loaded` / `skill.unloaded` */
export interface SkillData {
    skill: string;
    by: string;
}

/** `audio.metrics` — ephemeral; rolled up into `call.summary`. */
export interface AudioMetricsData {
    mos?: number;
    jitter?: number;
    loss?: number;
    [k: string]: unknown;
}

/** `handoff.requested` / `handoff.active` / `handoff.released` */
export interface HandoffData {
    by: string;
}

/** `supervisor.said` / `supervisor.whispered` — audit trail of the §7 verbs. */
export interface SupervisorData {
    text: string;
    by: string;
}

/**
 * `log.gap` (§3, anti-Slack rule) — a gap is DECLARED, never silently
 * papered over. `snapshot` is consolidated call state so the consumer can
 * render immediately and continue from `resume_from`.
 */
export interface LogGapData {
    from: number;
    resume_from: number;
    snapshot?: Record<string, unknown>;
}

/** `log.caught_up` (§5) — backlog drained, live entries follow. */
export interface LogCaughtUpData {
    seq: number;
}

/**
 * `custom` — the one open extension point: `call.log(name, value)`. The
 * reducer never interprets `value`; it projects the latest value per
 * `(name, id)` into `state.custom` (upsert — the wire itself stays
 * append-only). Ephemeral ones are fanned out live and never stored.
 */
export interface CustomData {
    name: string;
    value: unknown;
    /** Upsert key in the projection; absent → the entry's seq. */
    id?: string;
    /** Server-stamped turn id, when the session has turns. */
    turn?: number;
}

// ── The closed type union ────────────────────────────────────────────────

/**
 * The complete vocabulary. A fact that does not fit one of these is a
 * finding to report, not a new type to mint.
 */
export interface LogDataMap {
    "call.ringing": CallRingingData;
    "call.started": CallStartedData;
    "call.ended": CallEndedData;
    "call.summary": CallSummaryData;
    "user.speaking": UserSpeakingData;
    "user.message": UserMessageData;
    "bot.speaking": BotSpeakingData;
    "bot.word": BotWordData;
    "bot.finished": BotFinishedData;
    "bot.interrupted": BotInterruptedData;
    "bot.corrected": BotCorrectedData;
    "turn.start": TurnStartData;
    "turn.end": TurnEndData;
    "tool.call": ToolCallData;
    "tool.result": ToolResultData;
    "docs.sources": DocsSourcesData;
    "skill.loaded": SkillData;
    "skill.unloaded": SkillData;
    "audio.metrics": AudioMetricsData;
    "handoff.requested": HandoffData;
    "handoff.active": HandoffData;
    "handoff.released": HandoffData;
    "supervisor.said": SupervisorData;
    "supervisor.whispered": SupervisorData;
    "log.gap": LogGapData;
    "log.caught_up": LogCaughtUpData;
    "custom": CustomData;
}

/** Every legal `type` value. Closed — see §2. */
export type LogEventType = keyof LogDataMap;

/** The payload that belongs to a given `type`. */
export type LogData<T extends LogEventType> = LogDataMap[T];

/** The discriminated union of all known entries — what the reducer switches on. */
export type KnownLogEntry = {
    [T in LogEventType]: LogEntry<T, LogDataMap[T]>;
}[LogEventType];

/**
 * An entry as it arrives off the wire: either a known one, or one whose
 * `type` this SDK version has never heard of. §1 requires the latter be
 * ignored rather than rejected, so it is part of the input type.
 */
export type UnknownLogEntry = Omit<LogEntry<LogEventType, unknown>, "type"> & {
    type: string;
};

export type AnyLogEntry = KnownLogEntry | UnknownLogEntry;

/** The set of `type` values this build understands. */
export const LOG_EVENT_TYPES: readonly LogEventType[] = [
    "call.ringing",
    "call.started",
    "call.ended",
    "call.summary",
    "user.speaking",
    "user.message",
    "bot.speaking",
    "bot.word",
    "bot.finished",
    "bot.interrupted",
    "bot.corrected",
    "turn.start",
    "turn.end",
    "tool.call",
    "tool.result",
    "docs.sources",
    "skill.loaded",
    "skill.unloaded",
    "audio.metrics",
    "handoff.requested",
    "handoff.active",
    "handoff.released",
    "supervisor.said",
    "supervisor.whispered",
    "log.gap",
    "log.caught_up",
    "custom",
] as const;

const KNOWN = new Set<string>(LOG_EVENT_TYPES);

/** Narrow an off-the-wire entry to the known vocabulary. */
export function isKnownLogEntry(entry: AnyLogEntry): entry is KnownLogEntry {
    return KNOWN.has(entry.type);
}

/**
 * Structural check for the §1 envelope. Anything that fails this is not a
 * log entry and must not be fed to a view.
 */
export function isLogEntry(value: unknown): value is AnyLogEntry {
    if (typeof value !== "object" || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.seq === "number" &&
        typeof v.ts === "number" &&
        typeof v.type === "string" &&
        typeof v.agent === "string" &&
        (typeof v.call === "string" || v.call === null)
    );
}

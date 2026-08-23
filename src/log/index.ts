/**
 * `@pinecall/sdk/log` — the Call Log contract (CALL_LOG_SPEC.md).
 *
 * A call is an append-only event log with per-call monotonic sequence
 * numbers; live, late, reconnecting, replaying and history are all cursors
 * over it. This subpath carries the envelope, the closed vocabulary and the
 * ONE reducer — nothing else. It imports nothing outside `src/log/**`, has
 * zero runtime dependencies and no node builtins, so it is safe to ship to
 * a browser (asserted by `tests/log-browser-safe.test.ts`).
 *
 * @example
 * ```ts
 * import { CallLogView, type LogEntry } from "@pinecall/sdk/log";
 *
 * const view = new CallLogView();
 * ws.onmessage = (e) => view.apply(JSON.parse(e.data));
 * // resume after a drop:
 * ws = new WebSocket(`${url}&after=${view.lastSeq}`);
 * ```
 */

export type {
    // §1 envelope
    LogEntry,
    LogEventType,
    LogData,
    LogDataMap,
    KnownLogEntry,
    UnknownLogEntry,
    AnyLogEntry,
    // §2 payloads
    CallDirection,
    CallRingingData,
    CallStartedData,
    CallEndedData,
    CallSummaryData,
    CallSummaryMetrics,
    MetricDistribution,
    UserSpeakingData,
    UserMessageData,
    BotSpeakingData,
    BotWordData,
    BotFinishedData,
    BotInterruptedData,
    BotCorrectedData,
    WordTiming,
    TurnRole,
    TurnStartData,
    TurnEndData,
    TurnLatency,
    ToolCallData,
    ToolResultData,
    DocsSourcesData,
    SkillData,
    AudioMetricsData,
    HandoffData,
    SupervisorData,
    LogGapData,
    LogCaughtUpData,
    CustomData,
} from "./types.js";

export { LOG_EVENT_TYPES, isKnownLogEntry, isLogEntry } from "./types.js";

export type {
    CallLogState,
    CallPhase,
    CallMessage,
    MessageRole,
    CallToolCall,
    CallTurn,
    CallMetrics,
    CallIntent,
    CallCustomEntry,
} from "./view.js";

export { CallLogView, createCallLogView } from "./view.js";

/**
 * Server → Client event types — every event from PROTOCOL.md §7.
 *
 * Convention: camelCase for all TypeScript fields. Wire protocol uses
 * snake_case — the SDK transforms at the boundary (see protocol/codec.ts).
 */

// ─── Session Lifecycle ───────────────────────────────────────────────────

export interface CallStartedEvent {
    event: "call.started";
    callId: string;
    sessionId: string;
    from: string;
    to: string;
    direction: "inbound" | "outbound";
    metadata?: Record<string, unknown>;
    /**
     * The extension the caller dialled after the number ("33"), or null.
     * Phone lines only — see `pc.line()`; an agent that a line routed to
     * receives the same value so it knows which door the call came through.
     */
    extension?: string | null;
    /** Who owns the session right now: the line that answered, or an agent. */
    owner?: "line" | "agent";
    /** Set on a call handed over by `line.routeTo()`: the line's id, `line:<number>`. */
    routedFrom?: string;
    /** What the line heard and said before it handed the call over. */
    lineTranscript?: LineTranscriptEntry[];
}

/**
 * One line in a phone line's own transcript — what the CALLER said and what
 * the LINE said back, before any model was involved.
 *
 * It carries `role`/`content` as well so anything that reads a plain `Call`
 * transcript keeps working on a line's.
 */
export interface LineTranscriptEntry {
    who: "caller" | "line";
    text: string;
    /** Epoch milliseconds. */
    at: number;
    /** `who`, in the shape a plain Call transcript uses. */
    role: "user" | "assistant";
    /** `text`, in the shape a plain Call transcript uses. */
    content: string;
}

export interface CallRingingEvent {
    event: "call.ringing";
    callId: string;
    from: string;
    to: string;
    direction: "inbound";
}

export interface CallRejectedEvent {
    event: "call.rejected";
    callId: string;
    reason: string;
}

export interface CallEndedEvent {
    event: "call.ended";
    callId: string;
    sessionId: string;
    reason: string;
    durationSeconds: number;
}

export interface SessionTimeoutEvent {
    event: "session.timeout";
    callId: string;
    sessionId: string;
    reason: "max_duration" | "idle_timeout";
}

// ─── Speech ──────────────────────────────────────────────────────────────

export interface SpeechStartedEvent {
    event: "speech.started";
    callId: string;
    turnId: number;
    confidence: number;
    timestamp: number;
}

export interface SpeechEndedEvent {
    event: "speech.ended";
    callId: string;
    turnId: number;
    durationMs: number;
    timestamp: number;
}

// ─── Transcripts ─────────────────────────────────────────────────────────

export interface UserSpeakingEvent {
    event: "user.speaking";
    callId: string;
    messageId: string;
    text: string;
    confidence: number;
    confirmedText?: string;
}

export interface UserMessageEvent {
    event: "user.message";
    callId: string;
    messageId: string;
    text: string;
    confidence: number;
    language?: string;
    lagMs?: number;
    turnId: number;
}

// ─── Turns ───────────────────────────────────────────────────────────────

export interface EagerTurnEvent {
    event: "eager.turn";
    callId: string;
    turnId: number;
    probability: number;
    latencyMs: number;
    text: string;
    messageId: string;
}

export interface TurnPauseEvent {
    event: "turn.pause";
    callId: string;
    turnId: number;
    probability: number;
    latencyMs: number;
}

export interface TurnEndEvent {
    event: "turn.end";
    callId: string;
    turnId: number;
    probability: number;
    latencyMs: number;
}

export interface TurnResumedEvent {
    event: "turn.resumed";
    callId: string;
    turnId: number;
    timestamp: number;
}

export interface TurnContinuedEvent {
    event: "turn.continued";
    callId: string;
    turnId: number;
    timestamp: number;
}

// ─── Bot ─────────────────────────────────────────────────────────────────

export interface BotSpeakingEvent {
    event: "bot.speaking";
    callId: string;
    messageId: string;
    text: string;
}

export interface BotWordEvent {
    event: "bot.word";
    callId: string;
    messageId: string;
    word: string;
    wordIndex: number;
    startTime?: number;
    endTime?: number;
}

export interface BotFinishedEvent {
    event: "bot.finished";
    callId: string;
    messageId: string;
    durationMs: number;
}

export interface BotInterruptedEvent {
    event: "bot.interrupted";
    callId: string;
    messageId: string;
    playedMs: number;
    wordsSpoken: number;
    lastWord?: string;
    reason: "continuation" | "user_spoke" | "cancelled";
}

export interface BargeInEvent {
    event: "barge_in";
    callId: string;
    cancelledMessageId: string;
}

// ─── Confirmations ───────────────────────────────────────────────────────

export interface MessageConfirmedEvent {
    event: "message.confirmed";
    callId: string;
    messageId: string;
    text: string;
}

export interface ReplyRejectedEvent {
    event: "reply.rejected";
    callId: string;
    messageId: string;
    inReplyTo: string;
    expectedReplyTo: string;
    reason: string;
}

// ─── Analysis ────────────────────────────────────────────────────────────

export interface AudioMetricsEvent {
    event: "audio.metrics";
    callId: string;
    source: "user" | "bot";
    energyDb: number;
    rms: number;
    peak: number;
    isSpeech: boolean;
    vadProb?: number;
    timestamp: number;
}

// ─── Phone / Call Control ────────────────────────────────────────────────

export interface CallDialingEvent {
    event: "call.dialing";
    callId: string;
    to: string;
    from: string;
}

export interface CallErrorEvent {
    event: "call.error";
    callId: string;
    error: string;
    code?: string;
}

export interface CallForwardedEvent {
    event: "call.forwarded";
    callId: string;
    to: string;
}

export interface CallDtmfSentEvent {
    event: "call.dtmf_sent";
    callId: string;
    digits: string;
}

/**
 * The CALLER pressed a key on a live phone call.
 *
 * The inbound twin of `call.dtmf_sent`, and named apart from it on purpose:
 * `call.dtmf` is the command that plays tones DOWN the line, so an event
 * called `call.dtmf` could not say whose finger it was.
 *
 * `digit` is this press. `digits` is every press so far on this call, so a
 * menu collecting an entry ("extension 204#") does not have to buffer them.
 */
export interface CallDtmfReceivedEvent {
    event: "call.dtmf_received";
    callId: string;
    digit: string;
    digits: string;
}

// ─── Config responses ────────────────────────────────────────────────────

export interface ConfigUpdatedEvent {
    event: "config_updated";
    phone: string;
}

export interface SessionConfigUpdatedEvent {
    event: "session_config_updated";
    sessionId: string;
    success: boolean;
}

export interface PhoneAddedEvent {
    event: "phone_added";
    phone: string;
}

export interface PhoneRemovedEvent {
    event: "phone_removed";
    phone: string;
}

// ─── LLM / Tool Calls ───────────────────────────────────────────────────

/** A single tool call from the server-side LLM. */
export interface ToolCallItem {
    /** Tool call ID (for correlating results). */
    id: string;
    /** Tool/function name. */
    name: string;
    /** JSON-encoded arguments string. */
    arguments: string;
}

export interface ToolCallEvent {
    event: "llm.toolCall";
    callId: string;
    /** Tool calls requested by the LLM. */
    toolCalls: ToolCallItem[];
    /** Message ID — pass back in `call.toolResult()`. */
    msgId: string;
}

// ─── Connection ──────────────────────────────────────────────────────────

export interface RegisteredEvent {
    event: "registered";
    appId: string;
    organizationId: string;
    protocolVersion: string;
}

export interface ErrorEvent {
    event: "error";
    error: string;
    code?: string;
}

export interface PongEvent {
    event: "pong";
    timestamp: number;
}

export interface AgentDisplacedEvent {
    event: "agent.displaced";
    agentId: string;
    reason: string;
}

// ─── Hold / Mute ─────────────────────────────────────────────────────────

export interface CallHeldEvent {
    event: "call.held";
    callId: string;
}

export interface CallUnheldEvent {
    event: "call.unheld";
    callId: string;
}

export interface CallMutedEvent {
    event: "call.muted";
    callId: string;
}

export interface CallUnmutedEvent {
    event: "call.unmuted";
    callId: string;
    mutedTranscript: string | null;
}

// ─── Phone lines (pc.line) ───────────────────────────────────────────────

/** The server registered a line and it now owns the number. */
export interface LineCreatedEvent {
    event: "line.created";
    number: string;
}

/** The registration was refused. `code` says which of the four cases it is. */
export interface LineErrorEvent {
    event: "line.error";
    number: string;
    code: "LINE_CONFLICT" | "LINE_CONFIG_ERROR" | "PHONE_NOT_IN_ORG" | "UNAUTHORIZED";
    error: string;
}

/** Ack of `line.destroy` — the number is released. */
export interface LineDestroyedEvent {
    event: "line.destroyed";
    number: string;
}

/**
 * The owner swap succeeded: the agent is now driving this call, on the same
 * audio stream. A `call.ended` with reason `"routed"` follows, for the line.
 */
export interface CallRoutedEvent {
    event: "call.routed";
    callId: string;
    agent: string;
}

/** The owner swap did not happen. The line is still the owner; nothing was dropped. */
export interface CallRouteFailedEvent {
    event: "call.route_failed";
    callId: string;
    agent: string;
    reason: "offline" | "unknown" | "no_phone_config" | "capacity" | "swap_failed";
}

// ─── Union ───────────────────────────────────────────────────────────────

export type ServerEvent =
    | CallStartedEvent
    | CallEndedEvent
    | SessionTimeoutEvent
    | SpeechStartedEvent
    | SpeechEndedEvent
    | UserSpeakingEvent
    | UserMessageEvent
    | EagerTurnEvent
    | TurnPauseEvent
    | TurnEndEvent
    | TurnResumedEvent
    | TurnContinuedEvent
    | BotSpeakingEvent
    | BotWordEvent
    | BotFinishedEvent
    | BotInterruptedEvent
    | BargeInEvent
    | MessageConfirmedEvent
    | ReplyRejectedEvent
    | AudioMetricsEvent
    | CallDialingEvent
    | CallErrorEvent
    | CallForwardedEvent
    | CallDtmfSentEvent
    | ConfigUpdatedEvent
    | SessionConfigUpdatedEvent
    | PhoneAddedEvent
    | PhoneRemovedEvent
    | RegisteredEvent
    | ErrorEvent
    | PongEvent
    | AgentDisplacedEvent
    | CallHeldEvent
    | CallUnheldEvent
    | CallMutedEvent
    | CallUnmutedEvent
    | CallRingingEvent
    | CallRejectedEvent
    | LineCreatedEvent
    | LineErrorEvent
    | LineDestroyedEvent
    | CallRoutedEvent
    | CallRouteFailedEvent;

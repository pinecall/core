/**
 * Server → Client event types — every event from PROTOCOL.md §7.
 */

// ─── Session Lifecycle ───────────────────────────────────────────────────

export interface CallStartedEvent {
    event: "call.started";
    call_id: string;
    session_id: string;
    from: string;
    to: string;
    direction: "inbound" | "outbound";
    metadata?: Record<string, unknown>;
}

export interface CallEndedEvent {
    event: "call.ended";
    call_id: string;
    session_id: string;
    reason: string;
    duration_seconds: number;
}

export interface SessionTimeoutEvent {
    event: "session.timeout";
    call_id: string;
    session_id: string;
    reason: "max_duration" | "idle_timeout";
}

// ─── Speech ──────────────────────────────────────────────────────────────

export interface SpeechStartedEvent {
    event: "speech.started";
    call_id: string;
    turn_id: number;
    confidence: number;
    timestamp: number;
}

export interface SpeechEndedEvent {
    event: "speech.ended";
    call_id: string;
    turn_id: number;
    duration_ms: number;
    timestamp: number;
}

// ─── Transcripts ─────────────────────────────────────────────────────────

export interface UserSpeakingEvent {
    event: "user.speaking";
    call_id: string;
    message_id: string;
    text: string;
    confidence: number;
    confirmed_text?: string;
}

export interface UserMessageEvent {
    event: "user.message";
    call_id: string;
    message_id: string;
    text: string;
    confidence: number;
    language?: string;
    lag_ms?: number;
    turn_id: number;
}

// ─── Turns ───────────────────────────────────────────────────────────────

export interface EagerTurnEvent {
    event: "eager.turn";
    call_id: string;
    turn_id: number;
    probability: number;
    latency_ms: number;
    text: string;
    message_id: string;
}

export interface TurnPauseEvent {
    event: "turn.pause";
    call_id: string;
    turn_id: number;
    probability: number;
    latency_ms: number;
}

export interface TurnEndEvent {
    event: "turn.end";
    call_id: string;
    turn_id: number;
    probability: number;
    latency_ms: number;
}

export interface TurnResumedEvent {
    event: "turn.resumed";
    call_id: string;
    turn_id: number;
    timestamp: number;
}

export interface TurnContinuedEvent {
    event: "turn.continued";
    call_id: string;
    turn_id: number;
    timestamp: number;
}

// ─── Bot ─────────────────────────────────────────────────────────────────

export interface BotSpeakingEvent {
    event: "bot.speaking";
    call_id: string;
    message_id: string;
    text: string;
}

export interface BotWordEvent {
    event: "bot.word";
    call_id: string;
    message_id: string;
    word: string;
    word_index: number;
    start_time?: number;
    end_time?: number;
}

export interface BotFinishedEvent {
    event: "bot.finished";
    call_id: string;
    message_id: string;
    duration_ms: number;
}

export interface BotInterruptedEvent {
    event: "bot.interrupted";
    call_id: string;
    message_id: string;
    played_ms: number;
    words_spoken: number;
    last_word?: string;
    reason: "continuation" | "user_spoke" | "cancelled";
}

export interface BargeInEvent {
    event: "barge_in";
    call_id: string;
    cancelled_message_id: string;
}

// ─── Confirmations ───────────────────────────────────────────────────────

export interface MessageConfirmedEvent {
    event: "message.confirmed";
    call_id: string;
    message_id: string;
    text: string;
}

export interface ReplyRejectedEvent {
    event: "reply.rejected";
    call_id: string;
    message_id: string;
    in_reply_to: string;
    expected_reply_to: string;
    reason: string;
}

// ─── Analysis ────────────────────────────────────────────────────────────

export interface AudioMetricsEvent {
    event: "audio.metrics";
    call_id: string;
    source: "user" | "bot";
    energy_db: number;
    rms: number;
    peak: number;
    is_speech: boolean;
    vad_prob?: number;
    timestamp: number;
}

// ─── Phone / Call Control ────────────────────────────────────────────────

export interface CallDialingEvent {
    event: "call.dialing";
    call_id: string;
    to: string;
    from: string;
}

export interface CallErrorEvent {
    event: "call.error";
    call_id: string;
    error: string;
    code?: string;
}

export interface CallForwardedEvent {
    event: "call.forwarded";
    call_id: string;
    to: string;
}

export interface CallDtmfSentEvent {
    event: "call.dtmf_sent";
    call_id: string;
    digits: string;
}

// ─── Config responses ────────────────────────────────────────────────────

export interface ConfigUpdatedEvent {
    event: "config_updated";
    phone: string;
}

export interface SessionConfigUpdatedEvent {
    event: "session_config_updated";
    session_id: string;
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

// ─── Connection ──────────────────────────────────────────────────────────

export interface RegisteredEvent {
    event: "registered";
    app_id: string;
    organization_id: string;
    protocol_version: string;
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
    agent_id: string;
    reason: string;
}

// ─── Hold / Mute ─────────────────────────────────────────────────────────

export interface CallHeldEvent {
    event: "call.held";
    call_id: string;
}

export interface CallUnheldEvent {
    event: "call.unheld";
    call_id: string;
}

export interface CallMutedEvent {
    event: "call.muted";
    call_id: string;
}

export interface CallUnmutedEvent {
    event: "call.unmuted";
    call_id: string;
    muted_transcript: string | null;
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
    | CallUnmutedEvent;

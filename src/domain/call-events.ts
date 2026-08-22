/**
 * Call event map and option types.
 *
 * Split out of `call.ts` so the class file is the behaviour and this is the
 * shape of what it emits. Everything here is re-exported from `call.ts`, which
 * is where index.ts (and every app) has always imported it from.
 */

import type { Call } from "./call.js";
import type { Turn } from "./turn.js";
import type {
    SpeechStartedEvent,
    SpeechEndedEvent,
    UserSpeakingEvent,
    UserMessageEvent,
    TurnPauseEvent,
    TurnResumedEvent,
    TurnContinuedEvent,
    BotSpeakingEvent,
    BotWordEvent,
    BotFinishedEvent,
    BotInterruptedEvent,
    MessageConfirmedEvent,
    ReplyRejectedEvent,
    AudioMetricsEvent,
    SessionTimeoutEvent,
    ToolCallEvent,
    CallDtmfReceivedEvent,
} from "../protocol/events.js";

// ─── Call-scoped event map ───────────────────────────────────────────────

export interface CallEvents {
    [key: string]: (...args: any[]) => void;
    "speech.started": (event: SpeechStartedEvent) => void;
    "speech.ended": (event: SpeechEndedEvent) => void;
    "user.speaking": (event: UserSpeakingEvent) => void;
    "user.message": (event: UserMessageEvent) => void;
    "eager.turn": (turn: Turn) => void;
    "turn.pause": (event: TurnPauseEvent) => void;
    "turn.end": (turn: Turn) => void;
    "turn.resumed": (event: TurnResumedEvent) => void;
    "turn.continued": (event: TurnContinuedEvent) => void;
    "bot.speaking": (event: BotSpeakingEvent) => void;
    "bot.word": (event: BotWordEvent) => void;
    "bot.finished": (event: BotFinishedEvent) => void;
    "bot.interrupted": (event: BotInterruptedEvent) => void;
    "message.confirmed": (event: MessageConfirmedEvent) => void;
    "reply.rejected": (event: ReplyRejectedEvent) => void;
    "audio.metrics": (event: AudioMetricsEvent) => void;
    "call.held": () => void;
    "call.unheld": () => void;
    "call.muted": () => void;
    "call.unmuted": (mutedTranscript: string | null) => void;
    /** The caller pressed a key. Phone only — a browser has no keypad. */
    "call.dtmf_received": (event: CallDtmfReceivedEvent) => void;
    "llm.toolCall": (event: ToolCallEvent) => void;
    "skill.loaded": (event: SkillEvent) => void;
    "skill.unloaded": (event: SkillEvent) => void;
    /**
     * The server is about to generate a reply and is HOLDING the turn open for
     * you. Refresh per-turn prompt variables here.
     *
     * Return a promise (an `async` handler does this for you) and the SDK waits
     * for it before telling the server to go ahead — so an awaited
     * `call.setPromptVars()` inside this handler is guaranteed to land on THIS
     * generation, not the next one.
     */
    "call.preparing": (call: Call) => void | Promise<unknown>;
    /**
     * The server gave up waiting for `call.preparing` and generated with the
     * previous values. Only fires for agents that opted in with `preparing`.
     * This is the loud failure — a silent one is what this replaced.
     */
    "call.preparingTimeout": (event: PreparingTimeoutEvent) => void;
    "session.timeout": (event: SessionTimeoutEvent) => void;
    "ended": (reason: string) => void;
}

/** Payload of `call.preparingTimeout`. */
export interface PreparingTimeoutEvent {
    callId: string;
    /** Turn counter, as the server numbers it. */
    turn: number;
    /** How long the server actually waited, in ms. */
    waitedMs: number;
    /** The budget it was allowed to wait, in ms. */
    budgetMs: number;
}

/** Emitted when a skill is activated/deactivated on a call. */
export interface SkillEvent {
    /** Skill name. */
    skill: string;
    /** Who triggered it: "model" (loadSkill meta-tool) or "manual" (call.loadSkill). */
    by: "model" | "manual";
}

// ─── Reply options ───────────────────────────────────────────────────────

export interface ReplyOptions {
    messageId?: string;
    inReplyTo?: string;
}

export interface ForwardOptions {
    message?: string;
    announce?: boolean;
}

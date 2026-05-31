/**
 * @pinecall/sdk — Core SDK for Pinecall Voice.
 *
 * Minimal, zero-opinion client for building voice AI integrations.
 *
 * @example
 * ```ts
 * import { Pinecall } from "@pinecall/sdk";
 *
 * const pc = new Pinecall({ apiKey: "pk_..." });
 * await pc.connect();
 *
 * const agent = pc.agent("my-agent", {
 *   voice: "elevenlabs:abc",
 *   language: "es",
 * });
 *
 * agent.addChannel("phone", "+19035551234");
 *
 * agent.on("call.started", (call) => {
 *   call.say("Hello! How can I help you?");
 * });
 *
 * agent.on("turn.end", (turn, call) => {
 *   call.reply("I heard: " + turn.text);
 * });
 * ```
 */

// Core classes
export { Pinecall, PinecallError } from "./client.js";
export type { PinecallOptions, PinecallEvents } from "./client.js";
export type { DeployConfig } from "./config/agent.js";
export type { StreamOptions } from "./sse/stream.js";

// Tool definition
export { tool } from "./tool.js";
export type { Tool, ToolConfig } from "./tool.js";

export { Agent } from "./domain/agent.js";
export type {
    AgentEvents,
} from "./domain/agent.js";

export type {
    AgentConfig,
    ChannelConfig,
    WhatsAppChannelConfig,
    VoiceShortcut,
    STTShortcut,
    InterruptionShortcut,
} from "./config/agent.js";

export { Call } from "./domain/call.js";
export type { CallEvents, ReplyOptions, ForwardOptions } from "./domain/call.js";

// Re-export Turn from domain
export type { Turn } from "./domain/turn.js";

export { ReplyStream } from "./domain/reply-stream.js";
export type { ReplyStreamOptions } from "./domain/reply-stream.js";

// Config types
export type {
    SessionConfig,
    STTConfig,
    DeepgramSTTConfig,
    FluxSTTConfig,
    GladiaSTTConfig,
    TranscribeSTTConfig,
    TTSConfig,
    ElevenLabsTTSConfig,
    CartesiaTTSConfig,
    PollyTTSConfig,
    InterruptionConfig,
    SpeakerFilterConfig,
    AnalysisConfig,
} from "./config/session.js";

// Event types
export type {
    ServerEvent,
    CallStartedEvent,
    CallEndedEvent,
    SpeechStartedEvent,
    SpeechEndedEvent,
    UserSpeakingEvent,
    UserMessageEvent,
    EagerTurnEvent,
    TurnPauseEvent,
    TurnEndEvent,
    TurnResumedEvent,
    TurnContinuedEvent,
    BotSpeakingEvent,
    BotWordEvent,
    BotFinishedEvent,
    BotInterruptedEvent,
    BargeInEvent,
    MessageConfirmedEvent,
    ReplyRejectedEvent,
    AudioMetricsEvent,
    RegisteredEvent,
    ErrorEvent,
    PongEvent,
    CallHeldEvent,
    CallUnheldEvent,
    CallMutedEvent,
    CallUnmutedEvent,
    SessionTimeoutEvent,
    ToolCallEvent,
    ToolCallItem,
} from "./protocol/events.js";

// Command types
export type {
    ClientCommand,
    RegisterCommand,
    BotReplyCommand,
    BotReplyStreamCommand,
    BotCancelCommand,
    BotClearCommand,
    CallHangupCommand,
    CallDialCommand,
    CallForwardCommand,
    CallDtmfCommand,
    UpdateConfigCommand,
    UpdateSessionConfigCommand,
    AddPhoneCommand,
    RemovePhoneCommand,
    PingCommand,
    CallHoldCommand,
    CallUnholdCommand,
    CallMuteCommand,
    CallUnmuteCommand,
    ConnectCommand,
    AgentCreateCommand,
    AgentResumeCommand,
    AgentConfigureCommand,
    ChannelAddCommand,
    ChannelConfigureCommand,
    ChannelRemoveCommand,
    SessionConfigureCommand,
} from "./protocol/commands.js";

// Utilities
export { generateId } from "./kernel/id.js";
export { Reconnector } from "./transport/reconnect.js";
export type { ReconnectOptions } from "./transport/reconnect.js";

// REST API helpers
export { fetchVoices } from "./api/voices.js";
export type { Voice, VoiceLanguage, FetchVoicesOptions } from "./api/voices.js";

export { fetchPhones } from "./api/phones.js";
export type { Phone as PhoneInfo, FetchPhonesOptions } from "./api/phones.js";

export { createToken } from "./api/tokens.js";
export type {
    WebRTCToken,
    TokenResponse,
    FetchWebRTCTokenOptions,
    CreateTokenOptions,
} from "./api/tokens.js";

export { fetchTwilioBalance, fetchBalance } from "./api/balance.js";
export type {
    TwilioBalance,
    Balance,
    FetchTwilioBalanceOptions,
    FetchBalanceOptions,
} from "./api/balance.js";

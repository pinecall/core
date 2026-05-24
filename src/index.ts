/**
 * pinecall — Core SDK for Pinecall Voice.
 *
 * Minimal, zero-opinion client for building voice AI integrations.
 * For the full agent framework (PinecallAgent, CLI, dashboard), use @pinecall/sdk.
 *
 * @example
 * ```ts
 * import { Pinecall } from "pinecall";
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
export type { PinecallOptions, PinecallEvents, DeployConfig } from "./client.js";
export type { StreamOptions } from "./sse.js";

export { Agent } from "./agent.js";
export type {
    AgentEvents,
    AgentConfig,
    ChannelConfig,
    WhatsAppChannelConfig,
    VoiceShortcut,
    STTShortcut,
    InterruptionShortcut,
} from "./agent.js";

export { Call } from "./call.js";
export type { Turn, CallEvents, ReplyOptions, ForwardOptions } from "./call.js";

export { ReplyStream } from "./stream.js";
export type { ReplyStreamOptions } from "./stream.js";

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
} from "./types/config.js";

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
} from "./types/events.js";

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
} from "./types/commands.js";

// Utilities
export { generateId } from "./utils/id.js";
export { Reconnector } from "./utils/reconnect.js";
export type { ReconnectOptions } from "./utils/reconnect.js";

// REST API helpers
export { fetchVoices, fetchPhones, fetchWebRTCToken, fetchTwilioBalance, fetchBalance, createToken } from "./api.js";
export type {
    Voice,
    VoiceLanguage,
    Phone as PhoneInfo,
    WebRTCToken,
    TokenResponse,
    TwilioBalance,
    Balance,
    FetchVoicesOptions,
    FetchPhonesOptions,
    FetchWebRTCTokenOptions,
    CreateTokenOptions,
    FetchTwilioBalanceOptions,
    FetchBalanceOptions,
} from "./api.js";

// History types (interface only — implementations live in @pinecall/sdk)
// Consumers can implement HistoryStore for their own persistence.

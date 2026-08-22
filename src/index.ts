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
 *
 * const agent = pc.agent("my-agent", {
 *   voice: "elevenlabs:abc",
 *   language: "es",
 *   phoneNumber: "+19035551234",
 * });
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
export { Pinecall, PinecallError, AgentConflictError, ServerAtCapacityError } from "./client.js";
export type { PinecallOptions, PinecallEvents } from "./client.js";
export type { StreamOptions } from "./sse/stream.js";

// Event streaming (WebSocket)
export { EventStream, createEventStream } from "./stream/event-stream.js";
export type { EventStreamOptions, EventStreamStatus } from "./stream/event-stream.js";
export { createAgentWS } from "./stream/ws-stream.js";
export type { WSLike, WSStreamOptions } from "./stream/ws-stream.js";

// Tool definition
export { tool } from "./tool.js";
export type { Tool, ToolConfig } from "./tool.js";

// Skill definition — bundles of prompt + tools + knowledge base (progressive disclosure)
export { skill } from "./skill.js";
export type { Skill, SkillConfig, SkillActivation } from "./skill.js";

// History persistence
export { JsonFileHistory } from "./history.js";
export type { HistoryStore, ConversationRecord } from "./history.js";
export type { MemoryConfig } from "./config/agent.js";
export type { MemoryOp, MemoryOpsEvent, AgentMemory, MemoryHit, MemoryContact, MemoryFact } from "./domain/agent.js";

// WhatsApp session
export { WhatsAppSession } from "./domain/wa-session.js";

export { Agent } from "./domain/agent.js";
export type {
    AgentEvents,
} from "./domain/agent.js";

export type {
    AgentConfig,
    PhoneNumberConfig,
    ChannelConfig,
    WhatsAppChannelConfig,
    VoiceShortcut,
    STTShortcut,
    InterruptionShortcut,
} from "./config/agent.js";

export { Call } from "./domain/call.js";
export type { CallEvents, CallInit, SayResult, LineTranscriptEntry, ReplyOptions, ForwardOptions, SSEResponse, StreamSSEOptions } from "./domain/call.js";

// Phone lines — a number you program, with no model behind it.
export { PhoneLine, LineCall, DEFAULT_EXTENSION_WINDOW_MS } from "./domain/line.js";
export type {
    LineOptions,
    PhoneLineEvents,
    ExtensionTable,
    ListenOptions,
    ListenResult,
    SayOptions,
    RouteOptions,
    RouteResult,
    RouteFailureReason,
} from "./domain/line.js";

export { RingingCall } from "./domain/ringing-call.js";

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
    SonioxSTTConfig,
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
    CallRingingEvent,
    CallRejectedEvent,
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

export { speech, fetchAudioVoices, transcribe, transcribeStream, AudioApiError } from "./api/audio.js";
export type {
    SpeechOptions,
    SpeechResult,
    SpeechWord,
    SpeechDone,
    SpeechFormat,
    SpeechApiOptions,
    FetchAudioVoicesOptions,
    TranscriptionModel,
    TranscribeInput,
    TranscribeOptions,
    TranscribeApiOptions,
    TranscriptWord,
    TranscriptSegment,
    Transcription,
    StreamModel,
    TranscribeStreamOptions,
    StreamFinal,
    StreamReady,
    StreamDone,
    TranscribeStreamEvents,
    TranscribeStreamItem,
    TranscribeStream,
} from "./api/audio.js";
export type { AudioNamespace } from "./client.js";

export { fetchPhones } from "./api/phones.js";
export type { Phone as PhoneInfo, FetchPhonesOptions } from "./api/phones.js";

export { createToken } from "./api/tokens.js";
export type {
    WebRTCToken,
    TokenResponse,
    FetchWebRTCTokenOptions,
    CreateTokenOptions,
    TokenScope,
    TokenScopeOptions,
} from "./api/tokens.js";

export { fetchTwilioBalance } from "./api/balance.js";
export type {
    TwilioBalance,
    FetchTwilioBalanceOptions,
} from "./api/balance.js";

export { fetchModelAccess, hasModelAccess, fetchModelCatalog } from "./api/models.js";
export type {
    ModelAccess,
    ModelAccessReason,
    FetchModelAccessOptions,
    ListModelAccessOptions,
} from "./api/models.js";

export {
    listKnowledgeBases,
    createKnowledgeBase,
    getKnowledgeBase,
    deleteKnowledgeBase,
    reindexKnowledge,
    pushDoc,
    pushDocs,
    getDoc,
    deleteDoc,
    queryKnowledge,
    KnowledgeApiError,
    DEFAULT_PLAYGROUND_URL,
} from "./api/knowledge.js";
export type {
    KnowledgeBase,
    KnowledgeDoc,
    KnowledgeDocWithText,
    KnowledgeDocInput,
    KnowledgeHit,
    KnowledgeApiOptions,
    PushResult,
} from "./api/knowledge.js";

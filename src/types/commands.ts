/**
 * Client → Server command types — PROTOCOL.md §8, §9, §12–§14.
 */

import type { SessionConfig } from "./config.js";

// ─── Registration ────────────────────────────────────────────────────────

export interface RegisterCommand {
    event: "register";
    api_key: string;
    app_id?: string;
    mode?: "twilio" | "websocket" | "webrtc";
    config?: SessionConfig;
    phones?: Record<string, Partial<SessionConfig>>;
}

// ─── Bot Reply ───────────────────────────────────────────────────────────

export interface BotReplyCommand {
    event: "bot.reply";
    call_id: string;
    message_id: string;
    text: string;
    in_reply_to: string;
}

export interface BotReplyStreamCommand {
    event: "bot.reply.stream";
    call_id: string;
    message_id: string;
    action: "start" | "chunk" | "end";
    in_reply_to?: string;
    token?: string;
}

export interface BotCancelCommand {
    event: "bot.cancel";
    call_id: string;
    message_id?: string;
}

export interface BotClearCommand {
    event: "bot.clear";
    call_id: string;
}

// ─── Call Control ────────────────────────────────────────────────────────

export interface CallHangupCommand {
    event: "call.hangup";
    call_id: string;
}

export interface CallDialCommand {
    event: "call.dial";
    to: string;
    from: string;
    greeting?: string;
    metadata?: Record<string, unknown>;
}

export interface CallForwardCommand {
    event: "call.forward";
    call_id: string;
    to: string;
    message?: string;
    announce?: boolean;
}

export interface CallDtmfCommand {
    event: "call.dtmf";
    call_id: string;
    digits: string;
}

// ─── Config ──────────────────────────────────────────────────────────────

export interface UpdateConfigCommand {
    event: "update_config";
    config: Partial<SessionConfig>;
    phone?: string;
}

export interface UpdateSessionConfigCommand {
    event: "update_session_config";
    session_id: string;
    config: Partial<SessionConfig>;
}

// ─── Phone ───────────────────────────────────────────────────────────────

export interface AddPhoneCommand {
    event: "add_phone";
    phone: string;
    config?: Partial<SessionConfig>;
}

export interface RemovePhoneCommand {
    event: "remove_phone";
    phone: string;
}

// ─── Hold / Mute ─────────────────────────────────────────────────────────

export interface CallHoldCommand {
    event: "call.hold";
    call_id: string;
}

export interface CallUnholdCommand {
    event: "call.unhold";
    call_id: string;
}

export interface CallMuteCommand {
    event: "call.mute";
    call_id: string;
}

export interface CallUnmuteCommand {
    event: "call.unmute";
    call_id: string;
}

// ─── Heartbeat ───────────────────────────────────────────────────────────

export interface PingCommand {
    event: "ping";
}

// ─── Protocol v2 Commands ────────────────────────────────────────────────

export interface ConnectCommand {
    event: "connect";
    api_key: string;
}

export interface AgentCreateCommand {
    event: "agent.create";
    agent_id?: string;
    voice?: string | Record<string, unknown>;
    language?: string;
    stt?: string | Record<string, unknown>;
    config?: Record<string, unknown>;
}

export interface AgentResumeCommand {
    event: "agent.resume";
    agent_id: string;
}

export interface AgentConfigureCommand {
    event: "agent.configure";
    agent_id: string;
    voice?: string | Record<string, unknown>;
    language?: string;
    stt?: string | Record<string, unknown>;
    turn_detection?: string | Record<string, unknown>;
    interruption?: boolean | Record<string, unknown>;
    config?: Record<string, unknown>;
}

export interface ChannelAddCommand {
    event: "channel.add";
    agent_id: string;
    type: "phone" | "webrtc" | "mic";
    ref?: string;
    voice?: string | Record<string, unknown>;
    language?: string;
    stt?: string | Record<string, unknown>;
    config?: Record<string, unknown>;
}

export interface ChannelConfigureCommand {
    event: "channel.configure";
    agent_id: string;
    ref: string;
    voice?: string | Record<string, unknown>;
    language?: string;
    stt?: string | Record<string, unknown>;
    config?: Record<string, unknown>;
}

export interface ChannelRemoveCommand {
    event: "channel.remove";
    agent_id: string;
    ref: string;
}

export interface SessionConfigureCommand {
    event: "session.configure";
    agent_id?: string;
    session_id: string;
    voice?: string | Record<string, unknown>;
    language?: string;
    stt?: string | Record<string, unknown>;
    turn_detection?: string | Record<string, unknown>;
}

// ─── Union ───────────────────────────────────────────────────────────────

export type ClientCommand =
    | RegisterCommand
    | BotReplyCommand
    | BotReplyStreamCommand
    | BotCancelCommand
    | BotClearCommand
    | CallHangupCommand
    | CallDialCommand
    | CallForwardCommand
    | CallDtmfCommand
    | UpdateConfigCommand
    | UpdateSessionConfigCommand
    | AddPhoneCommand
    | RemovePhoneCommand
    | CallHoldCommand
    | CallUnholdCommand
    | CallMuteCommand
    | CallUnmuteCommand
    | PingCommand
    // Protocol v2
    | ConnectCommand
    | AgentCreateCommand
    | AgentResumeCommand
    | AgentConfigureCommand
    | ChannelAddCommand
    | ChannelConfigureCommand
    | ChannelRemoveCommand
    | SessionConfigureCommand;


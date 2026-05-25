/**
 * Agent configuration types — user-facing config shapes.
 *
 * These are pure type definitions with no logic.
 */

import type { SessionConfig } from "./session.js";

// ─── Shortcut types ──────────────────────────────────────────────────────

/** Voice shortcut: "elevenlabs:voiceId" or full config object. */
export type VoiceShortcut = string | Record<string, unknown>;

/** STT shortcut: "deepgram" or full config object. */
export type STTShortcut = string | Record<string, unknown>;

/** Interruption shortcut: false (disable) or config object. */
export type InterruptionShortcut = boolean | Record<string, unknown>;

// ─── Agent config ────────────────────────────────────────────────────────

export interface AgentConfig {
    voice?: VoiceShortcut;
    language?: string;
    stt?: STTShortcut;
    interruption?: InterruptionShortcut;
    /** Server-side LLM: "openai:gpt-4.1-nano" or full config object. */
    llm?: string | Record<string, unknown>;
    /** OpenAI-format tool definitions for server-side LLM. */
    tools?: Array<Record<string, unknown>>;
    config?: SessionConfig;
    /** Persist conversations to MongoDB on the voice server. */
    historySave?: boolean;
    /**
     * Allowed origins for public browser token access (WebRTC, Chat).
     *
     * When set, the token endpoint accepts browser requests from these
     * origins without an API key. Supports wildcards:
     * - `"https://mysite.com"` — exact match
     * - `"https://*.mysite.com"` — subdomain wildcard
     * - `"http://localhost:*"` — any port (dev)
     *
     * When NOT set (default), token requests require API key authentication
     * via `pc.createToken()` or `agent.createToken()`.
     */
    allowedOrigins?: string[];
}

export interface ChannelConfig {
    voice?: VoiceShortcut;
    language?: string;
    stt?: STTShortcut;
    interruption?: InterruptionShortcut;
    /** Server-side LLM: "openai:gpt-4.1-nano" or full config object. */
    llm?: string | Record<string, unknown>;
    config?: Partial<SessionConfig>;
}

/** WhatsApp channel config — credentials for Meta Cloud API. */
export interface WhatsAppChannelConfig extends ChannelConfig {
    /** Meta Phone Number ID (numeric string from API Setup). */
    phoneNumberId: string;
    /** Meta Graph API access token (permanent, not temporary). */
    accessToken: string;
    /** Webhook verification token (you choose this, must match Meta config). */
    verifyToken?: string;
    /** Meta App Secret for HMAC signature verification (recommended). */
    appSecret?: string;
}

// ─── Deploy config ───────────────────────────────────────────────────────

/** Config for `pc.deploy()` — all fields are optional. */
export interface DeployConfig extends AgentConfig {
    /** LLM model (e.g. "gpt-4.1-nano"). Enables server-side LLM. */
    model?: string;
    /** System prompt for the LLM. */
    prompt?: string;
    /**
     * Channels to register (sugar for addChannel).
     * Strings: "webrtc", "mic", "chat", or a phone number.
     *
     * @example ["webrtc", "+14155551234"]
     */
    channels?: Array<string | { type: string; ref?: string; config?: ChannelConfig }>;
}

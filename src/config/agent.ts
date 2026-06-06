/**
 * Agent configuration types — user-facing config shapes.
 *
 * These are pure type definitions with no logic.
 */

import type { SessionConfig } from "./session.js";
import type { Tool } from "../tool.js";

// ─── Shortcut types ──────────────────────────────────────────────────────

/**
 * Voice configuration.
 *
 * Use the `provider/friendly-id` format (always lowercase):
 *
 * @example
 * voice: "elevenlabs/sarah"     // ElevenLabs voice
 * voice: "cartesia/yumiko"      // Cartesia voice
 * voice: "polly/lucia"          // AWS Polly voice
 *
 * // Full config object for advanced settings:
 * voice: { provider: "elevenlabs", voice_id: "...", speed: 1.1 }
 */
export type VoiceShortcut = string | Record<string, unknown>;

/** STT shortcut: "deepgram/flux" or full config object. */
export type STTShortcut = string | Record<string, unknown>;

/** Interruption shortcut: false (disable) or config object. */
export type InterruptionShortcut = boolean | Record<string, unknown>;

// ─── Agent config ────────────────────────────────────────────────────────

export interface AgentConfig {
    voice?: VoiceShortcut;
    language?: string;
    stt?: STTShortcut;
    interruption?: InterruptionShortcut;
    /** Server-side LLM: "openai/gpt-4.1-mini" or full config object. */
    llm?: string | Record<string, unknown>;
    /** System prompt for the LLM. */
    prompt?: string;
    /** Declarative tool definitions created with `tool()`. Auto-executed on llm.tool_call. */
    tools?: Tool[];
    config?: SessionConfig;
    /**
     * Greeting spoken on every inbound `call.started`.
     * Added to LLM history by default so the model knows what was said.
     *
     * - **String**: static greeting, `addToHistory` defaults to `true`.
     * - **Object**: `{ text, addToHistory? }` for explicit control.
     * - **Function**: `(call) => string` for dynamic greetings, `addToHistory` defaults to `true`.
     *
     * @example "Hi! How can I help?"
     * @example { text: "Hi!", addToHistory: false }
     * @example async (call) => `Hello ${(await db.findByPhone(call.from)).name}!`
     */
    greeting?:
        | string
        | { text: string; addToHistory?: boolean }
        | ((call: import("../domain/call.js").Call) => string | Promise<string>);
    /**
     * Channels to register (shortcut for addChannel).
     * Strings: "webrtc", "mic", "chat", or a phone number.
     * Objects: { type, ref?, config? } for per-channel overrides.
     *
     * @example ["webrtc", "+14155551234"]
     * @example [{ type: "phone", ref: "+14155551234", config: { ringing: true } }]
     */
    channels?: Array<string | { type: string; ref?: string; config?: ChannelConfig }>;
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

// ─── Channel config ──────────────────────────────────────────────────────

export interface ChannelConfig {
    voice?: VoiceShortcut;
    language?: string;
    stt?: STTShortcut;
    interruption?: InterruptionShortcut;
    /** Server-side LLM: "openai/gpt-4.1-mini" or full config object. */
    llm?: string | Record<string, unknown>;
    config?: Partial<SessionConfig>;
    /**
     * Enable call.ringing for this channel (phone only).
     *
     * When true, inbound calls emit `call.ringing` instead of auto-accepting.
     * The SDK must call `accept()` or `reject()` on the RingingCall.
     * If neither is called within 5 seconds, the call is auto-accepted.
     *
     * Default: false (auto-accept, zero latency impact).
     */
    ringing?: boolean;
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
    /**
     * Actual WhatsApp phone number in E.164 format (e.g. "+51987654321").
     * Used by the widget to auto-generate wa.me links.
     * Optional — if not set, the WhatsApp option won't appear in the ContactHub popover.
     */
    phone?: string;
}

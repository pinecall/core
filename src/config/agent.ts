/**
 * Agent configuration types — user-facing config shapes.
 *
 * These are pure type definitions with no logic.
 */

import type { SessionConfig } from "./session.js";
import type { Tool } from "../tool.js";
import type { HistoryStore } from "../history.js";

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
    /**
     * Force the faster ElevenLabs flash model, opting out of the multilingual
     * auto-default.
     *
     * For non-English agents (any `language` other than `en`) the server
     * automatically selects `eleven_multilingual_v2` — it pronounces numbers,
     * dates, currency and accents correctly, at the cost of slightly higher
     * latency. Set `flash: true` to keep `eleven_flash_v2_5` instead (lowest
     * latency, cheaper), accepting that non-English text normalization is weaker.
     *
     * - Only affects ElevenLabs voices (no effect on Cartesia/Polly).
     * - No-op for English agents (they already default to flash).
     * - Ignored when you pin a model explicitly via the `voice` object — an
     *   explicit `voice: { model }` always wins.
     *
     * @example
     * // Spanish agent that prioritizes latency over pronunciation quality:
     * pc.agent("sofia", { voice: "elevenlabs/agus", language: "es", flash: true });
     */
    flash?: boolean;
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
     * Knowledge base (RAG) the agent grounds its answers on.
     *
     * Pass the id of a knowledge base created in the Pinecall dashboard
     * (Knowledge section). Before every LLM turn, the voice server retrieves
     * the most relevant document chunks for the user's message and injects them
     * into the prompt.
     *
     * Placement is controlled by the `{{RAG_CONTEXT}}` template variable in your
     * `prompt`: include it to decide exactly where the retrieved docs go. If the
     * prompt does NOT contain `{{RAG_CONTEXT}}`, the context is appended
     * automatically — so a knowledge base works out of the box.
     *
     * @example
     * pc.agent("docs", {
     *   knowledgeBase: "kb_1a2b3c",
     *   prompt: "You are a docs assistant.\n\n{{RAG_CONTEXT}}\n\nAnswer only from the docs above.",
     * });
     */
    knowledgeBase?: string;
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
     * Phone number to register (Twilio E.164 or SIP URI).
     *
     * @example "+14155551234"
     * @example { number: "+14155551234", ringing: true }
     */
    phoneNumber?: string | PhoneNumberConfig;
    /**
     * Multiple phone numbers with per-number config (e.g. one per language/region).
     *
     * @example ["+14155551234", "+34612345678"]
     * @example [{ number: "+14155551234", language: "en" }, { number: "+34612345678", language: "es" }]
     */
    phoneNumbers?: Array<string | PhoneNumberConfig>;
    /**
     * WhatsApp channels to register (Meta Cloud API credentials).
     *
     * @example [{ phoneNumberId: "123", accessToken: "EAA..." }]
     */
    whatsapp?: WhatsAppChannelConfig[];
    /**
     * Pluggable conversation persistence. When set, conversations are
     * auto-saved on every `call.ended`.
     *
     * Use the built-in `JsonFileHistory` for prototyping, or implement
     * `HistoryStore` for MongoDB, Postgres, or your own API.
     *
     * @example
     * ```ts
     * import { JsonFileHistory } from "@pinecall/sdk";
     * const agent = pc.agent("my-agent", {
     *     history: new JsonFileHistory("./data/calls.json"),
     * });
     * ```
     */
    history?: HistoryStore;
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

// ─── Phone number config ─────────────────────────────────────────────────

/** Per-phone-number configuration for `phoneNumber` option. */
export interface PhoneNumberConfig {
    /** Phone number in E.164 format or SIP URI. */
    number: string;
    /**
     * Enable call.ringing for this number.
     * When true, inbound calls emit `call.ringing` instead of auto-accepting.
     */
    ringing?: boolean;
    /** Per-number voice override. */
    voice?: VoiceShortcut;
    /** Per-number STT override (e.g. `"deepgram/nova-3"` for languages not supported by Flux). */
    stt?: STTShortcut;
    /** Per-number language override. */
    language?: string;
}

// ─── Channel config ──────────────────────────────────────────────────────

export interface ChannelConfig {
    voice?: VoiceShortcut;
    language?: string;
    /** Force ElevenLabs flash, opting out of the multilingual auto-default. See {@link AgentConfig.flash}. */
    flash?: boolean;
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

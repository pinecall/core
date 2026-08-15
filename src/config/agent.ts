/**
 * Agent configuration types — user-facing config shapes.
 *
 * These are pure type definitions with no logic.
 */

import type { SessionConfig } from "./session.js";
import type { Tool } from "../tool.js";
import type { Skill } from "../skill.js";
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

/** See `AgentConfig.memory`. */
export interface MemoryConfig {
    /** What is worth remembering, in the business's words. Drives the extractor. */
    remember?: string[];
    /** What must never be stored. */
    forget?: string[];
    /** `"turn"` (default): after every exchange. `"call.ended"`: one pass per call. */
    consolidate?: "turn" | "call.ended";
    /** Extractor model — small and fixed. Default `openrouter/qwen/qwen3-8b`, on the org's OpenRouter key. */
    model?: string;
    /** Metadata key(s) that identify the contact on WebRTC/chat. Default `["contactId","userId","phone"]`. */
    contactKey?: string | string[];
    /** `false` switches memory off without removing the block. */
    enabled?: boolean;
}

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
    /**
     * Default values for the prompt's `{{vars}}`, seeded server-side at agent
     * registration. They resolve on the FIRST turn (all transports, incl. chat)
     * without waiting for a per-call `setPromptVars` round-trip. Per-call
     * `setPromptVars` (in `call.preparing`) still overrides these for fresh values.
     */
    promptVars?: Record<string, string>;
    /**
     * Opt in to the pre-turn barrier: before every generation the server fires
     * `call.preparing` and HOLDS the turn until your handler answers (or the
     * budget runs out).
     *
     * Set it when the app computes values per turn — live CRM state, a catalog,
     * a clock in the tenant's timezone — and the generation must not run with
     * the previous ones.
     *
     * ```ts
     * pc.agent("front-desk", { preparing: true });                 // 1500ms budget
     * pc.agent("front-desk", { preparing: { timeoutMs: 2500 } });  // your own
     * pc.agent("front-desk", { preparing: false });                // never wait
     * ```
     *
     * - **omitted** — legacy behaviour: the server waits 150ms, and gives up on
     *   waiting entirely after a few turns with no answer. Fine for the majority
     *   of agents, which have no `call.preparing` handler at all.
     * - **`true` / `{ timeoutMs }`** — a real budget (capped at 5000ms), and a
     *   `call.preparingTimeout` event whenever it is missed. The turn resumes the
     *   instant your handler settles, so the budget is a ceiling, not a delay.
     * - **`false`** — the server never even signals. The cheapest option.
     *
     * The wait overlaps knowledge-base retrieval, so a KB-backed agent often
     * spends nothing extra at all.
     */
    preparing?: boolean | { enabled?: boolean; timeoutMs?: number };
    /**
     * IANA timezone (e.g. `"Europe/Madrid"`, `"America/Lima"`). The server
     * resolves the built-in date/time vars — `{{date}}`, `{{time}}`, `{{day}}`,
     * `{{datetime}}`, `{{date_block}}` — in THIS zone, on every transport
     * (voice, chat, WhatsApp), with no per-turn round-trip. Omit → server-local
     * (UTC). The clean way to give an agent a "location clock".
     */
    timezone?: string;
    /**
     * Use the `prompt` verbatim, with NO auto-injected guidance. Default `false`.
     *
     * When `false` (default), the server augments your prompt with house-style
     * guidance tailored to the channel — so the agent "just works" out of the box:
     *   - **voice** (phone / WebRTC): answer like a phone receptionist — natural
     *     spoken sentences, no markdown/emojis (everything is read aloud by TTS).
     *   - **chat**: clean common Markdown + tasteful emojis.
     *   - **whatsapp**: WhatsApp's own formatting (`*bold*`, `_italic_`,
     *     `~strike~`, ` ```mono``` `) — NOT standard Markdown.
     * It also injects, when the agent has `skills`, a note on using the
     * `loadSkill` / `unloadSkill` tools.
     *
     * Set `true` to take full control and disable all of that injection.
     */
    rawPrompt?: boolean;
    /** Declarative tool definitions created with `tool()`. Auto-executed on llm.tool_call. */
    tools?: Tool[];
    /**
     * Skills created with `skill()` — bundles of prompt + tools + knowledge base
     * that the LLM loads and unloads on demand (progressive disclosure).
     *
     * Skills declared here are sent to the server but kept latent: their tools
     * and instructions only reach the model once the skill is active (via the
     * `loadSkill` meta-tool, `call.loadSkill(...)`, or `activation: "always"`).
     * Their `execute` functions still run on this client regardless of visibility.
     *
     * @example
     * skills: [booking, billing, techSupport]
     */
    skills?: Skill[];
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
     * Pass a single id, or an array of ids to ground on several knowledge bases
     * at once — retrieval merges the top chunks across them by score.
     *
     * @example
     * pc.agent("docs", {
     *   knowledgeBase: "kb_1a2b3c",
     *   prompt: "You are a docs assistant.\n\n{{RAG_CONTEXT}}\n\nAnswer only from the docs above.",
     * });
     * @example
     * pc.agent("support", { knowledgeBase: ["kb_product", "kb_billing"] });
     */
    knowledgeBase?: string | string[];
    /**
     * Greeting spoken on every inbound `call.started`.
     * Added to LLM history by default so the model knows what was said.
     *
     * - **String**: static greeting, `addToHistory` defaults to `true`.
     * - **Object**: `{ text, addToHistory? }` for explicit control.
     * - **Per-language map**: `{ en: "Hi…", es: "Hola…" }` — the server picks the
     *   entry for the SESSION's language (the browser's `config.language` on
     *   webrtc, the number's channel language on phone, the sealed lang on chat).
     * - **Function**: `(call) => string` for dynamic greetings, `addToHistory` defaults to `true`.
     *
     * @example "Hi! How can I help?"
     * @example { text: "Hi!", addToHistory: false }
     * @example async (call) => `Hello ${(await db.findByPhone(call.from)).name}!`
     */
    greeting?:
        | string
        | { text: string; addToHistory?: boolean }
        | Record<string, string>
        | ((call: import("../domain/call.js").Call) => string | Promise<string>);
    /**
     * Deliver the greeting on CHAT sessions too, as the first bot message —
     * rendered by the widget, recorded in the transcript, and in the LLM
     * history so the model never introduces itself again. String/object
     * greetings only (a function greeting stays client-side and voice-only).
     *
     * Opt-in on purpose: most existing chat clients paint their own welcome
     * client-side, and flipping the default would greet those visitors twice.
     * Set it when the agent's greeting is the single source for every channel.
     */
    greetingInChat?: boolean;
    /**
     * Long-term memory per contact — facts the agent keeps ACROSS conversations
     * and hands you as they are learned.
     *
     * After each reply (or once per call, see `consolidate`) a small model reads
     * the last exchange against the facts already held about the contact and
     * returns ops — add / update / delete — which the server applies to a
     * per-contact `memory.md` on its semantic index, puts back into the prompt
     * as `{{MEMORY}}`, and emits as ONE `memory.ops` event: to `agent.on(...)`,
     * to the call log (the observer, cursor-replayable) and to the browser's
     * DataChannel. Never on the turn's own path — it runs after the bot spoke.
     *
     * Identity is the precondition: the caller's number on phone/WhatsApp; on
     * WebRTC/chat a key your backend sealed into the token (`contactKey`,
     * default `contactId` → `userId` → `phone`). No identity → inert.
     *
     * ```ts
     * pc.agent("front-desk", {
     *   prompt: "…\n## About this caller\n{{MEMORY}}",
     *   memory: {
     *     remember: ["name and preferred address", "services + preferred professional",
     *                "allergies staff must know", "contact preferences and opt-outs"],
     *     forget: ["payment details", "health beyond treatment sensitivities"],
     *     consolidate: "turn",                    // or "call.ended"
     *     model: "openrouter/qwen/qwen3-8b",       // the default; nano on purpose
     *   },
     * });
     * agent.on("memory.ops", (m) => db.upsertMany(m.ops));
     * const hits = await agent.memory.search("asked not to be called", { k: 20 });
     * ```
     */
    memory?: MemoryConfig;
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

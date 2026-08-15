/**
 * Protocol utilities — serialization helpers for the Pinecall WebSocket protocol.
 *
 * Pure functions: buildShortcutPayload, expandSTT.
 * Ported from src.bkp/utils/protocol.ts unchanged.
 */

import type { AgentConfig, ChannelConfig } from "../config/agent.js";

type ShortcutInput = AgentConfig | ChannelConfig | undefined;

/**
 * Convert SDK shortcut fields to protocol payload.
 *
 * Transforms camelCase SDK config into the snake_case wire format:
 *   { voice: "elevenlabs:abc", stt: "deepgram-flux" }
 *   → { voice: "elevenlabs:abc", stt: "deepgram-flux" }
 */
export function buildShortcutPayload(opts?: ShortcutInput): Record<string, unknown> {
    if (!opts) return {};
    const payload: Record<string, unknown> = {};

    if (opts.voice !== undefined) payload.voice = opts.voice;
    if (opts.language !== undefined) payload.language = opts.language;
    if (opts.flash !== undefined) payload.flash = opts.flash;
    if (opts.stt !== undefined) payload.stt = expandSTT(opts.stt);
    if (opts.interruption !== undefined) payload.interruption = opts.interruption;
    if (opts.llm !== undefined) payload.llm = opts.llm;
    if ((opts as any).prompt !== undefined) payload.prompt = (opts as any).prompt;
    // Default prompt {{vars}} seeded server-side at registration, so they resolve
    // on the FIRST turn (chat especially) without the per-call setPromptVars round-trip.
    if ((opts as any).promptVars !== undefined) payload.vars = (opts as any).promptVars;
    // THE greeting travels on the wire: the SERVER owns delivery on every
    // channel (voice speaks it via _send_greeting; chat emits it as the first
    // bot message when `greetingInChat` is set). client.ts strips function
    // greetings before this runs — they cannot serialize and keep the legacy
    // client-side call.say. An object greeting sends its text; per-call
    // addToHistory is not a wire concept (the server always records it).
    if ((opts as any).greeting !== undefined) {
        const g = (opts as any).greeting;
        // Three shapes reach the wire: a string; `{ text, addToHistory? }`
        // (its text — the server always records a greeting); and a
        // per-language map `{ en: "…", es: "…" }`, which travels whole so the
        // server can pick by the SESSION's language.
        payload.greeting =
            typeof g === "object" && g !== null && typeof (g as any).text === "string"
                ? (g as any).text
                : g;
    }
    if ((opts as any).greetingInChat !== undefined) payload.greetingInChat = (opts as any).greetingInChat;
    // IANA timezone → server resolves built-in {{date}}/{{time}}/{{day}}/{{date_block}}
    // in this zone (all transports), so an agent "in Madrid" reports the right hour.
    if ((opts as any).timezone !== undefined) payload.timezone = (opts as any).timezone;
    // Pre-turn barrier opt-in. camelCase timeoutMs → snake_case on the wire,
    // like every other config key; a server that predates it ignores the field
    // and keeps its legacy 150ms wait.
    if ((opts as any).preparing !== undefined) {
        payload.preparing = normalizePreparing((opts as any).preparing);
    }
    if ((opts as any).rawPrompt !== undefined) payload.raw_prompt = (opts as any).rawPrompt;
    if ((opts as any).tools !== undefined) {
        const tools = (opts as any).tools as any[];
        payload.tools = tools.map((t: any) => t._toWire ? t._toWire() : t);
    }
    if ((opts as any).skills !== undefined) {
        const skills = (opts as any).skills as any[];
        payload.skills = skills.map((s: any) => s._toWire ? s._toWire() : s);
    }
    if ((opts as any).sessionLimits !== undefined) payload.session_limits = (opts as any).sessionLimits;
    else if ((opts as any).session_limits !== undefined) payload.session_limits = (opts as any).session_limits;
    if (opts.config !== undefined) payload.config = opts.config;
    if ((opts as any).knowledgeBase !== undefined) payload.knowledge_base = (opts as any).knowledgeBase;
    if ("mode" in opts && (opts as Record<string, unknown>).mode !== undefined) {
        payload.mode = (opts as Record<string, unknown>).mode;
    }
    if ("media" in opts && (opts as Record<string, unknown>).media !== undefined) {
        payload.media = (opts as Record<string, unknown>).media;
    }

    return payload;
}

/** Normalize the `preparing` shortcut to its wire shape. */
export function normalizePreparing(
    value: boolean | { enabled?: boolean; timeoutMs?: number } | undefined,
): unknown {
    if (typeof value !== "object" || value === null) return value;
    const out: Record<string, unknown> = {};
    if (value.enabled !== undefined) out.enabled = value.enabled;
    if (value.timeoutMs !== undefined) out.timeout_ms = value.timeoutMs;
    return out;
}

/**
 * Expand STT string shortcut → object.
 *
 *   "deepgram"            → "deepgram"              (simple provider name)
 *   "deepgram:nova-3"     → { provider, model }
 *   "deepgram:nova-3:es"  → { provider, model, language }
 */
export function expandSTT(stt: string | Record<string, unknown>): string | Record<string, unknown> {
    if (typeof stt !== "string") return stt;
    const parts = stt.split(":");
    if (parts.length === 1) return stt;
    const obj: Record<string, string> = { provider: parts[0] };
    if (parts[1]) obj.model = parts[1];
    if (parts[2]) obj.language = parts[2];
    return obj;
}

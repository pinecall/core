/**
 * Protocol utilities — serialization helpers for the Pinecall WebSocket protocol.
 *
 * Moved from agent.ts to eliminate the circular dependency smell
 * where client.ts imported a utility from agent.ts.
 */

import type { AgentConfig, ChannelConfig } from "../agent.js";

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
    if (opts.stt !== undefined) payload.stt = expandSTT(opts.stt);
    if (opts.interruption !== undefined) payload.interruption = opts.interruption;
    if (opts.llm !== undefined) payload.llm = opts.llm;
    if ((opts as any).prompt !== undefined) payload.prompt = (opts as any).prompt;
    if ((opts as any).tools !== undefined) payload.tools = (opts as any).tools;
    if ((opts as any).session_limits !== undefined) payload.session_limits = (opts as any).session_limits;
    if (opts.config !== undefined) payload.config = opts.config;
    if ("mode" in opts && (opts as Record<string, unknown>).mode !== undefined) {
        payload.mode = (opts as Record<string, unknown>).mode;
    }

    return payload;
}

/**
 * Expand STT string shortcut → object.
 *
 *   "deepgram"            → "deepgram"              (simple provider name)
 *   "deepgram:nova-3"     → { provider, model }
 *   "deepgram:nova-3:es"  → { provider, model, language }
 */
function expandSTT(stt: string | Record<string, unknown>): string | Record<string, unknown> {
    if (typeof stt !== "string") return stt;
    const parts = stt.split(":");
    if (parts.length === 1) return stt;
    const obj: Record<string, string> = { provider: parts[0] };
    if (parts[1]) obj.model = parts[1];
    if (parts[2]) obj.language = parts[2];
    return obj;
}


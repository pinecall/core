/**
 * Protocol utilities — serialization helpers for the Pinecall WebSocket protocol.
 *
 * Pure functions: buildShortcutPayload, normalizePreparing, expandSTT.
 * Ported from src.bkp/utils/protocol.ts unchanged.
 *
 * This is the SECOND wire boundary of the SDK (codec.ts is the other): the one
 * place that knows the server's snake_case names for the agent config. It is
 * table-driven on purpose — one ordered list of fields, read once — so that
 * "which SDK key becomes which wire key" is data you can read in ten seconds
 * instead of a hundred lines of branching, and so the key ORDER on the wire is
 * a property of the table rather than of statement order.
 */

import type { ShortcutInput, WireAgentConfig, WirePreparing } from "./wire-config.js";

export type { ShortcutInput, WireAgentConfig, WirePreparing } from "./wire-config.js";

// ─── The table ───────────────────────────────────────────────────────────

/** One field: reads the SDK config, writes at most one wire key. */
type FieldEncoder = (opts: ShortcutInput, out: WireAgentConfig) => void;

/**
 * Declare a wire field: its key, and how to read it off the SDK config.
 *
 * `read` returning `undefined` means "the user did not set it" — the key is
 * then OMITTED, never sent as null: `agent.configure` is a patch, and a null
 * would ask the server to erase a setting the user never mentioned.
 *
 * First writer wins, which is how two spellings (`sessionLimits` and an
 * already snake_cased `session_limits`) can target the same wire key.
 */
function field<K extends keyof WireAgentConfig>(
    key: K,
    read: (opts: ShortcutInput) => WireAgentConfig[K] | undefined,
): FieldEncoder {
    return (opts, out) => {
        if (out[key] !== undefined) return;
        const value = read(opts);
        if (value !== undefined) out[key] = value;
    };
}

/**
 * SDK key → wire key, in the order the server has always received them.
 *
 * The order is not cosmetic: it is the byte order of every registration frame
 * ever sent, and tests lock it.
 */
const WIRE_FIELDS: readonly FieldEncoder[] = [
    field("voice", (o) => o.voice),
    field("language", (o) => o.language),
    field("flash", (o) => o.flash),
    field("stt", (o) => (o.stt === undefined ? undefined : expandSTT(o.stt))),
    field("interruption", (o) => o.interruption),
    field("llm", (o) => o.llm),
    field("prompt", (o) => o.prompt),
    // Default prompt {{vars}} seeded server-side at registration, so they resolve
    // on the FIRST turn (chat especially) without the per-call setPromptVars round-trip.
    field("vars", (o) => o.promptVars),
    // THE greeting travels on the wire: the SERVER owns delivery on every
    // channel (voice speaks it via _send_greeting; chat emits it as the first
    // bot message when `greetingInChat` is set). client.ts strips function
    // greetings before this runs — they cannot serialize and keep the legacy
    // client-side call.say. An object greeting sends its text; per-call
    // addToHistory is not a wire concept (the server always records it).
    field("greeting", (o) => {
        // Three shapes reach the wire: a string; `{ text, addToHistory? }`
        // (its text — the server always records a greeting); and a
        // per-language map `{ en: "…", es: "…" }`, which travels whole so the
        // server can pick by the SESSION's language.
        const g = o.greeting;
        if (g === null || g === undefined || typeof g !== "object") return g;
        return typeof g.text === "string" ? g.text : g;
    }),
    field("greetingInChat", (o) => o.greetingInChat),
    // Long-term memory declaration — the server owns extraction and storage.
    field("memory", (o) => o.memory),
    // IANA timezone → server resolves built-in {{date}}/{{time}}/{{day}}/{{date_block}}
    // in this zone (all transports), so an agent "in Madrid" reports the right hour.
    field("timezone", (o) => o.timezone),
    // Pre-turn barrier opt-in. camelCase timeoutMs → snake_case on the wire,
    // like every other config key; a server that predates it ignores the field
    // and keeps its legacy 150ms wait.
    field("preparing", (o) => normalizePreparing(o.preparing)),
    field("raw_prompt", (o) => o.rawPrompt),
    // Tools and skills know their own wire shape. The fallback keeps a plain
    // already-wire-shaped object working — JS callers and tests pass those.
    field("tools", (o) => o.tools?.map((t) => (t._toWire ? t._toWire() : t))),
    field("skills", (o) => o.skills?.map((s) => (s._toWire ? s._toWire() : s))),
    field("session_limits", (o) => o.sessionLimits),
    field("session_limits", (o) => o.session_limits),
    field("config", (o) => o.config),
    field("knowledge_base", (o) => o.knowledgeBase),
    field("mode", (o) => o.mode),
    field("media", (o) => o.media),
];

// ─── The encoder ─────────────────────────────────────────────────────────

/**
 * Convert SDK shortcut fields to protocol payload.
 *
 * Transforms camelCase SDK config into the snake_case wire format:
 *   { promptVars: { name: "Ana" }, rawPrompt: true }
 *   → { vars: { name: "Ana" }, raw_prompt: true }
 */
export function buildShortcutPayload(opts?: ShortcutInput): WireAgentConfig {
    if (!opts) return {};
    const payload: WireAgentConfig = {};
    for (const encode of WIRE_FIELDS) encode(opts, payload);
    return payload;
}

// ─── Transforms ──────────────────────────────────────────────────────────

/** Normalize the `preparing` shortcut to its wire shape. */
export function normalizePreparing(
    value: boolean | { enabled?: boolean; timeoutMs?: number } | undefined,
): boolean | WirePreparing | undefined {
    if (typeof value !== "object" || value === null) return value;
    const out: WirePreparing = {};
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

/**
 * The agent config AS THE SERVER RECEIVES IT.
 *
 * Two shapes describe the same settings and they are NOT the same type: the
 * SDK's camelCase `AgentConfig`/`ChannelConfig` (what the user writes) and the
 * snake_case blob the voice server parses. `buildShortcutPayload` is the only
 * translation between them, and it used to do it through fifteen `as any`
 * casts because neither side was declared. Both sides are declared here, so
 * the encoder is a plain typed mapping and a renamed key is a compile error
 * instead of a silently dropped field.
 *
 * Keys that look camelCase on the wire (`greetingInChat`) are NOT mistakes:
 * the server reads them that way. Changing one breaks every deployed agent.
 */

import type { SessionConfig } from "../config/session.js";
import type { AgentConfig, InterruptionShortcut, MemoryConfig, STTShortcut, VoiceShortcut } from "../config/agent.js";
import type { Tool } from "../tool.js";
import type { Skill } from "../skill.js";

// ─── The wire side ───────────────────────────────────────────────────────

/** `preparing` as it travels: the flag, or the barrier's budget in snake_case. */
export interface WirePreparing {
    enabled?: boolean;
    timeout_ms?: number;
}

/**
 * The snake_case payload merged into `agent.create`, `agent.configure`,
 * `channel.add`, `channel.configure` and `session.configure`.
 *
 * Every field is optional: the encoder emits a key only when the SDK config
 * set it, so an `agent.configure` carries exactly what changed and the server
 * keeps the rest.
 */
export interface WireAgentConfig {
    voice?: VoiceShortcut;
    language?: string;
    flash?: boolean;
    /** Always the EXPANDED form — `"deepgram:nova-3:es"` never reaches the server. */
    stt?: string | Record<string, unknown>;
    interruption?: InterruptionShortcut;
    llm?: string | Record<string, unknown>;
    prompt?: string;
    /** `promptVars` — seeded at registration so `{{vars}}` resolve on the first turn. */
    vars?: Record<string, string>;
    /**
     * A string, or a per-language map the server picks from by SESSION language.
     * A FUNCTION greeting is admitted only because `agent.update()` can hand one
     * over: it is inert on the wire (JSON.stringify drops it) and client.ts
     * strips it before registration, so the encoder passes it through rather
     * than quietly changing the payload it was given.
     */
    greeting?: AgentConfig["greeting"];
    /** camelCase ON PURPOSE — the server reads this exact key. */
    greetingInChat?: boolean;
    memory?: MemoryConfig;
    timezone?: string;
    preparing?: boolean | WirePreparing;
    raw_prompt?: boolean;
    /** Tools already through `_toWire()` — OpenAI function-calling shape. */
    tools?: unknown[];
    /** Skills already through `_toWire()`. */
    skills?: unknown[];
    session_limits?: unknown;
    config?: Partial<SessionConfig>;
    knowledge_base?: string | string[];
    /** Ad-hoc dial/bridge blobs — passed through untouched. */
    mode?: unknown;
    media?: unknown;
}

// ─── The SDK side ────────────────────────────────────────────────────────

/**
 * Every SDK-side key the encoder reads, in ONE type.
 *
 * `buildShortcutPayload` is called with an `AgentConfig`, a `ChannelConfig`, a
 * `WhatsAppChannelConfig` and with ad-hoc dial/bridge configs — no single one
 * of those declares all the fields it reads, which is exactly why the old code
 * had to cast. This interface is the union of what any of them may carry; each
 * caller's type stays structurally assignable to it.
 */
export interface ShortcutInput {
    voice?: VoiceShortcut;
    language?: string;
    flash?: boolean;
    stt?: STTShortcut;
    interruption?: InterruptionShortcut;
    llm?: string | Record<string, unknown>;
    prompt?: string;
    promptVars?: Record<string, string>;
    greeting?: AgentConfig["greeting"];
    greetingInChat?: boolean;
    memory?: MemoryConfig;
    timezone?: string;
    preparing?: boolean | { enabled?: boolean; timeoutMs?: number };
    rawPrompt?: boolean;
    /** `Tool`s from `tool()`, or already wire-shaped plain objects. */
    tools?: Tool[];
    /** `Skill`s from `skill()`, or already wire-shaped plain objects. */
    skills?: Skill[];
    sessionLimits?: unknown;
    /** Some callers hand the limits over already snake_cased; both spellings land on `session_limits`. */
    session_limits?: unknown;
    config?: Partial<SessionConfig>;
    knowledgeBase?: string | string[];
    mode?: unknown;
    media?: unknown;
}

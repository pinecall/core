/**
 * skill() — bundle prompt + tools + knowledge base into a unit the LLM can
 * load and unload on demand (progressive disclosure).
 *
 * A Skill is a named capability. When it is *active* the server:
 *   - injects its `instructions` as a dedicated section of the system prompt,
 *   - exposes its `tools` to the LLM (merged into the live tool list),
 *   - includes its `knowledgeBase` in RAG retrieval.
 * When inactive, none of that is visible to the model — keeping the prompt and
 * tool list small. Activation is driven by the model (auto-generated
 * `loadSkill` / `unloadSkill` meta-tools), by your code (`call.loadSkill(...)`),
 * or pinned with `activation: "always"`.
 *
 * Usage:
 * ```ts
 * import { skill, tool } from "@pinecall/sdk";
 * import { z } from "zod";
 *
 * const booking = skill({
 *   name: "booking",
 *   description: "Reserve, reschedule or cancel calendar appointments.",
 *   instructions: "Confirm date, time and name before booking.",
 *   tools: [getAvailableSlots, bookAppointment],
 *   knowledgeBase: "kb_booking_policies",
 * });
 *
 * pc.agent("front-desk", { tools: [endCall], skills: [booking] });
 * ```
 */

import type { Tool } from "./tool.js";

/** How a skill becomes active. */
export type SkillActivation = "model" | "manual" | "always";

// ─── Public types ────────────────────────────────────────────────────────

export interface SkillConfig {
    /** Unique id — used by `loadSkill("name")`. */
    name: string;
    /** Shown to the LLM (in the `loadSkill` meta-tool) so it knows when to load it. */
    description: string;
    /** Prompt fragment injected as a system-prompt section while the skill is active. */
    instructions?: string;
    /** Tools that become visible to the LLM while the skill is active. */
    tools?: Tool[];
    /** Knowledge base (id) added to RAG retrieval while the skill is active. */
    knowledgeBase?: string;
    /** Per-skill RAG top-k. Falls back to the agent's value when omitted. */
    ragTopK?: number;
    /**
     * Activation mode:
     *   - "model"  (default) — the LLM loads it via the `loadSkill` meta-tool.
     *   - "manual"           — only your code loads it (`call.loadSkill`).
     *   - "always"           — active from the start of every call.
     */
    activation?: SkillActivation;
}

export interface Skill {
    readonly name: string;
    readonly description: string;
    readonly instructions?: string;
    readonly tools: Tool[];
    readonly knowledgeBase?: string;
    readonly ragTopK?: number;
    readonly activation: SkillActivation;
    /** @internal Convert to wire format for the server. */
    _toWire(): Record<string, unknown>;
}

// ─── Factory ─────────────────────────────────────────────────────────────

export function skill(config: SkillConfig): Skill {
    const tools = config.tools ?? [];
    const activation = config.activation ?? "model";

    return {
        name: config.name,
        description: config.description,
        instructions: config.instructions,
        tools,
        knowledgeBase: config.knowledgeBase,
        ragTopK: config.ragTopK,
        activation,
        _toWire() {
            return {
                name: config.name,
                description: config.description,
                ...(config.instructions ? { instructions: config.instructions } : {}),
                tools: tools.map((t) => (t._toWire ? t._toWire() : t)),
                ...(config.knowledgeBase ? { knowledge_base: config.knowledgeBase } : {}),
                ...(config.ragTopK != null ? { rag_top_k: config.ragTopK } : {}),
                activation,
            };
        },
    };
}

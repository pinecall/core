/**
 * skill() — tests for the Skill API (progressive disclosure).
 *
 * Covers:
 *   - skill() factory + _toWire() (instructions, knowledge base, activation)
 *   - Agent._getTools() returns the full executable universe (global ∪ skills)
 *   - buildShortcutPayload serializes skills separately from tools
 *   - agent.update({tools}) keeps the executable universe in sync (Fase 0 fix)
 *   - call.loadSkill / unloadSkill wire + SkillHandler tracking & events
 */

import { describe, it, expect, vi } from "vitest";
import { skill } from "../src/skill.js";
import { tool } from "../src/tool.js";
import { Agent } from "../src/domain/agent.js";
import { Call } from "../src/domain/call.js";
import { buildShortcutPayload } from "../src/protocol/shortcuts.js";

function zodString(description?: string) {
    return { _def: { typeName: "ZodString", ...(description ? { description } : {}) }, parse: (v: unknown) => String(v) };
}
function zodObject(shape: Record<string, any>) {
    return {
        _def: { typeName: "ZodObject", shape: () => shape },
        parse: (v: unknown) => v as any,
    };
}

const slots = tool({
    name: "getAvailableSlots",
    description: "Get slots",
    schema: zodObject({ date: zodString() }) as any,
    execute: () => ({ slots: [] }),
});
const book = tool({
    name: "bookAppointment",
    description: "Book",
    schema: zodObject({ datetime: zodString() }) as any,
    execute: () => ({ booked: true }),
});
const endCall = tool({
    name: "endCall",
    description: "End",
    schema: zodObject({}) as any,
    execute: () => ({ ended: true }),
});

// ─── skill() factory ─────────────────────────────────────────────────────

describe("skill()", () => {
    it("creates a Skill with defaults (activation: model)", () => {
        const s = skill({ name: "booking", description: "Book stuff", tools: [slots, book] });
        expect(s.name).toBe("booking");
        expect(s.activation).toBe("model");
        expect(s.tools).toHaveLength(2);
    });

    it("_toWire() serializes instructions, tools, knowledge base", () => {
        const s = skill({
            name: "booking",
            description: "Book stuff",
            instructions: "Confirm first.",
            tools: [slots],
            knowledgeBase: "kb_booking",
            ragTopK: 4,
            activation: "model",
        });
        expect(s._toWire()).toEqual({
            name: "booking",
            description: "Book stuff",
            instructions: "Confirm first.",
            tools: [slots._toWire()],
            knowledge_base: "kb_booking",
            rag_top_k: 4,
            activation: "model",
        });
    });

    it("omits optional fields when not set", () => {
        const wire = skill({ name: "x", description: "y" })._toWire();
        expect(wire).not.toHaveProperty("instructions");
        expect(wire).not.toHaveProperty("knowledge_base");
        expect(wire).not.toHaveProperty("rag_top_k");
        expect(wire.tools).toEqual([]);
    });
});

// ─── Agent executable universe ───────────────────────────────────────────

describe("Agent._getTools() executable universe", () => {
    it("returns global tools ∪ every declared skill's tools (latent or not)", () => {
        const booking = skill({ name: "booking", description: "b", tools: [slots, book] });
        const agent = new Agent("a", { tools: [endCall], skills: [booking] }, vi.fn());
        const names = agent._getTools().map((t) => t.name).sort();
        expect(names).toEqual(["bookAppointment", "endCall", "getAvailableSlots"]);
    });

    it("dedupes tools shared between global and a skill", () => {
        const s = skill({ name: "s", description: "s", tools: [endCall] });
        const agent = new Agent("a", { tools: [endCall], skills: [s] }, vi.fn());
        expect(agent._getTools().filter((t) => t.name === "endCall")).toHaveLength(1);
    });
});

// ─── shortcut serialization ──────────────────────────────────────────────

describe("buildShortcutPayload", () => {
    it("serializes skills separately from global tools", () => {
        const booking = skill({ name: "booking", description: "b", tools: [slots] });
        const payload = buildShortcutPayload({ tools: [endCall], skills: [booking] } as any);
        expect(payload.tools).toEqual([endCall._toWire()]);
        expect(payload.skills).toEqual([booking._toWire()]);
    });

    it("serializes rawPrompt as raw_prompt (only when set)", () => {
        expect(buildShortcutPayload({ rawPrompt: true } as any).raw_prompt).toBe(true);
        expect(buildShortcutPayload({ rawPrompt: false } as any).raw_prompt).toBe(false);
        expect(buildShortcutPayload({ prompt: "hi" } as any)).not.toHaveProperty("raw_prompt");
    });
});

// ─── Fase 0: agent.update keeps #tools in sync ───────────────────────────

describe("agent.update() tool universe sync", () => {
    it("hot-reloaded tools become executable (no stale Unknown tool)", () => {
        const agent = new Agent("a", { tools: [endCall] }, vi.fn());
        expect(agent._getTools().map((t) => t.name)).toEqual(["endCall"]);
        agent.update({ tools: [slots, book] });
        expect(agent._getTools().map((t) => t.name).sort()).toEqual(["bookAppointment", "getAvailableSlots"]);
    });

    it("agent.skill() adds a skill and re-derives the universe", () => {
        const send = vi.fn();
        const agent = new Agent("a", { tools: [endCall] }, send);
        agent._flushPending(); // mark server-ready so _send hits the raw transport
        const s = agent.skill({ name: "booking", description: "b", tools: [slots] });
        expect(s.name).toBe("booking");
        expect(agent._getSkills().map((x) => x.name)).toEqual(["booking"]);
        expect(agent._getTools().map((t) => t.name).sort()).toEqual(["endCall", "getAvailableSlots"]);
        // wire message carries the skill
        const cfg = send.mock.calls.find((c) => c[0]?.event === "agent.configure");
        expect(cfg?.[0].skills?.[0].name).toBe("booking");
    });
});

// ─── call.loadSkill / SkillHandler ───────────────────────────────────────

describe("call skills", () => {
    function makeCall(send = vi.fn()) {
        return new Call({ call_id: "call-1", from: "+1", to: "+2", direction: "inbound" }, send);
    }

    it("loadSkill/unloadSkill send the right wire messages", () => {
        const send = vi.fn();
        const call = makeCall(send);
        call.loadSkill("booking");
        call.unloadSkill("booking");
        expect(send).toHaveBeenNthCalledWith(1, { event: "skill.load", call_id: "call-1", skill: "booking" });
        expect(send).toHaveBeenNthCalledWith(2, { event: "skill.unload", call_id: "call-1", skill: "booking" });
    });

    it("SkillHandler tracks activeSkills and emits on call + agent", async () => {
        const agent = new Agent("test-agent", {}, vi.fn());
        const call = makeCall();
        agent._setCall("call-1", call);

        // forward call→agent events (normally wired at call creation)
        const { forwardCallEvents } = await import("../src/dispatch/proxy.js");
        forwardCallEvents(call as any, agent as any, call);

        const onCall = vi.fn();
        const onAgent = vi.fn();
        call.on("skill.loaded", onCall);
        agent.on("skill.loaded", onAgent);

        const { SkillHandler } = await import("../src/dispatch/handlers/skill.js");
        const handler = new SkillHandler();
        const handled = handler.handle(
            { event: "skill.loaded", agent_id: "test-agent", call_id: "call-1", skill: "booking", by: "model" } as any,
            { agent: () => agent, client: { _allAgents: () => [agent] } } as any,
        );

        expect(handled).toBe(true);
        expect(call.activeSkills).toEqual(["booking"]);
        expect(onCall).toHaveBeenCalledWith({ skill: "booking", by: "model" });
        expect(onAgent).toHaveBeenCalledWith({ skill: "booking", by: "model" }, call);

        // unload clears it
        handler.handle(
            { event: "skill.unloaded", agent_id: "test-agent", call_id: "call-1", skill: "booking", by: "manual" } as any,
            { agent: () => agent, client: { _allAgents: () => [agent] } } as any,
        );
        expect(call.activeSkills).toEqual([]);
    });
});

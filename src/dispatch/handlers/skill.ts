/**
 * Skill handler — server-side skill activation events.
 *
 * Handles: skill.loaded, skill.unloaded
 *
 * The server resolves loadSkill/unloadSkill natively and notifies the SDK so it
 * can track which skills are active on a call and surface the change as events
 * on the call + agent (via proxy).
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";
import type { Agent } from "../../domain/agent.js";
import type { SkillEvent } from "../../domain/call.js";

export class SkillHandler implements EventHandler {
    readonly events = ["skill.loaded", "skill.unloaded"] as const;

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        const callId = (wire.call_id ?? "") as string;

        // Resolve the owning agent — by agent_id, else by the call it belongs to.
        let agent: Agent | null = wire.agent_id ? ctx.agent(wire.agent_id) : null;
        if (!agent && callId) {
            for (const a of ctx.client._allAgents()) {
                if (a._getCall(callId)) { agent = a; break; }
            }
        }
        if (!agent) return false;

        const event: SkillEvent = {
            skill: (wire.skill ?? "") as string,
            by: ((wire.by as string) === "manual" ? "manual" : "model"),
        };
        const loaded = wire.event === "skill.loaded";

        const call = callId ? agent._getCall(callId) : null;
        if (call) {
            call._setSkillActive(event.skill, loaded);
            // Emits on the call and, via the proxy, on the agent (with the call).
            call._emitWire(wire.event as "skill.loaded" | "skill.unloaded", event);
        } else {
            agent._emitWire(wire.event as "skill.loaded" | "skill.unloaded", event, null as any);
        }
        return true;
    }
}

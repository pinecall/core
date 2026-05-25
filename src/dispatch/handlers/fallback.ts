/**
 * Fallback handler — catches unmatched events.
 *
 * Handles: any event with a call_id that wasn't matched by a specific handler.
 * Includes hold/mute events and WebRTC auto-create logic.
 *
 * Business logic:
 *   - §7.8 Auto-create Call for WebRTC (wrt_ prefix)
 *   - Hold/mute events emit on existing call
 *   - llm.* events route to agent
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";
import { Call } from "../../domain/call.js";
import { decodeEvent } from "../../protocol/codec.js";
import { forwardCallEvents } from "../proxy.js";

export class FallbackHandler implements EventHandler {
    // Wildcard — matches anything not handled above
    readonly events = ["*", "call.held", "call.unheld", "call.muted", "call.unmuted"] as const;

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        // Hold/mute events
        if (wire.event === "call.held" || wire.event === "call.unheld" ||
            wire.event === "call.muted" || wire.event === "call.unmuted") {
            return this.#handleHoldMute(wire, ctx);
        }

        // For unmatched events with an agent_id and call_id, try to route
        const agent = wire.agent_id ? ctx.agent(wire.agent_id) : null;
        if (!agent) return false;

        const callId = wire.call_id as string;
        if (!callId) {
            // Agent-level event with no call — emit as raw on agent
            if (wire.event.startsWith("llm.")) {
                agent._emitWire(wire.event as any, decodeEvent(wire));
                return true;
            }
            return false;
        }

        let call = agent._getCall(callId);

        // Auto-create for WebRTC calls (wrt_ prefix) that arrive before call.started
        if (!call && callId.startsWith("wrt_")) {
            call = new Call(
                {
                    call_id: callId,
                    from: "webrtc",
                    to: agent.id,
                    direction: "inbound",
                    transport: "webrtc",
                },
                (data) => agent.send(data),
            );
            agent._setCall(callId, call);
            forwardCallEvents(call, agent, call);
            agent._emitWire("call.started", call);
        }

        if (call) {
            // Route unmatched events to the call
            call._emitWire(wire.event as any, decodeEvent(wire));
            return true;
        }

        return false;
    }

    #handleHoldMute(wire: WireEvent, ctx: DispatchContext): boolean {
        const agent = wire.agent_id ? ctx.agent(wire.agent_id) : null;
        if (!agent) return false;

        const callId = wire.call_id as string;
        if (!callId) return false;

        const call = agent._getCall(callId);
        if (!call) return false;

        switch (wire.event) {
            case "call.held":
                call._emitWire("call.held");
                return true;
            case "call.unheld":
                call._emitWire("call.unheld");
                return true;
            case "call.muted":
                call._emitWire("call.muted");
                return true;
            case "call.unmuted":
                call._emitWire("call.unmuted", (wire.muted_transcript ?? null) as string | null);
                return true;
            default:
                return false;
        }
    }
}

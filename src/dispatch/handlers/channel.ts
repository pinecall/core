/**
 * Channel handler — channel lifecycle events.
 *
 * Handles: channel.added, channel.configured, channel.removed
 * Simple emit-on-agent passthrough.
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";

export class ChannelHandler implements EventHandler {
    readonly events = ["channel.added", "channel.configured", "channel.removed"] as const;

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        const agentId = wire.agent_id;
        if (!agentId) return false;

        const agent = ctx.agent(agentId);
        if (!agent) return false;

        switch (wire.event) {
            case "channel.added":
                agent._emitWire("channel.added", wire.type as string, wire.ref as string);
                return true;

            case "channel.configured":
                agent._emitWire("channel.configured", wire.ref as string);
                return true;

            case "channel.removed":
                agent._emitWire("channel.removed", wire.ref as string);
                return true;

            default:
                return false;
        }
    }
}

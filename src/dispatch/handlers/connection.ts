/**
 * Connection handler — server-side agent lifecycle events.
 *
 * Handles: connected, authenticated, pong, agent.displaced,
 *          agent.created, agent.configured, agent.resumed
 *
 * Business logic ported from client.ts:
 *   - §7.5 reconnect re-registration: on agent.created/resumed → _flushPending
 *   - agent.displaced: emit on agent + client
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";

export class ConnectionHandler implements EventHandler {
    readonly events = [
        "connected",
        "authenticated",
        "pong",
        "agent.displaced",
        "agent.created",
        "agent.configured",
        "agent.resumed",
    ] as const;

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        switch (wire.event) {
            case "connected":
                // Server confirmed auth — finalize connection
                ctx.onConnected();
                return true;

            case "authenticated":
                // Additional auth confirmation — no further action needed
                return true;

            case "pong":
                return true;

            case "agent.displaced": {
                const agentId = wire.agent_id;
                if (!agentId) return false;
                const agent = ctx.agent(agentId);
                if (agent) {
                    agent._emitWire("channel.removed" as any, wire.reason ?? "displaced");
                    ctx.logger.warn(`Agent ${agent.id} displaced: ${wire.reason}`);
                }
                return true;
            }

            case "agent.created":
            case "agent.resumed": {
                const agentId = wire.agent_id;
                if (!agentId) return false;
                const agent = ctx.agent(agentId);
                if (agent) {
                    // Re-register channels and flush pending messages
                    agent._flushPending();
                    agent._emitWire("ready");
                    ctx.logger.info(`Agent ${agent.id} ${wire.event === "agent.created" ? "created" : "resumed"}`);
                }
                return true;
            }

            case "agent.configured": {
                // Server acknowledged agent.configure — no-op
                return true;
            }

            default:
                return false;
        }
    }
}

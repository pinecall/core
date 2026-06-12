/**
 * Error handler — server error events.
 *
 * Business logic ported from client.ts:
 *   - PHONE_IN_USE: warn + remove channel from agent
 *   - AGENT_IN_USE: warn (agent removed by server)
 *   - All other errors: emit on client
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";

export class ErrorHandler implements EventHandler {
    readonly events = ["error"] as const;

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        const errorMsg = (wire.error ?? wire.message ?? "Unknown error") as string;
        const code = wire.code as string | undefined;

        // PHONE_IN_USE — a phone number is already claimed by another agent
        if (code === "PHONE_IN_USE" || errorMsg.includes("PHONE_IN_USE")) {
            const phone = wire.phone as string | undefined;
            const agentId = wire.agent_id as string | undefined;
            console.warn(
                `[pinecall] Phone ${phone || "?"} is already in use by another agent. ` +
                `Removing from ${agentId || "this agent"}.`,
            );
            // Remove the channel from the local agent if we can identify it
            if (agentId) {
                const agent = ctx.agent(agentId);
                if (agent && phone) {
                    agent._getChannels().delete(phone);
                }
            }
            return true;
        }

        // AGENT_IN_USE — the agent slug is already registered by another connection
        if (code === "AGENT_IN_USE" || errorMsg.includes("AGENT_IN_USE")) {
            const agentId = wire.agent_id as string | undefined;
            console.warn(
                `[pinecall] Agent "${agentId || "?"}" is already connected from another instance. ` +
                `This connection will not receive events for that agent.`,
            );
            return true;
        }

        // AGENT_CONFLICT — another live connection has the same agent slug
        if (code === "AGENT_CONFLICT") {
            const agentId = wire.agent_id as string | undefined;
            console.error(
                `\n  \x1b[91m✗\x1b[0m Agent "${agentId || "?"}" is already connected.\n` +
                `    Run \x1b[96mpinecall kick ${agentId || "<agent>"}\x1b[0m to force disconnect.\n`,
            );
            ctx.client._emitWire("error", new Error(errorMsg));
            return true;
        }

        // Generic error — emit on client
        ctx.client._emitWire("error", new Error(errorMsg));
        return true;
    }
}

/**
 * History handler — server-side conversation history events.
 *
 * Handles: history.data, history.updated
 *
 * Business logic:
 *   - §7.4 Request/response correlation via Call._applyHistoryResponse
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";

export class HistoryHandler implements EventHandler {
    readonly events = ["history.data", "history.updated"] as const;

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        const agent = wire.agent_id ? ctx.agent(wire.agent_id) : null;
        if (!agent) return false;

        const callId = wire.call_id as string;
        if (!callId) return false;

        const call = agent._getCall(callId);
        if (!call) return false;

        // Resolve the pending promise in Call
        return call._applyHistoryResponse(wire.event, wire);
    }
}

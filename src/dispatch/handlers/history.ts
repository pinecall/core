/**
 * History handler — server-side conversation history events.
 *
 * Handles: history.data, history.updated
 *
 * Business logic:
 *   - §7.4 Request/response correlation via Call._applyHistoryResponse
 *   - Also routes to WhatsAppSession for wa- prefixed call_ids
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

        // Try voice/chat Call first
        const call = agent._getCall(callId);
        if (call) {
            return call._applyHistoryResponse(wire.event, wire);
        }

        // Try WhatsApp sessions (call_id starts with "wa-")
        if (callId.startsWith("wa-")) {
            const waHandler = ctx.client._getWhatsAppHandler?.();
            if (waHandler) {
                const waSession = waHandler.getSession(callId);
                if (waSession) {
                    return waSession._applyHistoryResponse(wire.event, wire);
                }
            }
        }

        return false;
    }
}

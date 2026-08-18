/**
 * History handler — server-side conversation history events.
 *
 * Handles: history.data, history.updated
 *
 * Business logic:
 *   - §7.4 Request/response correlation via Call._applyHistoryResponse
 *   - Also routes to WhatsAppSession for wa- prefixed call_ids
 *
 * Routing note — this is why `await call.setPromptVars()` used to hang forever:
 * the server sends these acks WITHOUT an `agent_id`, and the lookup keyed on
 * one, so every ack was dropped before it reached the pending promise. Not just
 * setPromptVars: getHistory, setHistory, clearHistory, setPrompt and addContext
 * all awaited an event that could never arrive. `call_id` identifies the call
 * unambiguously across every agent on this socket, so resolve by that whenever
 * `agent_id` is absent — which also makes a current SDK work against a server
 * that hasn't been upgraded yet.
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";

export class HistoryHandler implements EventHandler {
    readonly events = ["history.data", "history.updated"] as const;

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        const callId = wire.call_id as string;
        if (!callId) return false;

        // Preferred: the agent the server named. Fallback: whichever agent on
        // this client owns the call.
        const named = wire.agent_id ? ctx.agent(wire.agent_id) : null;
        const candidates = named ? [named] : ctx.allAgents();

        for (const agent of candidates) {
            const call = agent._getCall(callId);
            if (call && call._applyHistoryResponse(wire.event, wire)) return true;
        }

        // WhatsApp sessions (call_id starts with "wa-")
        if (callId.startsWith("wa-")) {
            const waSession = ctx.whatsappSession(callId);
            if (waSession) {
                return waSession._applyHistoryResponse(wire.event, wire);
            }
        }

        return false;
    }
}

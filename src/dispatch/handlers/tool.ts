/**
 * Tool handler — server-side LLM tool call events.
 *
 * Handles: llm.tool_call (non-chat only — chat tool calls handled by chat.ts)
 *
 * Business logic:
 *   - §7.6 Filter re-emissions (server may re-send; only emit once per msgId)
 *   - Camelize tool_calls → toolCalls
 *   - Emit on call + agent (via proxy)
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";
import { decodeEvent } from "../../protocol/codec.js";
import type { ToolCallEvent, ToolCallItem } from "../../protocol/events.js";

export class ToolHandler implements EventHandler {
    readonly events = ["llm.tool_call"] as const;

    /** Track emitted msg_ids to prevent duplicate emissions. */
    #emittedMsgIds = new Set<string>();

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        // Chat tool calls are handled by the ChatHandler
        if (wire.call_id && (wire.call_id as string).startsWith("chat-")) {
            return false; // Let ChatHandler handle it
        }

        const agent = wire.agent_id ? ctx.agent(wire.agent_id) : null;
        if (!agent) return false;

        const callId = wire.call_id as string;
        if (!callId) return false;

        const call = agent._getCall(callId);
        if (!call) return false;

        const msgId = (wire.msg_id ?? wire.message_id ?? "") as string;

        // Deduplicate — server may re-send tool calls
        if (msgId && this.#emittedMsgIds.has(msgId)) {
            return true;
        }
        if (msgId) this.#emittedMsgIds.add(msgId);

        // Transform wire tool_calls → SDK toolCalls
        const rawToolCalls = (wire.tool_calls ?? []) as Array<Record<string, unknown>>;
        const toolCalls: ToolCallItem[] = rawToolCalls.map(tc => ({
            id: (tc.id ?? "") as string,
            name: (tc.name ?? (tc.function as any)?.name ?? "") as string,
            arguments: (tc.arguments ?? (tc.function as any)?.arguments ?? "{}") as string,
        }));

        const event: ToolCallEvent = {
            event: "llm.tool_call",
            callId,
            toolCalls,
            msgId,
        };

        call._emitWire("llm.tool_call", event);

        return true;
    }
}

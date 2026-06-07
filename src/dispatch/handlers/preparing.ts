/**
 * Pre-LLM handler — `llm.before` wire event → `call.preparing` SDK event.
 *
 * Handles: llm.before
 *
 * Fired by the server before EVERY LLM generation (voice, chat, WhatsApp).
 * Emits `call.preparing` on the Call so the developer can refresh per-call
 * variables via setPromptVars() — e.g. fresh date, format rules, context.
 *
 * The server waits briefly (~150ms) for a setPromptVars response before
 * proceeding, so the developer's handler runs just-in-time.
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";

export class PreparingHandler implements EventHandler {
    readonly events = ["llm.before"] as const;

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        const agent = wire.agent_id ? ctx.agent(wire.agent_id) : null;
        if (!agent) return false;

        const callId = wire.call_id as string;
        if (!callId) return false;

        const call = agent._getCall(callId);
        if (!call) return false;

        // Emit on Call + Agent — developer hooks into call.preparing
        call._emitWire("call.preparing" as any, call);
        agent._emitWire("call.preparing" as any, call);

        return true;
    }
}

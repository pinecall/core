/**
 * Memory handler — `memory.ops` from the server (see AgentConfig.memory).
 *
 * The server learned or revised something about the session's contact. Emitted
 * on the agent (the normal place to persist it) and on the call (for code that
 * follows one conversation). The payload is passed through untouched: it is
 * the same JSON the call log and the DataChannel carry.
 */
import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";

export class MemoryHandler implements EventHandler {
    readonly events = ["memory.ops"] as const;

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        const agent = wire.agent_id ? ctx.agent(wire.agent_id) : null;
        if (!agent) return false;
        const callId = (wire.call_id ?? wire.session_id) as string | undefined;
        const call = callId ? agent._getCall(callId) : undefined;
        const { event: _e, agent_id: _a, ...payload } = wire as Record<string, unknown>;
        if (call) call._emitWire("memory.ops" as any, payload);
        agent._emitWire("memory.ops", payload as any, call);
        return true;
    }
}

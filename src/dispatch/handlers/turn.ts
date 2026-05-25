/**
 * Turn handler — turn lifecycle events.
 *
 * Handles: eager.turn, turn.pause, turn.end, turn.resumed, turn.continued
 *
 * Business logic:
 *   - eager.turn: builds Turn object, calls _applyEagerTurn
 *   - turn.end: calls _applyTurnEnd (merges with last user.message state)
 *   - turn.continued: calls _applyTurnContinued (aborts active streams)
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";
import { decodeEvent } from "../../protocol/codec.js";
import type { Turn } from "../../domain/turn.js";
import type { TurnPauseEvent, TurnResumedEvent, TurnContinuedEvent } from "../../protocol/events.js";

export class TurnHandler implements EventHandler {
    readonly events = ["eager.turn", "turn.pause", "turn.end", "turn.resumed", "turn.continued"] as const;

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        const agent = wire.agent_id ? ctx.agent(wire.agent_id) : null;
        if (!agent) return false;

        const callId = wire.call_id;
        if (!callId) return false;

        const call = agent._getCall(callId);
        if (!call) return false;

        switch (wire.event) {
            case "eager.turn": {
                const turn: Turn = {
                    id: wire.turn_id as number,
                    messageId: (wire.message_id ?? "") as string,
                    text: (wire.text ?? "") as string,
                    confidence: 0,
                    probability: (wire.probability ?? 0) as number,
                    latencyMs: (wire.latency_ms ?? 0) as number,
                };
                call._applyEagerTurn(turn);
                return true;
            }

            case "turn.pause":
                call._emitWire("turn.pause", decodeEvent<TurnPauseEvent>(wire));
                return true;

            case "turn.end":
                // Delegate to Call — it merges with tracked user.message state
                call._applyTurnEnd(wire);
                return true;

            case "turn.resumed":
                call._emitWire("turn.resumed", decodeEvent<TurnResumedEvent>(wire));
                return true;

            case "turn.continued":
                call._applyTurnContinued(decodeEvent<TurnContinuedEvent>(wire));
                return true;

            default:
                return false;
        }
    }
}

/**
 * Line handler — the four events only a phone line receives.
 *
 * Handles: line.created, line.error, line.destroyed, call.routed,
 *          call.route_failed
 *
 * Everything ELSE a line gets (call.started, bot.*, turn.*, dtmf) is a
 * standard event carrying `agent_id: "line:<number>"`, and the existing
 * handlers route it unchanged — that is the whole point of registering a line
 * under an agent id. Only the registration ack and the owner swap are new.
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";
import type { PhoneLine, LineCall, RouteFailureReason } from "../../domain/line.js";

export class LineHandler implements EventHandler {
    readonly events = ["line.created", "line.error", "line.destroyed", "call.routed", "call.route_failed"] as const;

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        switch (wire.event) {
            case "line.created": {
                const line = this.#line(wire, ctx);
                if (!line) return false;
                line._markCreated();
                ctx.logger.info(`Line ${line.number} created`);
                return true;
            }

            case "line.error": {
                const line = this.#line(wire, ctx);
                if (!line) return false;
                const code = (wire.code ?? "LINE_CONFIG_ERROR") as string;
                const message = (wire.error ?? `Line ${line.number} was refused (${code})`) as string;
                line._markError(code, message);
                ctx.logger.error(`Line ${line.number} refused: ${code} — ${message}`);
                return true;
            }

            case "line.destroyed": {
                const line = this.#line(wire, ctx);
                if (!line) return false;
                ctx.logger.info(`Line ${line.number} destroyed`);
                return true;
            }

            case "call.routed": {
                const call = this.#call(wire, ctx);
                if (!call) return false;
                call._applyRouted((wire.agent ?? "") as string);
                ctx.logger.info(`Call ${call.id} routed to ${wire.agent}`);
                return true;
            }

            case "call.route_failed": {
                const call = this.#call(wire, ctx);
                if (!call) return false;
                const reason = (wire.reason ?? "swap_failed") as RouteFailureReason;
                call._applyRouteFailed((wire.agent ?? "") as string, reason);
                ctx.logger.warn(`Call ${call.id} not routed to ${wire.agent}: ${reason}`);
                return true;
            }

            default:
                return false;
        }
    }

    /** By `number` (what the line events carry) or by `agent_id` (what everything else carries). */
    #line(wire: WireEvent, ctx: DispatchContext): PhoneLine | null {
        const number = typeof wire.number === "string" ? wire.number : null;
        const agentId = typeof wire.agent_id === "string" ? wire.agent_id : null;
        for (const line of ctx.lines()) {
            if (line.number === number || line.id === agentId) return line;
        }
        return null;
    }

    /**
     * The routed call. `agent_id` names the line, but a server that omits it on
     * an answer is not worth losing a hand-over over — the call id is unique.
     */
    #call(wire: WireEvent, ctx: DispatchContext): LineCall | null {
        const callId = typeof wire.call_id === "string" ? wire.call_id : null;
        if (!callId) return null;
        for (const line of ctx.lines()) {
            const call = line._getCall(callId);
            if (call) return call;
        }
        return null;
    }
}

/**
 * WhatsApp handler — WhatsApp-specific events.
 *
 * Handles: whatsapp.message, whatsapp.response, whatsapp.status, whatsapp.session_started
 * All events camelize + emit on agent (no call involved).
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";
import { decodeEvent } from "../../protocol/codec.js";

export class WhatsAppHandler implements EventHandler {
    readonly events = [
        "whatsapp.message",
        "whatsapp.response",
        "whatsapp.status",
        "whatsapp.session_started",
    ] as const;

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        const agent = wire.agent_id ? ctx.agent(wire.agent_id) : null;
        if (!agent) return false;

        agent._emitWire(wire.event as any, decodeEvent(wire));
        return true;
    }
}

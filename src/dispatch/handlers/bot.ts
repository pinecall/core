/**
 * Bot handler — TTS playback events.
 *
 * Handles: bot.speaking, bot.word, bot.finished, bot.interrupted,
 *          message.confirmed, reply.rejected
 *
 * All events camelize + emit on call.
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";
import { decodeEvent } from "../../protocol/codec.js";
import type {
    BotSpeakingEvent,
    BotWordEvent,
    BotFinishedEvent,
    BotInterruptedEvent,
    MessageConfirmedEvent,
    ReplyRejectedEvent,
} from "../../protocol/events.js";

export class BotHandler implements EventHandler {
    readonly events = [
        "bot.speaking", "bot.word", "bot.finished", "bot.interrupted",
        "message.confirmed", "reply.rejected", "barge_in",
    ] as const;

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        const agent = wire.agent_id ? ctx.agent(wire.agent_id) : null;
        if (!agent) return false;

        const callId = wire.call_id;
        if (!callId) return false;

        const call = agent._getCall(callId);
        if (!call) return false;

        switch (wire.event) {
            case "bot.speaking":
                call._emitWire("bot.speaking", decodeEvent<BotSpeakingEvent>(wire));
                return true;

            case "bot.word":
                call._emitWire("bot.word", decodeEvent<BotWordEvent>(wire));
                return true;

            case "bot.finished":
                call._emitWire("bot.finished", decodeEvent<BotFinishedEvent>(wire));
                return true;

            case "bot.interrupted":
                call._emitWire("bot.interrupted", decodeEvent<BotInterruptedEvent>(wire));
                return true;

            case "message.confirmed":
                call._emitWire("message.confirmed", decodeEvent<MessageConfirmedEvent>(wire));
                return true;

            case "reply.rejected":
                call._emitWire("reply.rejected", decodeEvent<ReplyRejectedEvent>(wire));
                return true;

            case "barge_in":
                // barge_in is fire-and-forget, no Call-level event
                return true;

            default:
                return false;
        }
    }
}

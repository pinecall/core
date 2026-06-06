/**
 * Speech handler — STT transcript events.
 *
 * Handles: speech.started, speech.ended, user.speaking, user.message
 * All events camelize + emit on call (+ agent via proxy).
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";
import { decodeEvent } from "../../protocol/codec.js";
import type {
    SpeechStartedEvent,
    SpeechEndedEvent,
    UserSpeakingEvent,
    UserMessageEvent,
} from "../../protocol/events.js";

export class SpeechHandler implements EventHandler {
    readonly events = ["speech.started", "speech.ended", "user.speaking", "user.message"] as const;

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        const agent = wire.agent_id ? ctx.agent(wire.agent_id) : null;
        if (!agent) return false;

        const callId = wire.call_id;
        if (!callId) return false;

        const call = agent._getCall(callId);
        if (!call) return false;

        switch (wire.event) {
            case "speech.started":
                call._emitWire("speech.started", decodeEvent<SpeechStartedEvent>(wire));
                return true;

            case "speech.ended":
                call._emitWire("speech.ended", decodeEvent<SpeechEndedEvent>(wire));
                return true;

            case "user.speaking":
                call._emitWire("user.speaking", decodeEvent<UserSpeakingEvent>(wire));
                return true;

            case "user.message": {
                const event = decodeEvent<UserMessageEvent>(wire);
                call._applyUserMessage(event);
                call._pushMessage({ role: "user", content: event.text });
                return true;
            }

            default:
                return false;
        }
    }
}

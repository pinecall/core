/**
 * Session handler — session lifecycle, config, and human-in-the-loop events.
 *
 * Handles: session.idle_warning, session.timeout, session.configured,
 *          session.paused, session.resumed,
 *          session_config_updated, config_updated, phone_added, phone_removed
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";
import { decodeEvent } from "../../protocol/codec.js";
import type { SessionTimeoutEvent } from "../../protocol/events.js";

export class SessionHandler implements EventHandler {
    readonly events = [
        "session.idle_warning",
        "session.timeout",
        "session.configured",
        "session.paused",
        "session.resumed",
        "session.sent",
        "session_config_updated",
        "config_updated",
        "phone_added",
        "phone_removed",
    ] as const;

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        const agent = wire.agent_id ? ctx.agent(wire.agent_id) : null;

        switch (wire.event) {
            case "session.idle_warning": {
                if (!agent) return false;
                const callId = wire.call_id as string;
                if (!callId) return false;
                const call = agent._getCall(callId);
                if (call) {
                    call._emitWire("session.idleWarning" as any, decodeEvent(wire));
                    agent._emitWire("session.idleWarning", decodeEvent(wire), call);
                }
                return true;
            }

            case "session.timeout": {
                if (!agent) return false;
                const callId = wire.call_id as string;
                if (!callId) return false;
                const call = agent._getCall(callId);
                if (call) {
                    call._emitWire("session.timeout", decodeEvent<SessionTimeoutEvent>(wire));
                }
                return true;
            }

            case "session.configured":
            case "session.sent":
            case "session_config_updated":
            case "config_updated":
            case "phone_added":
            case "phone_removed":
                // Acknowledgments — no action needed
                return true;

            case "session.paused": {
                if (!agent) return false;
                agent._emitWire("session.paused", {
                    sessionId: (wire.session_id as string) || undefined,
                    contact: (wire.contact as string) || undefined,
                });
                return true;
            }

            case "session.resumed": {
                if (!agent) return false;
                agent._emitWire("session.resumed", {
                    sessionId: (wire.session_id as string) || undefined,
                    contact: (wire.contact as string) || undefined,
                });
                return true;
            }

            default:
                return false;
        }
    }
}

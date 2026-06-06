/**
 * Lifecycle handler — call creation and teardown.
 *
 * Handles: call.started, call.ended, call.dialing, call.error, call.forwarded
 *
 * Business logic ported from agent.ts:
 *   - §7.8 Call creation from call.started wire event
 *   - call.dialing → temp Call for outbound that hasn't connected yet
 *   - call.error → PinecallError emit on agent
 *   - call.ended → _applyEnd + cleanup
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";
import { Call } from "../../domain/call.js";
import { RingingCall } from "../../domain/ringing-call.js";
import { decodeEvent } from "../../protocol/codec.js";
import { forwardCallEvents } from "../proxy.js";
import type { CallStartedEvent, CallEndedEvent } from "../../protocol/events.js";
import type { ConversationRecord } from "../../history.js";

export class LifecycleHandler implements EventHandler {
    readonly events = ["call.started", "call.ended", "call.dialing", "call.error", "call.forwarded", "call.dtmf_sent", "call.ringing", "call.rejected"] as const;

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        const agentId = wire.agent_id;
        if (!agentId) return false;

        const agent = ctx.agent(agentId);
        if (!agent) return false;

        switch (wire.event) {
            case "call.started": {
                const callId = wire.call_id;
                if (!callId) return false;

                // Detect transport from call_id prefix or metadata
                let transport: "webrtc" | "phone" | "unknown" = "unknown";
                if (typeof wire.transport === "string") {
                    transport = wire.transport as any;
                } else if (callId.startsWith("wrt_")) {
                    transport = "webrtc";
                }

                const call = new Call(
                    {
                        call_id: callId,
                        from: (wire.from ?? "") as string,
                        to: (wire.to ?? "") as string,
                        direction: (wire.direction ?? "inbound") as "inbound" | "outbound",
                        transport,
                        metadata: wire.metadata as Record<string, unknown> | undefined,
                    },
                    (data) => agent.send(data),
                );

                // Set prompt info from agent
                call._promptsDir = (agent as any)._promptsDir ?? "prompts";

                agent._setCall(callId, call);

                // Set up event forwarding: Call → Agent → Pinecall
                forwardCallEvents(call, agent, call);

                // Emit on agent
                agent._emitWire("call.started", call);

                ctx.logger.info(`Call started: ${callId} (${wire.direction})`, {
                    agent: agent.id,
                    from: wire.from as string,
                    to: wire.to as string,
                });

                return true;
            }

            case "call.ended": {
                const callId = wire.call_id;
                if (!callId) return false;

                const call = agent._getCall(callId);
                if (!call) return true; // Already cleaned up

                const reason = (wire.reason ?? "unknown") as string;
                call._applyEnd(reason, wire);

                // Auto-save via HistoryStore if configured
                const historyStore = agent.getConfig().history;
                if (historyStore?.save && call.transcript.length > 0) {
                    // For WebRTC/Chat: use metadata.userId as contact ID if available,
                    // since call.from is just "webrtc" (not a useful identifier).
                    const contactId = (
                        call.metadata?.userId
                            ? String(call.metadata.userId)
                            : call.from
                    );
                    const record: ConversationRecord = {
                        callId: call.id,
                        agentId: agent.id,
                        channel: call.transport as ConversationRecord["channel"],
                        direction: call.direction,
                        from: contactId,
                        to: call.to,
                        startedAt: call.startedAt,
                        endedAt: call.endedAt,
                        duration: call.duration,
                        reason: call.reason,
                        transcript: call.transcript,
                        messages: call.messages,
                        metadata: call.metadata,
                    };
                    // Fire-and-forget — never block call cleanup
                    historyStore.save(record).catch((err) => {
                        ctx.logger.error(`History save failed: ${err}`, {
                            agent: agent.id,
                            callId,
                        });
                    });
                }

                agent._emitWire("call.ended", call, reason);
                agent._deleteCall(callId);

                ctx.logger.info(`Call ended: ${callId} (${reason})`, {
                    agent: agent.id,
                    duration: wire.duration_seconds,
                });

                return true;
            }

            case "call.dialing": {
                // Outbound call is being placed but hasn't connected yet
                // Create a temporary call object so events can be attached
                const callId = wire.call_id;
                if (!callId || agent._hasCall(callId)) return true;

                const call = new Call(
                    {
                        call_id: callId,
                        from: (wire.from ?? "") as string,
                        to: (wire.to ?? "") as string,
                        direction: "outbound",
                        transport: "phone",
                    },
                    (data) => agent.send(data),
                );

                agent._setCall(callId, call);
                forwardCallEvents(call, agent, call);

                return true;
            }

            case "call.error": {
                const errorMsg = (wire.error ?? "Unknown call error") as string;
                ctx.logger.error(`Call error: ${errorMsg}`, {
                    agent: agent.id,
                    callId: wire.call_id,
                });
                agent._emitWire("call.ended" as any, null as any, errorMsg);
                return true;
            }

            case "call.forwarded": {
                const callId = wire.call_id;
                if (!callId) return false;
                const call = agent._getCall(callId);
                if (call) {
                    call._emitWire("call.forwarded" as any, decodeEvent(wire));
                }
                return true;
            }

            case "call.dtmf_sent": {
                const callId = wire.call_id;
                if (!callId) return false;
                const call = agent._getCall(callId);
                if (call) {
                    call._emitWire("call.dtmf_sent" as any, decodeEvent(wire));
                }
                return true;
            }

            case "call.ringing": {
                const ringingCall = new RingingCall(
                    {
                        callId: (wire.call_id ?? "") as string,
                        from: (wire.from ?? "") as string,
                        to: (wire.to ?? "") as string,
                        agentId: agent.id,
                    },
                    (data) => agent.send(data),
                );

                agent._emitWire("call.ringing", ringingCall);

                ctx.logger.info(`Call ringing: ${wire.call_id} from ${wire.from}`, {
                    agent: agent.id,
                });

                return true;
            }

            case "call.rejected": {
                ctx.logger.info(`Call rejected: ${wire.call_id} (${wire.reason})`, {
                    agent: agent.id,
                });
                return true;
            }

            default:
                return false;
        }
    }
}

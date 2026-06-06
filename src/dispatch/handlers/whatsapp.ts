/**
 * WhatsApp handler — WhatsApp-specific events.
 *
 * Handles: whatsapp.message, whatsapp.response, whatsapp.status,
 *          whatsapp.session_started, whatsapp.session_ended
 *
 * All events emit on agent (no call involved).
 * whatsapp.session_ended triggers HistoryStore auto-save.
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";
import type { ConversationRecord } from "../../history.js";
import { decodeEvent } from "../../protocol/codec.js";

export class WhatsAppHandler implements EventHandler {
    readonly events = [
        "whatsapp.message",
        "whatsapp.response",
        "whatsapp.status",
        "whatsapp.session_started",
        "whatsapp.session_ended",
    ] as const;

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        const agent = wire.agent_id ? ctx.agent(wire.agent_id) : null;
        if (!agent) return false;

        // Auto-save WhatsApp conversations via HistoryStore
        if (wire.event === "whatsapp.session_ended") {
            const historyStore = agent.getConfig().history;
            const transcript = wire.transcript as Array<{ role: string; content: string }> | undefined;

            if (historyStore?.save && transcript && transcript.length > 0) {
                const record: ConversationRecord = {
                    callId: (wire.session_id ?? "") as string,
                    agentId: agent.id,
                    channel: "whatsapp",
                    direction: "inbound",
                    from: (wire.contact_phone ?? "") as string,
                    to: agent.id,
                    startedAt: (wire.started_at ?? 0) as number,
                    endedAt: (wire.ended_at ?? 0) as number,
                    duration: (wire.duration ?? 0) as number,
                    reason: (wire.reason ?? "unknown") as string,
                    transcript,
                    messages: (wire.messages ?? []) as Array<Record<string, unknown>>,
                    metadata: {
                        contactName: wire.contact_name,
                        messageCount: wire.message_count,
                    },
                };
                // Fire-and-forget — never block event dispatch
                historyStore.save(record).catch((err) => {
                    ctx.logger.error(`WhatsApp history save failed: ${err}`, {
                        agent: agent.id,
                        sessionId: wire.session_id,
                    });
                });
            }
        }

        agent._emitWire(wire.event as any, decodeEvent(wire));
        return true;
    }
}

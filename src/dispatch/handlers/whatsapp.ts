/**
 * WhatsApp handler — WhatsApp-specific events.
 *
 * Handles: whatsapp.message, whatsapp.response, whatsapp.status,
 *          whatsapp.session_started, whatsapp.session_ended
 *
 * All events emit on agent (no Call object involved).
 * Messages are saved incrementally via HistoryStore.
 * whatsapp.session_ended triggers the final save with status: "ended".
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";
import type { ConversationRecord, HistoryStore } from "../../history.js";
import { decodeEvent } from "../../protocol/codec.js";

/** In-memory session tracker for incremental WhatsApp saves. */
interface WaSession {
    sessionId: string;
    agentId: string;
    contactPhone: string;
    contactName: string;
    startedAt: number;
    messages: Array<Record<string, unknown>>;
    saveTimer?: ReturnType<typeof setTimeout>;
}

const DEBOUNCE_MS = 200;

export class WhatsAppHandler implements EventHandler {
    readonly events = [
        "whatsapp.message",
        "whatsapp.response",
        "whatsapp.status",
        "whatsapp.session_started",
        "whatsapp.session_ended",
    ] as const;

    /** Active sessions keyed by sessionId. */
    #sessions = new Map<string, WaSession>();

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        let agent = wire.agent_id ? ctx.agent(wire.agent_id) : null;

        // Server may omit agent_id for WhatsApp events — find the agent
        if (!agent) {
            const agents = ctx.client._allAgents();
            for (const a of agents) {
                // Match by session tracking or just use the first agent with WhatsApp channels
                const channels = a._getChannels();
                for (const [, ch] of channels) {
                    if (ch.type === "whatsapp") { agent = a; break; }
                }
                if (agent) break;
            }
        }
        if (!agent) return false;

        const historyStore = agent.getConfig().history;
        const sessionId = (wire.session_id ?? "") as string;

        switch (wire.event) {
            case "whatsapp.session_started": {
                if (sessionId && historyStore?.save) {
                    const session: WaSession = {
                        sessionId,
                        agentId: agent.id,
                        contactPhone: (wire.contact_phone ?? "") as string,
                        contactName: (wire.contact_name ?? "") as string,
                        startedAt: Date.now() / 1000,
                        messages: [],
                    };
                    this.#sessions.set(sessionId, session);
                    this.#saveNow(session, historyStore, "active");
                }
                break;
            }

            case "whatsapp.message": {
                const session = this.#sessions.get(sessionId);
                if (session && historyStore?.save) {
                    const text = (wire.text ?? "") as string;
                    if (text) {
                        session.messages.push({ role: "user", content: text });
                        this.#saveDebounced(session, historyStore);
                    }
                }
                break;
            }

            case "whatsapp.response": {
                const session = this.#sessions.get(sessionId);
                if (session && historyStore?.save) {
                    const text = (wire.text ?? "") as string;
                    const source = (wire.source ?? undefined) as string | undefined;
                    if (text) {
                        const msg: Record<string, unknown> = { role: "assistant", content: text };
                        if (source) msg.source = source; // "human" for operator messages
                        session.messages.push(msg);
                        this.#saveDebounced(session, historyStore);
                    }
                }
                break;
            }

            case "whatsapp.session_ended": {
                const session = this.#sessions.get(sessionId);
                if (historyStore?.save) {
                    // Use server's definitive data if we have it
                    const serverTranscript = wire.transcript as Array<{ role: string; content: string }> | undefined;
                    const serverMessages = wire.messages as Array<Record<string, unknown>> | undefined;

                    // Build final record
                    const messages = (serverMessages && serverMessages.length > 0)
                        ? serverMessages
                        : session?.messages ?? [];

                    const record: ConversationRecord = {
                        callId: sessionId,
                        agentId: agent.id,
                        channel: "whatsapp",
                        direction: "inbound",
                        from: (wire.contact_phone ?? session?.contactPhone ?? "") as string,
                        to: agent.id,
                        startedAt: session?.startedAt ?? (wire.started_at ?? 0) as number,
                        endedAt: (wire.ended_at ?? Date.now() / 1000) as number,
                        duration: (wire.duration ?? 0) as number,
                        reason: (wire.reason ?? "unknown") as string,
                        status: "ended",
                        transcript: serverTranscript ?? messages
                            .filter(m => (m.role === "user" || m.role === "assistant") && m.content)
                            .map(m => ({ role: m.role as string, content: m.content as string })),
                        messages,
                        metadata: {
                            contactName: wire.contact_name ?? session?.contactName,
                            messageCount: wire.message_count ?? messages.length,
                        },
                    };

                    historyStore.save(record).catch((err) => {
                        ctx.logger.error(`WhatsApp history save failed: ${err}`, {
                            agent: agent.id, sessionId,
                        });
                    });
                }

                // Clean up
                if (session?.saveTimer) clearTimeout(session.saveTimer);
                this.#sessions.delete(sessionId);
                break;
            }
        }

        agent._emitWire(wire.event as any, decodeEvent(wire));
        return true;
    }

    // ── Save helpers ─────────────────────────────────────────────────────

    #saveDebounced(session: WaSession, store: HistoryStore): void {
        if (session.saveTimer) clearTimeout(session.saveTimer);
        session.saveTimer = setTimeout(() => {
            this.#saveNow(session, store, "active");
        }, DEBOUNCE_MS);
    }

    #saveNow(session: WaSession, store: HistoryStore, status: "active" | "ended"): void {
        const record: ConversationRecord = {
            callId: session.sessionId,
            agentId: session.agentId,
            channel: "whatsapp",
            direction: "inbound",
            from: session.contactPhone,
            to: session.agentId,
            startedAt: session.startedAt,
            endedAt: 0,
            duration: 0,
            reason: "",
            status,
            transcript: session.messages
                .filter(m => (m.role === "user" || m.role === "assistant") && m.content)
                .map(m => ({ role: m.role as string, content: m.content as string })),
            messages: session.messages,
            metadata: {
                contactName: session.contactName,
                messageCount: session.messages.length,
            },
        };

        store.save(record).catch(() => { /* silently ignore */ });
    }
}

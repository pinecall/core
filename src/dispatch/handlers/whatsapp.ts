/**
 * WhatsApp handler — WhatsApp-specific events.
 *
 * Handles: whatsapp.message, whatsapp.response, whatsapp.status,
 *          whatsapp.session_started, whatsapp.session_ended
 *
 * On session_started, creates a WhatsAppSession object with history methods
 * and emits it as the event argument (like Call for voice calls).
 * Messages are saved incrementally via HistoryStore.
 * whatsapp.session_ended triggers the final save with status: "ended".
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";
import type { ConversationRecord, HistoryStore } from "../../history.js";
import { WhatsAppSession } from "../../domain/wa-session.js";
import { Call } from "../../domain/call.js";
import { decodeEvent } from "../../protocol/codec.js";
import { forwardCallEvents } from "../proxy.js";

/** In-memory session tracker for incremental WhatsApp saves. */
interface WaSession {
    sessionId: string;
    agentId: string;
    contactPhone: string;
    contactName: string;
    startedAt: number;
    messages: Array<Record<string, unknown>>;
    saveTimer?: ReturnType<typeof setTimeout>;
    /** The WhatsAppSession instance exposed to userland. */
    handle?: WhatsAppSession;
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

    /** @internal Get a WhatsAppSession handle by ID. Used by HistoryHandler. */
    getSession(sessionId: string): WhatsAppSession | undefined {
        return this.#sessions.get(sessionId)?.handle;
    }

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        let agent = wire.agent_id ? ctx.agent(wire.agent_id) : null;

        // Server may omit agent_id for WhatsApp events — find the agent
        if (!agent) {
            const agents = ctx.client._allAgents();
            for (const a of agents) {
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
                // Create the WaSession tracker
                const waSession: WaSession = {
                    sessionId,
                    agentId: agent.id,
                    contactPhone: (wire.contact_phone ?? "") as string,
                    contactName: (wire.contact_name ?? "") as string,
                    startedAt: Date.now() / 1000,
                    messages: [],
                };

                // Create the public WhatsAppSession handle with history methods
                const sendFn = (data: Record<string, unknown>) => agent!._send(data);
                waSession.handle = new WhatsAppSession(
                    {
                        sessionId,
                        agentId: agent.id,
                        contactPhone: waSession.contactPhone,
                        contactName: waSession.contactName,
                    },
                    sendFn,
                );

                this.#sessions.set(sessionId, waSession);

                // Initial save (active status)
                if (historyStore?.save) {
                    this.#saveNow(waSession, historyStore, "active");
                }

                // Auto-restore prior conversation history (fire & forget)
                if (historyStore?.findByContact) {
                    const handle = waSession.handle!;
                    const phone = waSession.contactPhone;
                    historyStore.findByContact(phone, 5).then((prior) => {
                        if (!prior || prior.length === 0) return;
                        const messages = prior
                            .reverse()
                            .flatMap((c) => c.messages)
                            .filter((m) => m.role === "user" || m.role === "assistant")
                            .slice(-20);
                        if (messages.length > 0) {
                            handle.setHistory(messages as any).catch(() => {});
                        }
                    }).catch(() => {});
                }

                // Create a Call object for universal call.started handling.
                // This lets developers write ONE call.started handler for all
                // transports (voice, chat, whatsapp) with setPromptVars, addContext, etc.
                const call = new Call(
                    {
                        call_id: sessionId,
                        from: waSession.contactPhone,
                        to: agent.id,
                        direction: "inbound",
                        transport: "whatsapp",
                    },
                    sendFn,
                );
                agent._setCall(sessionId, call);
                forwardCallEvents(call, agent, call);

                // Emit call.started — runs the developer's universal handler
                agent._emitWire("call.started", call);

                // Also emit whatsapp.sessionStarted for WA-specific handlers
                agent._emitWire("whatsapp.sessionStarted" as any, waSession.handle as any);
                return true;
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
                            agent: agent!.id, sessionId,
                        });
                    });
                }

                // Clean up
                if (session?.saveTimer) clearTimeout(session.saveTimer);
                this.#sessions.delete(sessionId);
                break;
            }
        }

        // Normalize wire event name → SDK camelCase
        const sdkEvent = wire.event === "whatsapp.session_ended"
            ? "whatsapp.sessionEnded"
            : wire.event;
        agent._emitWire(sdkEvent as any, decodeEvent(wire));
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

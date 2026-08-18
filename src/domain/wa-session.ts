/**
 * WhatsAppSession — a session handle passed to `whatsapp.sessionStarted`.
 *
 * Provides history injection methods (setHistory, addHistory, addContext, etc.)
 * that work identically to the Call equivalents, allowing WhatsApp conversations
 * to restore prior context on reconnection.
 *
 * @example
 * ```ts
 * agent.on("whatsapp.sessionStarted", async (session) => {
 *     const prior = await history.findByContact(session.contactPhone, 1);
 *     if (prior.length > 0) {
 *         await session.setHistory(prior[0].messages);
 *     }
 * });
 * ```
 */

import { Requester } from "../kernel/requester.js";

export interface WhatsAppSessionEvent {
    sessionId: string;
    agentId: string;
    contactPhone: string;
    contactName: string;
}

type SendFn = (payload: Record<string, unknown>) => void;

export class WhatsAppSession {
    /** Session ID (e.g. `"wa-70bebcaf5817"`). */
    readonly id: string;
    /** Contact phone number. */
    readonly contactPhone: string;
    /** Contact display name. */
    readonly contactName: string;
    /** Agent ID this session belongs to. */
    readonly agentId: string;

    /** @internal The request/response machine — see kernel/requester.ts. */
    readonly #requester: Requester;

    /** @internal Created by the WhatsApp dispatch handler. */
    constructor(event: WhatsAppSessionEvent, send: SendFn) {
        this.id = event.sessionId;
        this.contactPhone = event.contactPhone;
        this.contactName = event.contactName;
        this.agentId = event.agentId;
        this.#requester = new Requester({
            send,
            scopeId: this.id,
            scopeLabel: `WhatsApp session ${this.id}`,
        });
    }

    // ── History manipulation ─────────────────────────────────────────────

    /** Get the current LLM conversation history from the server. */
    getHistory(): Promise<Array<Record<string, unknown>>> {
        return Requester.handled(
            this.#requester.request("history.get", "history.data")
                .then((res) => (res.messages ?? []) as Array<Record<string, unknown>>),
        );
    }

    /** Inject messages into the server-side LLM history. */
    addHistory(messages: Array<{ role: string; content: string }>): Promise<void> {
        return Requester.handled(
            this.#requester.request("history.add", "history.updated", { messages }).then(() => {}),
        );
    }

    /** Replace the entire server-side LLM history. */
    setHistory(messages: Array<{ role: string; content: string }>): Promise<void> {
        return Requester.handled(
            this.#requester.request("history.set", "history.updated", { messages }).then(() => {}),
        );
    }

    /** Clear all messages from the server-side LLM history. */
    clearHistory(): Promise<void> {
        return Requester.handled(
            this.#requester.request("history.clear", "history.updated").then(() => {}),
        );
    }

    // ── Prompt manipulation ──────────────────────────────────────────────

    /** Replace the system prompt for this session. */
    setPrompt(text: string): Promise<void> {
        return Requester.handled(
            this.#requester.request("history.set_instructions", "history.updated", { prompt: text })
                .then(() => {}),
        );
    }

    /** Set `{{variable}}` values in the prompt template. */
    setPromptVars(vars: Record<string, string>): Promise<void> {
        return Requester.handled(
            this.#requester.request("history.set_vars", "history.updated", { vars }).then(() => {}),
        );
    }

    /** Append context after the system prompt. */
    addContext(text: string): Promise<void> {
        return Requester.handled(
            this.#requester.request("history.add_context", "history.updated", { text }).then(() => {}),
        );
    }

    // ── Internal ─────────────────────────────────────────────────────────

    /** @internal Resolve a pending history request/response promise. */
    _applyHistoryResponse(
        eventType: string,
        data: Record<string, unknown>,
    ): boolean {
        return this.#requester.applyResponse(eventType, data);
    }
}

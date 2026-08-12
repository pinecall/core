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

import { PinecallError } from "../kernel/errors.js";
import { REQUEST_TIMEOUT_MS } from "./call.js";

export interface WhatsAppSessionEvent {
    sessionId: string;
    agentId: string;
    contactPhone: string;
    contactName: string;
}

type SendFn = (payload: Record<string, unknown>) => void;

export class WhatsAppSession {
    static #requestSeq = 0;
    /** Session ID (e.g. `"wa-70bebcaf5817"`). */
    readonly id: string;
    /** Contact phone number. */
    readonly contactPhone: string;
    /** Contact display name. */
    readonly contactName: string;
    /** Agent ID this session belongs to. */
    readonly agentId: string;

    readonly #send: SendFn;
    /** Pending response resolvers for request/response events. */
    #pendingResponses = new Map<string, (data: any) => void>();

    /** @internal Created by the WhatsApp dispatch handler. */
    constructor(event: WhatsAppSessionEvent, send: SendFn) {
        this.id = event.sessionId;
        this.contactPhone = event.contactPhone;
        this.contactName = event.contactName;
        this.agentId = event.agentId;
        this.#send = send;
    }

    // ── History manipulation ─────────────────────────────────────────────

    /**
     * Mark a returned promise as handled — a fire-and-forget caller must not be
     * able to crash the process when a request goes unanswered. An `await`ing
     * caller still sees the error.
     */
    static #handled<T>(p: Promise<T>): Promise<T> {
        p.catch(() => {});
        return p;
    }

    /** Get the current LLM conversation history from the server. */
    getHistory(): Promise<Array<Record<string, unknown>>> {
        return WhatsAppSession.#handled(
            this.#request("history.get", "history.data")
                .then((res) => (res.messages ?? []) as Array<Record<string, unknown>>),
        );
    }

    /** Inject messages into the server-side LLM history. */
    addHistory(messages: Array<{ role: string; content: string }>): Promise<void> {
        return WhatsAppSession.#handled(
            this.#request("history.add", "history.updated", { messages }).then(() => {}),
        );
    }

    /** Replace the entire server-side LLM history. */
    setHistory(messages: Array<{ role: string; content: string }>): Promise<void> {
        return WhatsAppSession.#handled(
            this.#request("history.set", "history.updated", { messages }).then(() => {}),
        );
    }

    /** Clear all messages from the server-side LLM history. */
    clearHistory(): Promise<void> {
        return WhatsAppSession.#handled(
            this.#request("history.clear", "history.updated").then(() => {}),
        );
    }

    // ── Prompt manipulation ──────────────────────────────────────────────

    /** Replace the system prompt for this session. */
    setPrompt(text: string): Promise<void> {
        return WhatsAppSession.#handled(
            this.#request("history.set_instructions", "history.updated", { prompt: text })
                .then(() => {}),
        );
    }

    /** Set `{{variable}}` values in the prompt template. */
    setPromptVars(vars: Record<string, string>): Promise<void> {
        return WhatsAppSession.#handled(
            this.#request("history.set_vars", "history.updated", { vars }).then(() => {}),
        );
    }

    /** Append context after the system prompt. */
    addContext(text: string): Promise<void> {
        return WhatsAppSession.#handled(
            this.#request("history.add_context", "history.updated", { text }).then(() => {}),
        );
    }

    // ── Internal ─────────────────────────────────────────────────────────

    /**
     * @internal Send a request and wait for the matching response event.
     *
     * Same contract as `Call.#request`: correlated by `request_id` when the
     * server echoes it, and bounded by a timeout so a lost ack surfaces as a
     * rejection instead of a promise that never settles.
     */
    #request(
        sendEvent: string,
        responseEvent: string,
        data: Record<string, unknown> = {},
    ): Promise<any> {
        const requestId = `rq_${(++WhatsAppSession.#requestSeq).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const promise = new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pendingResponses.delete(responseEvent);
                this.#pendingResponses.delete(requestId);
                reject(new PinecallError(
                    `Timed out after ${REQUEST_TIMEOUT_MS}ms waiting for "${responseEvent}" ` +
                    `in reply to "${sendEvent}" on WhatsApp session ${this.id}.`,
                    "REQUEST_TIMEOUT",
                ));
            }, REQUEST_TIMEOUT_MS);
            const settle = (payload: any) => { clearTimeout(timer); resolve(payload); };
            this.#pendingResponses.set(responseEvent, settle);
            this.#pendingResponses.set(requestId, settle);
            this.#send({ event: sendEvent, call_id: this.id, request_id: requestId, ...data });
        });
        return promise.then((res) => {
            if (res?.error) {
                throw new PinecallError(
                    `"${sendEvent}" was rejected by the server on WhatsApp session ${this.id}: ${res.error}`,
                    "REQUEST_REJECTED",
                );
            }
            return res;
        });
    }

    /** @internal Resolve a pending history request/response promise. */
    _applyHistoryResponse(
        eventType: string,
        data: Record<string, unknown>,
    ): boolean {
        const requestId = data.request_id as string | undefined;
        const resolver = (requestId ? this.#pendingResponses.get(requestId) : undefined)
            ?? this.#pendingResponses.get(eventType);
        if (resolver) {
            if (requestId) this.#pendingResponses.delete(requestId);
            this.#pendingResponses.delete(eventType);
            resolver(data);
            return true;
        }
        return false;
    }
}

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

    /** Get the current LLM conversation history from the server. */
    async getHistory(): Promise<Array<Record<string, unknown>>> {
        const res = await this.#request("history.get", "history.data");
        return (res.messages ?? []) as Array<Record<string, unknown>>;
    }

    /** Inject messages into the server-side LLM history. */
    async addHistory(
        messages: Array<{ role: string; content: string }>,
    ): Promise<void> {
        await this.#request("history.add", "history.updated", { messages });
    }

    /** Replace the entire server-side LLM history. */
    async setHistory(
        messages: Array<{ role: string; content: string }>,
    ): Promise<void> {
        await this.#request("history.set", "history.updated", { messages });
    }

    /** Clear all messages from the server-side LLM history. */
    async clearHistory(): Promise<void> {
        await this.#request("history.clear", "history.updated");
    }

    // ── Prompt manipulation ──────────────────────────────────────────────

    /** Replace the system prompt for this session. */
    async setPrompt(text: string): Promise<void> {
        await this.#request("history.set_instructions", "history.updated", {
            prompt: text,
        });
    }

    /** Set `{{variable}}` values in the prompt template. */
    async setPromptVars(vars: Record<string, string>): Promise<void> {
        await this.#request("history.set_vars", "history.updated", { vars });
    }

    /** Append context after the system prompt. */
    async addContext(text: string): Promise<void> {
        await this.#request("history.add_context", "history.updated", { text });
    }

    // ── Internal ─────────────────────────────────────────────────────────

    /** @internal Send a request and wait for the matching response event. */
    #request(
        sendEvent: string,
        responseEvent: string,
        data: Record<string, unknown> = {},
    ): Promise<any> {
        return new Promise((resolve) => {
            this.#pendingResponses.set(responseEvent, resolve);
            this.#send({ event: sendEvent, call_id: this.id, ...data });
        });
    }

    /** @internal Resolve a pending history request/response promise. */
    _applyHistoryResponse(
        eventType: string,
        data: Record<string, unknown>,
    ): boolean {
        const resolver = this.#pendingResponses.get(eventType);
        if (resolver) {
            this.#pendingResponses.delete(eventType);
            resolver(data);
            return true;
        }
        return false;
    }
}

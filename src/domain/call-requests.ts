/**
 * CallRequests — the call's server-side LLM history/prompt API.
 *
 * Every method here is one round-trip: a `history.*` frame out, a
 * `history.updated` / `history.data` ack back, matched by the kernel Requester.
 * Split out of `call.ts` so the class stays a handle plus turn state; the
 * public methods on Call delegate here one-to-one, so the wire frames are the
 * same frames they always were.
 */

import { Requester } from "../kernel/requester.js";

export class CallRequests {
    #requester: Requester;

    constructor(callId: string, send: (data: Record<string, unknown>) => void) {
        this.#requester = new Requester({
            send,
            scopeId: callId,
            scopeLabel: `call ${callId}`,
        });
    }

    getHistory(): Promise<Array<{ role: string; content: string }>> {
        return Requester.handled(
            this.#requester.request("history.get", "history.data").then((res) => res.messages ?? []),
        );
    }

    addHistory(messages: Array<{ role: string; content: string }>): Promise<number> {
        return Requester.handled(
            this.#requester.request("history.add", "history.updated", { messages })
                .then((res) => res.count ?? 0),
        );
    }

    setHistory(messages: Array<{ role: string; content: string }>): Promise<number> {
        return Requester.handled(
            this.#requester.request("history.set", "history.updated", { messages })
                .then((res) => res.count ?? 0),
        );
    }

    clearHistory(): Promise<number> {
        return Requester.handled(
            this.#requester.request("history.clear", "history.updated").then((res) => res.count ?? 0),
        );
    }

    setVars(vars: Record<string, string>): Promise<number> {
        return Requester.handled(
            this.#requester.request("history.set_vars", "history.updated", { vars })
                .then((res) => res.count ?? 0),
        );
    }

    addContext(text: string): Promise<number> {
        return Requester.handled(
            this.#requester.request("history.add_context", "history.updated", { text })
                .then((res) => res.count ?? 0),
        );
    }

    setInstructions(text: string): Promise<number> {
        return Requester.handled(
            this.#requester.request("history.set_instructions", "history.updated", { prompt: text })
                .then((res) => res.count ?? 0),
        );
    }

    /** Resolve a pending request from its server ack. */
    applyResponse(eventType: string, data: Record<string, unknown>): boolean {
        return this.#requester.applyResponse(eventType, data);
    }
}

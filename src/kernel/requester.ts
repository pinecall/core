/**
 * Requester — the request/response machine used by every scope that asks the
 * server a question over the same socket it sends fire-and-forget events on.
 *
 * Call and WhatsAppSession both need it, and both used to carry their own
 * copy. The machine is small but every line of it is load-bearing, so one copy
 * is one place to fix it.
 */

import { PinecallError } from "./errors.js";

/**
 * How long a history/prompt request waits for its server ack before rejecting.
 * Generous on purpose — this is a failure detector, not a latency budget. The
 * turn's own budget is the `preparing` one, enforced server-side.
 */
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Request ids only need to be unique, never meaningful, so one module-level
 * counter serves every scope in the process.
 */
let requestSeq = 0;

export interface RequesterOptions {
    /** Puts a frame on the wire. */
    send: (data: Record<string, unknown>) => void;
    /** The id that goes into the frame's `call_id` field. */
    scopeId: string;
    /** What the error messages call this scope — "call abc", "WhatsApp session wa-x". */
    scopeLabel: string;
    timeoutMs?: number;
}

export class Requester {
    readonly #send: (data: Record<string, unknown>) => void;
    readonly #scopeId: string;
    readonly #scopeLabel: string;
    readonly #timeoutMs: number;

    /** Pending response resolvers for request/response events. */
    readonly #pending = new Map<string, (data: any) => void>();

    constructor(opts: RequesterOptions) {
        this.#send = opts.send;
        this.#scopeId = opts.scopeId;
        this.#scopeLabel = opts.scopeLabel;
        this.#timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    }

    /**
     * Send a request and wait for its response event.
     *
     * Correlated by `request_id`, which the server echoes. Two reasons:
     * concurrent requests used to overwrite each other in the pending map (they
     * all key on "history.updated"), and a late reply could resolve the wrong
     * caller. Servers that don't echo it fall back to event-name keying, which
     * is what shipped before.
     *
     * The timeout is the point: without one, an ack that never routes leaves
     * `await call.setPromptVars()` pending FOREVER, which is how the whole
     * mechanism managed to fail without anyone noticing.
     */
    request(sendEvent: string, responseEvent: string, data: Record<string, unknown> = {}): Promise<any> {
        const requestId = `rq_${(++requestSeq).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const promise = new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(responseEvent);
                this.#pending.delete(requestId);
                reject(new PinecallError(
                    `Timed out after ${this.#timeoutMs}ms waiting for "${responseEvent}" ` +
                    `in reply to "${sendEvent}" on ${this.#scopeLabel}.`,
                    "REQUEST_TIMEOUT",
                ));
            }, this.#timeoutMs);
            const settle = (payload: any) => { clearTimeout(timer); resolve(payload); };
            // Registered under BOTH keys: request_id for a server that echoes it,
            // event name for one that doesn't.
            this.#pending.set(responseEvent, settle);
            this.#pending.set(requestId, settle);
            this.#send({ event: sendEvent, call_id: this.#scopeId, request_id: requestId, ...data });
        });
        return promise.then((res) => {
            // The server acks even when it could not find a handler for the
            // call, and says so — better a rejection the app can see than the
            // silence that used to leave the promise pending for good.
            if (res?.error) {
                throw new PinecallError(
                    `"${sendEvent}" was rejected by the server on ${this.#scopeLabel}: ${res.error}`,
                    "REQUEST_REJECTED",
                );
            }
            return res;
        });
    }

    /** Resolve a pending request from a wire reply. Returns true if one matched. */
    applyResponse(eventType: string, data: Record<string, unknown>): boolean {
        // request_id first — exact correlation when the server echoes it.
        const requestId = data.request_id as string | undefined;
        const resolver = (requestId ? this.#pending.get(requestId) : undefined)
            ?? this.#pending.get(eventType);
        if (resolver) {
            if (requestId) this.#pending.delete(requestId);
            this.#pending.delete(eventType);
            resolver(data);
            return true;
        }
        return false;
    }

    /**
     * Mark a returned promise as handled so a fire-and-forget caller — the
     * overwhelmingly common shape, `call.setPromptVars(v)` with no `await` —
     * cannot bring the process down with an unhandled rejection when a request
     * fails. A caller that DOES await still receives the error.
     */
    static handled<T>(p: Promise<T>): Promise<T> {
        p.catch(() => {});
        return p;
    }
}

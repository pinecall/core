/**
 * WebSocketTransport — production Transport adapter.
 *
 * Wraps Node's `ws` (or browser `WebSocket` if `globalThis.WebSocket` exists).
 * Owns: connect timeout, stale-socket guard.
 */

import type { Transport } from "./transport.js";

export interface WebSocketTransportOptions {
    url: string;
    /** Connect timeout in ms. Default: 10000. */
    connectTimeout?: number;
}

export class WebSocketTransport implements Transport {
    readonly #url: string;
    readonly #connectTimeout: number;

    #ws: WebSocket | null = null;
    #messageHandler: ((data: Record<string, unknown>) => void) | null = null;
    #closeHandler: ((reason: string) => void) | null = null;
    #errorHandler: ((err: Error) => void) | null = null;

    constructor(opts: WebSocketTransportOptions) {
        this.#url = opts.url;
        this.#connectTimeout = opts.connectTimeout ?? 10000;
    }

    get isOpen(): boolean {
        return this.#ws?.readyState === WebSocket.OPEN;
    }

    async open(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            try {
                this.#ws = new WebSocket(this.#url);
            } catch (err) {
                reject(new Error(`Failed to create WebSocket: ${err}`));
                return;
            }

            const timeout = setTimeout(() => {
                reject(new Error(`Connection timeout: could not reach ${this.#url}`));
                try { this.#ws?.close(); } catch { /* ignore */ }
            }, this.#connectTimeout);

            this.#ws.onopen = () => {
                clearTimeout(timeout);
                resolve();
            };

            // Capture reference for stale-socket guard
            const thisSocket = this.#ws;

            this.#ws.onmessage = (evt: MessageEvent) => {
                try {
                    const data = JSON.parse(
                        typeof evt.data === "string" ? evt.data : "",
                    ) as Record<string, unknown>;
                    this.#messageHandler?.(data);
                } catch {
                    // Ignore non-JSON messages
                }
            };

            this.#ws.onclose = (evt: CloseEvent) => {
                clearTimeout(timeout);
                // Stale-socket guard: ignore onclose from a replaced socket
                if (thisSocket !== this.#ws) return;
                this.#closeHandler?.(evt.reason || "connection_lost");
            };

            this.#ws.onerror = () => {
                // onclose will fire after this — no action needed here
            };
        });
    }

    async close(code = 1000, reason = "client_disconnect"): Promise<void> {
        if (this.#ws) {
            try { this.#ws.close(code, reason); } catch { /* ignore */ }
            this.#ws = null;
        }
    }

    send(data: Record<string, unknown>): void {
        if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
            this.#ws.send(JSON.stringify(data));
        }
    }

    onMessage(handler: (data: Record<string, unknown>) => void): void {
        this.#messageHandler = handler;
    }

    onClose(handler: (reason: string) => void): void {
        this.#closeHandler = handler;
    }

    onError(handler: (err: Error) => void): void {
        this.#errorHandler = handler;
    }
}

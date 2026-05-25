/**
 * FakeTransport — in-memory Transport for tests.
 *
 * Provides manual control over received messages and simulated events.
 */

import type { Transport } from "./transport.js";

export class FakeTransport implements Transport {
    /** All messages sent through this transport. */
    readonly sentMessages: Array<Record<string, unknown>> = [];

    #open = false;
    #messageHandler: ((data: Record<string, unknown>) => void) | null = null;
    #closeHandler: ((reason: string) => void) | null = null;
    #errorHandler: ((err: Error) => void) | null = null;

    get isOpen(): boolean {
        return this.#open;
    }

    async open(): Promise<void> {
        this.#open = true;
    }

    async close(_code?: number, _reason?: string): Promise<void> {
        this.#open = false;
    }

    send(data: Record<string, unknown>): void {
        this.sentMessages.push(data);
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

    // ── Test control methods ─────────────────────────────────────────────

    /** Simulate receiving a message from the server. */
    receive(data: Record<string, unknown>): void {
        this.#messageHandler?.(data);
    }

    /** Simulate a connection close. */
    simulateClose(reason: string): void {
        this.#open = false;
        this.#closeHandler?.(reason);
    }

    /** Simulate a transport error. */
    simulateError(err: Error): void {
        this.#errorHandler?.(err);
    }
}

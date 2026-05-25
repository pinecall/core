/**
 * Transport — port interface for WebSocket communication.
 *
 * Domain code never imports `ws` or `WebSocket` directly.
 * It only knows `Transport`.
 */

export interface Transport {
    /** Open the connection. Resolves when ready to send. */
    open(): Promise<void>;

    /** Close the connection. Idempotent. */
    close(code?: number, reason?: string): Promise<void>;

    /** Send a JSON-encoded message. Throws if not open. */
    send(data: Record<string, unknown>): void;

    /** Subscribe to inbound messages. */
    onMessage(handler: (data: Record<string, unknown>) => void): void;

    /** Subscribe to close events. Reason is from the server or "client_close". */
    onClose(handler: (reason: string) => void): void;

    /** Subscribe to errors that don't close the connection. */
    onError(handler: (err: Error) => void): void;

    readonly isOpen: boolean;
}

/**
 * EventStream — WebSocket client for real-time agent event streaming.
 *
 * Connects to an agent's WebSocket stream (served by agent.ws()).
 * The counterpart of agent.stream() (SSE) but over WebSocket.
 *
 * Two modes:
 *   1. Direct URL — connect to your own server's WS endpoint:
 *      createEventStream({ url: "ws://localhost:3000/ws/events" })
 *
 *   2. Token-based — connect to a remote Pinecall server:
 *      createEventStream({ agent: "pines", tokenProvider: ... })
 */

export interface EventStreamOptions {
    /**
     * Direct WebSocket URL to connect to.
     * Use this when your agent app serves its own WS endpoint.
     * Example: "ws://localhost:3000/ws/events"
     */
    url?: string;
    /** Agent ID (used with tokenProvider for remote connections). */
    agent?: string;
    /** Base server URL (used with tokenProvider). Default: "https://voice.pinecall.io" */
    server?: string;
    /**
     * Token provider for authenticated remote connections.
     * Not needed when using `url` (your own server handles auth).
     */
    tokenProvider?: () => Promise<{ token: string; server?: string }>;
    /** Optional session ID to scope events. */
    sessionId?: string;
    /** Auto-reconnect on disconnect. Default: true */
    reconnect?: boolean;
    /** Maximum reconnect attempts. Default: 10 */
    maxReconnectAttempts?: number;
}

export type EventStreamStatus = "idle" | "connecting" | "connected" | "error";

type EventHandler = (data: Record<string, unknown>) => void;

export class EventStream {
    private ws: WebSocket | null = null;
    private handlers = new Map<string, Set<EventHandler>>();
    private statusHandlers = new Set<(status: EventStreamStatus) => void>();
    private _status: EventStreamStatus = "idle";
    private reconnectAttempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private destroyed = false;

    constructor(private opts: EventStreamOptions) {
        this.connect();
    }

    /** Current connection status. */
    get status(): EventStreamStatus {
        return this._status;
    }

    /** Listen for a specific agent event. Use "*" for all events. */
    on(event: string, handler: EventHandler): this {
        let set = this.handlers.get(event);
        if (!set) {
            set = new Set();
            this.handlers.set(event, set);
        }
        set.add(handler);
        return this;
    }

    /** Remove a specific event handler. */
    off(event: string, handler: EventHandler): this {
        this.handlers.get(event)?.delete(handler);
        return this;
    }

    /** Listen for status changes (connecting, connected, error). */
    onStatus(handler: (status: EventStreamStatus) => void): this {
        this.statusHandlers.add(handler);
        return this;
    }

    /** Send a message/action to the server. */
    send(payload: Record<string, unknown>): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
        }
    }

    /** Close the connection and stop reconnecting. */
    close(): void {
        this.destroyed = true;
        this.cleanup();
        this.setStatus("idle");
    }

    /** Connect (or reconnect). */
    async connect(): Promise<void> {
        if (this.destroyed) return;
        if (this.ws?.readyState === WebSocket.OPEN) return;

        this.setStatus("connecting");

        try {
            const url = await this.resolveURL();
            const ws = new WebSocket(url);
            this.ws = ws;

            ws.onopen = () => {
                this.reconnectAttempt = 0;
                this.setStatus("connected");
                this.pingTimer = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ action: "ping" }));
                    }
                }, 25_000);
            };

            ws.onmessage = (e) => {
                try {
                    const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
                    const event = msg.event as string;
                    if (!event) return;

                    const handlers = this.handlers.get(event);
                    if (handlers) for (const h of handlers) h(msg);

                    const wildcards = this.handlers.get("*");
                    if (wildcards) for (const h of wildcards) h(msg);
                } catch { /* ignore parse errors */ }
            };

            ws.onclose = () => {
                this.cleanup();
                if (!this.destroyed && (this.opts.reconnect !== false)) {
                    this.scheduleReconnect();
                } else {
                    this.setStatus("idle");
                }
            };

            ws.onerror = () => {
                this.setStatus("error");
            };
        } catch {
            this.setStatus("error");
            if (!this.destroyed && (this.opts.reconnect !== false)) {
                this.scheduleReconnect();
            }
        }
    }

    // ── Internal ──

    private async resolveURL(): Promise<string> {
        // Direct URL mode — connect to your own server
        if (this.opts.url) {
            return this.opts.url;
        }

        // Token mode — build URL from token + agent
        if (!this.opts.tokenProvider) {
            throw new Error("EventStream requires either 'url' or 'tokenProvider'");
        }
        const { token, server: tokenServer } = await this.opts.tokenProvider();
        const base = tokenServer || this.opts.server || "https://voice.pinecall.io";
        const wsBase = base.replace(/^http/, "ws");

        let url = `${wsBase}/ws/stream?token=${encodeURIComponent(token)}`;
        if (this.opts.agent) url += `&agent=${encodeURIComponent(this.opts.agent)}`;
        if (this.opts.sessionId) url += `&session=${encodeURIComponent(this.opts.sessionId)}`;
        return url;
    }

    private setStatus(s: EventStreamStatus): void {
        if (this._status === s) return;
        this._status = s;
        for (const h of this.statusHandlers) h(s);
    }

    private cleanup(): void {
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        if (this.ws) {
            this.ws.onopen = null;
            this.ws.onmessage = null;
            this.ws.onclose = null;
            this.ws.onerror = null;
            try { this.ws.close(); } catch { /* */ }
            this.ws = null;
        }
    }

    private scheduleReconnect(): void {
        const max = this.opts.maxReconnectAttempts ?? 10;
        if (this.reconnectAttempt >= max) {
            this.setStatus("error");
            return;
        }
        const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempt), 30_000);
        this.reconnectAttempt++;
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }
}

/**
 * Create a WebSocket event stream to a Pinecall agent.
 *
 * @example Direct URL (your own server with agent.ws()):
 * ```typescript
 * const stream = createEventStream({
 *   url: "ws://localhost:3000/ws/events",
 * });
 * stream.on("bot.word", (data) => console.log(data.word));
 * ```
 *
 * @example Token-based (remote):
 * ```typescript
 * const stream = createEventStream({
 *   agent: "pines",
 *   tokenProvider: async () => {
 *     const res = await fetch("/api/token?channel=stream");
 *     return res.json();
 *   },
 * });
 * ```
 */
export function createEventStream(opts: EventStreamOptions): EventStream {
    return new EventStream(opts);
}

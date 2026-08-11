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
    /**
     * Cursor to start from on the FIRST connect (CALL_LOG_SPEC.md §5).
     * Reconnects always resume from the highest `seq` actually seen, so this
     * is only for resuming a cursor you persisted across page loads.
     */
    after?: number;
    /**
     * Opt out of cursor resume. Default: false (resume is on).
     * With `false`, a reconnect asks the server for `after=<lastSeq>` and the
     * client drops anything at or below that seq — zero lost, zero
     * duplicated (§10.3).
     */
    noResume?: boolean;
}

/**
 * `caught_up` and `gap` are Call Log statuses (spec §3/§5), surfaced
 * first-class rather than left buried in the message stream: `caught_up`
 * means the backlog is drained and what follows is live; `gap` means the
 * server DECLARED it cannot serve contiguously from the requested cursor
 * (anti-Slack rule) — it is never inferred and never papered over. Both are
 * transient: the stream returns to `connected` right after.
 */
export type EventStreamStatus =
    | "idle"
    | "connecting"
    | "connected"
    | "caught_up"
    | "gap"
    | "error";

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
    /** Highest Call Log `seq` seen. The resume cursor (§1: seq IS the cursor). */
    private _lastSeq = 0;
    /** False until the first connect completes — `after=` is for RE-connects. */
    private hasConnected = false;

    constructor(private opts: EventStreamOptions) {
        if (typeof opts.after === "number") this._lastSeq = opts.after;
        this.connect();
    }

    /** Current connection status. */
    get status(): EventStreamStatus {
        return this._status;
    }

    /**
     * The cursor: the highest `seq` this stream has delivered. Persist it to
     * resume across page loads via `after`.
     */
    get lastSeq(): number {
        return this._lastSeq;
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
                this.hasConnected = true;
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
                    // Legacy stream frames carry `event`; Call Log envelopes
                    // carry `type` (spec §1). One socket, both shapes.
                    const event = (msg.event ?? msg.type) as string;
                    if (!event) return;

                    // §1: consumers MUST dedupe by seq. After a resume the
                    // server may re-send from the last checkpoint it knows;
                    // anything at or below our cursor was already delivered.
                    const seq = msg.seq;
                    if (typeof seq === "number" && this.opts.noResume !== true) {
                        if (seq <= this._lastSeq) return;
                        this._lastSeq = seq;
                    }

                    // §3/§5 statuses. Surfaced, then back to `connected` —
                    // they are moments in the stream, not connection states.
                    if (event === "log.caught_up") {
                        this.setStatus("caught_up");
                        this.setStatus("connected");
                    } else if (event === "log.gap") {
                        this.setStatus("gap");
                        this.setStatus("connected");
                    }

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
            return this.withCursor(this.opts.url);
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
        return this.withCursor(url);
    }

    /**
     * Append the resume cursor — on RE-connects only (§5: "reconnect = same
     * URL with the last seen seq"). The first connect is left byte-identical
     * to what this SDK has always sent, unless the caller explicitly passed
     * `after`, so a server that knows nothing about cursors is unaffected.
     */
    private withCursor(url: string): string {
        if (this.opts.noResume === true) return url;
        const firstConnectWithExplicitAfter =
            !this.hasConnected && typeof this.opts.after === "number";
        if (!this.hasConnected && !firstConnectWithExplicitAfter) return url;
        if (this._lastSeq <= 0) return url;
        const sep = url.includes("?") ? "&" : "?";
        return `${url}${sep}after=${this._lastSeq}`;
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

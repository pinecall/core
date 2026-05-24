/**
 * Pinecall — connection manager.
 *
 * Manages the WebSocket connection, handles auth, reconnection, ping/pong,
 * and multiplexes events to Agent instances.
 *
 * Usage:
 *   const pc = new Pinecall({ apiKey: "pk_..." });
 *   await pc.connect();
 *
 *   const sales = pc.agent("sales-bot", { voice: "elevenlabs:abc" });
 *   sales.addChannel("phone", "+19035551234");
 *   sales.on("call.started", (call) => call.say("Hello!"));
 */

import { TypedEmitter } from "./utils/emitter.js";
import { Reconnector, type ReconnectOptions } from "./utils/reconnect.js";
import { Call, type Turn } from "./call.js";
import { Agent } from "./agent.js";
import { buildShortcutPayload } from "./utils/protocol.js";
import { forwardAgentEvents } from "./utils/proxy.js";
import { createMultiAgentStream, type StreamOptions } from "./sse.js";
import { appendFileSync } from "fs";
import { userInfo } from "os";
import type { ServerResponse } from "node:http";
import type { AgentConfig, ChannelConfig, AgentEvents } from "./agent.js";
import {
    fetchVoices as _fetchVoices,
    fetchPhones as _fetchPhones,
    fetchWebRTCToken as _fetchWebRTCToken,
    createToken as _createToken,
    type Voice,
    type Phone,
    type WebRTCToken,
    type TokenResponse,
    type FetchVoicesOptions,
    type FetchPhonesOptions,
    type FetchWebRTCTokenOptions,
    type CreateTokenOptions,
} from "./api.js";
import type {
    CallStartedEvent,
    SpeechStartedEvent,
    SpeechEndedEvent,
    UserSpeakingEvent,
    UserMessageEvent,
    EagerTurnEvent,
    TurnPauseEvent,
    TurnEndEvent,
    TurnResumedEvent,
    TurnContinuedEvent,
    BotSpeakingEvent,
    BotWordEvent,
    BotFinishedEvent,
    BotInterruptedEvent,
    MessageConfirmedEvent,
    ReplyRejectedEvent,
    AudioMetricsEvent,
} from "./types/events.js";

// Re-export shortcut types from agent
export type {
    VoiceShortcut,
    STTShortcut,
    InterruptionShortcut,
    AgentConfig,
    ChannelConfig,
} from "./agent.js";

// ─── Deploy config ───────────────────────────────────────────────────────

/** Config for `pc.deploy()` — all fields are optional. */
export interface DeployConfig extends AgentConfig {
    /** LLM model (e.g. \"gpt-4.1-nano\"). Enables server-side LLM. */
    model?: string;
    /** System prompt for the LLM. */
    prompt?: string;
    /** Phone numbers to register as channels. */
    phones?: string[];
    /**
     * Channels to register (sugar for addChannel).
     * Strings: "webrtc", "mic", "chat", or a phone number.
     *
     * @example ["webrtc", "+14155551234"]
     */
    channels?: Array<string | { type: string; ref?: string; config?: ChannelConfig }>;
}

// ─── Event map ───────────────────────────────────────────────────────────

export interface PinecallEvents {
    [key: string]: (...args: any[]) => void;
    // Connection lifecycle
    connected: () => void;
    disconnected: (reason: string) => void;
    reconnecting: (attempt: number) => void;
    error: (error: PinecallError) => void;

    // Agent-level events (proxied for single-agent convenience)
    "call.started": (call: Call) => void;
    "call.ended": (call: Call, reason: string) => void;
    "speech.started": (event: SpeechStartedEvent, call: Call) => void;
    "speech.ended": (event: SpeechEndedEvent, call: Call) => void;
    "user.speaking": (event: UserSpeakingEvent, call: Call) => void;
    "user.message": (event: UserMessageEvent, call: Call) => void;
    "eager.turn": (turn: Turn, call: Call) => void;
    "turn.pause": (event: TurnPauseEvent, call: Call) => void;
    "turn.end": (turn: Turn, call: Call) => void;
    "turn.resumed": (event: TurnResumedEvent, call: Call) => void;
    "turn.continued": (event: TurnContinuedEvent, call: Call) => void;
    "bot.speaking": (event: BotSpeakingEvent, call: Call) => void;
    "bot.word": (event: BotWordEvent, call: Call) => void;
    "bot.finished": (event: BotFinishedEvent, call: Call) => void;
    "bot.interrupted": (event: BotInterruptedEvent, call: Call) => void;
    "message.confirmed": (event: MessageConfirmedEvent, call: Call) => void;
    "reply.rejected": (event: ReplyRejectedEvent, call: Call) => void;
    "audio.metrics": (event: AudioMetricsEvent, call: Call) => void;
}

// ─── Options ─────────────────────────────────────────────────────────────

export interface PinecallOptions {
    /** Your Pinecall API key. */
    apiKey: string;

    /** WebSocket URL. Default: "wss://voice.pinecall.io/client" */
    url?: string;

    /** Reconnection. true = defaults, false = disabled, or custom options. */
    reconnect?: boolean | ReconnectOptions;

    /** Ping interval in ms. Default: 30000. Set 0 to disable. */
    pingInterval?: number;
}

// ─── Error class ─────────────────────────────────────────────────────────

export class PinecallError extends Error {
    readonly code: string;

    constructor(message: string, code = "UNKNOWN") {
        super(message);
        this.name = "PinecallError";
        this.code = code;
    }
}

// ─── Pinecall client ─────────────────────────────────────────────────────

export class Pinecall extends TypedEmitter<PinecallEvents> {
    private _opts: PinecallOptions;
    private _ws: WebSocket | null = null;
    private _reconnector: Reconnector | null = null;
    private _pingTimer: ReturnType<typeof setInterval> | null = null;
    private _closing = false;
    private _reconnecting = false;

    // Protocol debug log
    private _logFile: string | null = process.env.PINECALL_LOG || null;

    // Connection state
    private _connectionId = "";
    private _orgId = "";
    private _protocolVersion = "";
    private _connected = false;

    // Environment mode: prefix agent IDs to avoid colliding with production.
    // "dev" → "dev-berna-mara", "staging" → "staging-mara", "" → "mara" (production)
    private _mode = process.env.PINECALL_MODE || "";

    // Developer identity for multi-dev isolation.
    // In dev mode: "dev-{devId}-{agent}" so each developer gets a unique slug.
    // Falls back to OS username if PINECALL_DEV_ID is not set.
    private _devId = process.env.PINECALL_DEV_ID || (() => {
        try { return userInfo().username; } catch { return ""; }
    })();

    // Agent registry
    private _agents = new Map<string, Agent>();

    // Registration promise
    private _connectResolve: (() => void) | null = null;
    private _connectReject: ((err: Error) => void) | null = null;

    constructor(options: PinecallOptions) {
        super();
        this._opts = options;

        const reconnectOpt = options.reconnect ?? true;
        if (reconnectOpt) {
            const opts =
                typeof reconnectOpt === "object" ? reconnectOpt : undefined;
            this._reconnector = new Reconnector(opts);
        }
    }

    // ── Public getters ───────────────────────────────────────────────────

    get connected(): boolean {
        return this._connected;
    }

    get connectionId(): string {
        return this._connectionId;
    }

    get orgId(): string {
        return this._orgId;
    }

    get protocolVersion(): string {
        return this._protocolVersion;
    }

    /** All agents on this connection. */
    get agents(): ReadonlyMap<string, Agent> {
        return this._agents;
    }

    /** Whether running in dev mode (agent IDs prefixed with dev-). */
    get devMode(): boolean {
        return this._mode === "dev";
    }

    /**
     * Current environment mode: "dev", "staging", or "" (production).
     *
     * Set via `PINECALL_MODE` env var. In non-production modes, agent IDs
     * are prefixed so they coexist with production agents on the same server.
     *
     * In dev mode, the developer ID is also included for multi-dev isolation:
     *   `dev-berna-florencia` (not just `dev-florencia`).
     */
    get mode(): string {
        return this._mode;
    }

    /**
     * Developer identity used for agent slug isolation.
     * Set via `PINECALL_DEV_ID` env var, defaults to OS username.
     * Only relevant in dev/staging modes.
     */
    get devId(): string {
        return this._devId;
    }

    /**
     * Map local agent ID to wire ID (prefixed in non-production modes).
     *
     * Production:  "florencia"
     * Dev:         "dev-berna-florencia"  (includes devId for multi-dev)
     * Staging:     "staging-florencia"    (no devId — staging is shared)
     */
    private _wireId(id: string): string {
        if (!this._mode) return id;
        if (this._mode === "dev" && this._devId) {
            return `dev-${this._devId}-${id}`;
        }
        return `${this._mode}-${id}`;
    }

    // ── Static API helpers ────────────────────────────────────────────────

    static fetchVoices(opts?: FetchVoicesOptions): Promise<Voice[]> {
        return _fetchVoices(opts);
    }

    static fetchPhones(opts: FetchPhonesOptions): Promise<Phone[]> {
        return _fetchPhones(opts);
    }

    // ── Instance API helpers (auto-inject apiKey) ─────────────────────────

    /** Fetch available TTS voices. */
    fetchVoices(opts?: Omit<FetchVoicesOptions, "apiKey">): Promise<Voice[]> {
        return _fetchVoices(opts);
    }

    /** Fetch phone numbers on your account. */
    fetchPhones(opts?: Omit<FetchPhonesOptions, "apiKey">): Promise<Phone[]> {
        return _fetchPhones({ ...opts, apiKey: this._opts.apiKey });
    }

    /**
     * Fetch a WebRTC token for browser connections.
     *
     * Uses your API key (server-side) to get a signed token from
     * the voice server. Pass the token to the browser.
     *
     * @deprecated Use `createToken("webrtc", agentId)` instead.
     */
    getWebRTCToken(agentId: string): Promise<WebRTCToken> {
        return _fetchWebRTCToken({ agentId, apiKey: this._opts.apiKey });
    }

    /**
     * Create a signed token for browser connections (WebRTC or Chat).
     *
     * Authenticates with the voice server using your API key.
     * The returned token is short-lived and can be safely passed to
     * the browser for direct connections.
     *
     * @param channel - "webrtc" for voice, "chat" for text
     * @param agentId - Agent slug (uses wire ID with env prefix)
     *
     * @example
     * ```ts
     * // In your Express route:
     * app.get("/api/token", authMiddleware, async (req, res) => {
     *   const token = await pc.createToken("webrtc", "florencia");
     *   res.json(token);
     * });
     * ```
     */
    async createToken(channel: "webrtc" | "chat", agentId: string): Promise<TokenResponse> {
        const wireId = this._wireId(agentId);
        return _createToken({
            channel,
            agentId: wireId,
            apiKey: this._opts.apiKey,
        });
    }

    // ── Connect / Disconnect ─────────────────────────────────────────────

    /** Connect to the Pinecall server. Resolves when authenticated. */
    connect(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this._connectResolve = resolve;
            this._connectReject = reject;
            this._closing = false;
            this._openSocket();
        });
    }

    /** Gracefully disconnect. */
    async disconnect(): Promise<void> {
        this._closing = true;
        this._stopPing();
        this._reconnector?.cancel();

        if (this._ws) {
            this._ws.close(1000, "client_disconnect");
            this._ws = null;
        }

        // End all calls across all agents
        for (const agent of this._agents.values()) {
            agent._endAllCalls("disconnected");
        }
        this._connected = false;
    }

    // ── Agent factory ────────────────────────────────────────────────────

    /**
     * Create or get an agent on this connection.
     *
     * @param id - Agent ID (slug). Must be unique within your org.
     * @param config - Optional initial config (voice, language, stt, etc.)
     *
     * @example
     * const sales = pc.agent("sales-bot", {
     *   voice: "elevenlabs:abc",
     *   language: "es",
     * });
     * sales.addChannel("phone", "+19035551234");
     * sales.on("call.started", (call) => call.say("¡Hola!"));
     */
    agent(id: string, config?: AgentConfig): Agent {
        // Return existing if already created
        let existing = this._agents.get(id);
        if (existing) {
            if (config) existing.configure(config);
            return existing;
        }

        const wireId = this._wireId(id);
        const agent = new Agent(id, config ?? {}, (data) => {
            // Inject wire ID: agent uses plain slug internally, but server
            // needs the dev-prefixed ID (e.g. "dev-anais") for routing.
            if (data.agent_id === id) data.agent_id = wireId;
            this._send(data);
        }, wireId);
        this._agents.set(id, agent);

        // Wire agent to parent client for createToken()
        agent._setClient(this);

        // Proxy agent events to connection level for convenience
        forwardAgentEvents(agent, this);

        // If connected, send agent.create immediately
        if (this._connected) {
            this._send({
                event: "agent.create",
                agent_id: this._wireId(id),
                ...buildShortcutPayload(config),
                ...(config?.historySave ? { history_save: true } : {}),
                ...(config?.allowedOrigins?.length ? { allowed_origins: config.allowedOrigins } : {}),
            });
        }

        return agent;
    }

    /**
     * Deploy an agent from a plain config — no class file needed.
     *
     * Creates the agent, configures model/voice/prompt, and registers
     * phone channels. Agent config is stored client-side and auto-restored
     * on reconnect.
     *
     * @example
     * const agent = pc.deploy("support", {
     *   model: "gpt-4.1-nano",
     *   voice: "elevenlabs:EXAVITQu4vr4xnSDxMaL",
     *   prompt: "Be helpful and concise.",
     *   phones: ["+13186330963"],
     * });
     *
     * agent.on("call.started", (call) => { ... });
     */
    deploy(name: string, config: DeployConfig): Agent {
        // Extract deploy-specific fields from agent config
        const { phones, channels, model, prompt, tools, ...agentConfig } = config;

        // Build LLM config from model field
        if (model) {
            const [engine, ...rest] = model.split(":");
            agentConfig.llm = {
                engine: engine || "openai",
                model: rest.join(":") || model,
                enabled: true,
                ...(prompt ? { prompt } : {}),
            };
        } else if (prompt) {
            // No model specified but prompt given — use default model
            agentConfig.llm = {
                engine: "openai",
                model: "gpt-4.1-mini",
                enabled: true,
                prompt,
            };
        }

        // Pass through tools
        if (tools) (agentConfig as any).tools = tools;

        // Create the core agent with agentConfig
        const agent = this.agent(name, agentConfig);

        // Register phone channels (legacy)
        if (phones) {
            for (const phone of phones) {
                agent.addChannel("phone", phone);
            }
        }

        // Register channels (new sugar)
        if (channels) {
            for (const ch of channels) {
                if (typeof ch === "string") {
                    if (ch === "webrtc" || ch === "mic" || ch === "chat" || ch === "whatsapp") {
                        agent.addChannel(ch);
                    } else {
                        // Assume phone number
                        agent.addChannel("phone", ch);
                    }
                } else {
                    agent.addChannel(
                        ch.type as "phone" | "webrtc" | "mic" | "chat" | "whatsapp",
                        ch.ref,
                        ch.config,
                    );
                }
            }
        }

        return agent;
    }

    /**
     * Remove an agent — unregisters from the voice server and deletes locally.
     *
     * Useful for dynamic agent management (DB-driven scenarios).
     *
     * @example
     * pc.removeAgent("old-bot");
     */
    removeAgent(id: string): boolean {
        const agent = this._agents.get(id);
        if (!agent) return false;

        // End all active calls on this agent
        agent._endAllCalls("agent_removed");

        // Notify voice server
        if (this._connected) {
            this._send({
                event: "agent.remove",
                agent_id: this._wireId(id),
            });
        }

        this._agents.delete(id);
        return true;
    }

    /**
     * Get a registered agent by ID.
     *
     * @example
     * const agent = pc.getAgent("mara");
     */
    getAgent(id: string): Agent | undefined {
        return this._agents.get(id);
    }

    // ── Event Streaming ───────────────────────────────────────────────────

    /**
     * Stream events from all (or filtered) agents as SSE.
     *
     * @example
     * // All agents — Remix/Next.js
     * export async function GET() {
     *   return pc.stream();
     * }
     *
     * // Filtered — only specific agents
     * export async function GET() {
     *   return pc.stream({ agents: ["mara", "julia"] });
     * }
     *
     * // Express
     * app.get("/events", (req, res) => pc.stream(res));
     * app.get("/events", (req, res) => pc.stream(res, { agents: ["mara"] }));
     */
    stream(): Response;
    stream(opts: StreamOptions): Response;
    stream(res: ServerResponse): void;
    stream(res: ServerResponse, opts: StreamOptions): void;
    stream(resOrOpts?: ServerResponse | StreamOptions, opts?: StreamOptions): Response | void {
        if (resOrOpts && typeof (resOrOpts as any).writeHead === "function") {
            return createMultiAgentStream(this._agents, resOrOpts as ServerResponse, opts);
        }
        return createMultiAgentStream(this._agents, resOrOpts as StreamOptions | undefined);
    }

    // ── Internal: WebSocket lifecycle ────────────────────────────────────

    private _openSocket(): void {
        const url = this._opts.url ?? "wss://voice.pinecall.io/client";

        try {
            this._ws = new WebSocket(url);
        } catch (err) {
            const error = new PinecallError(
                `Failed to create WebSocket: ${err}`,
                "CONNECTION_FAILED",
            );
            this._connectReject?.(error);
            this.emit("error", error);
            return;
        }

        const connectTimeout = setTimeout(() => {
            if (!this._connected && this._connectReject) {
                const error = new PinecallError(
                    `Connection timeout: could not reach ${url}`,
                    "CONNECTION_TIMEOUT",
                );
                this._connectReject(error);
                this._connectResolve = null;
                this._connectReject = null;
                this.emit("error", error);
                try { this._ws?.close(); } catch { /* ignore */ }
            }
        }, 10000);

        this._ws.onopen = () => {
            clearTimeout(connectTimeout);
            this._send({
                event: "connect",
                api_key: this._opts.apiKey,
            });
        };

        this._ws.onmessage = (evt: MessageEvent) => {
            try {
                const data = JSON.parse(
                    typeof evt.data === "string" ? evt.data : "",
                ) as Record<string, unknown>;
                this._onMessage(data);
            } catch {
                // Ignore non-JSON messages
            }
        };

        // Capture a reference to THIS socket so the onclose handler
        // can ignore events from stale (replaced) sockets.
        const thisSocket = this._ws;

        this._ws.onclose = (evt: CloseEvent) => {
            clearTimeout(connectTimeout);

            // Ignore onclose from a stale socket that was already replaced
            // by a newer reconnect attempt.
            if (thisSocket !== this._ws) return;

            this._connected = false;
            this._stopPing();

            if (this._closing) {
                this.emit("disconnected", "client_disconnect");
                return;
            }

            const reason = evt.reason || "connection_lost";
            this.emit("disconnected", reason);

            if (this._reconnector && !this._reconnecting) {
                // End active calls and reset agent state for re-registration
                for (const agent of this._agents.values()) {
                    agent._endAllCalls("connection_lost");
                }
                this._reconnecting = true;
                this._attemptReconnect().catch(() => {
                    this._connectReject?.(
                        new PinecallError("Reconnection failed", "CONNECTION_FAILED"),
                    );
                    this._connectResolve = null;
                    this._connectReject = null;
                }).finally(() => {
                    this._reconnecting = false;
                });
            } else {
                this._connectReject?.(
                    new PinecallError(`Connection lost: ${reason}`, "CONNECTION_FAILED"),
                );
                this._connectResolve = null;
                this._connectReject = null;
            }
        };

        this._ws.onerror = () => {
            // onclose will fire after this
        };
    }

    private async _attemptReconnect(): Promise<void> {
        if (this._closing || !this._reconnector) return;

        while (!this._closing) {
            const attempt = this._reconnector.attempt + 1;
            this.emit("reconnecting", attempt);

            await this._reconnector.wait();

            if (this._closing) return;

            try {
                await new Promise<void>((resolve, reject) => {
                    this._connectResolve = resolve;
                    this._connectReject = reject;
                    this._openSocket();

                    setTimeout(() => {
                        if (!this._connected) {
                            reject(new PinecallError("Reconnect timeout", "TIMEOUT"));
                        }
                    }, 10000);
                });
                this._reconnector.reset();
                return;
            } catch {
                continue;
            }
        }
    }

    // ── Internal: message routing ────────────────────────────────────────

    private _onMessage(data: Record<string, unknown>): void {
        this._log("←", data);
        const eventType = data.event as string;

        // Server sends agent_id as compound key (org_id:slug) but SDK uses plain slugs.
        // Resolve by trying direct match, then extracting slug from compound key.
        // In dev mode, server uses "dev-slug" but SDK stores by plain "slug".
        let agentId = data.agent_id as string | undefined;
        if (agentId && !this._agents.has(agentId)) {
            let slug = agentId;
            // Extract slug from compound key (org_id:slug)
            if (agentId.includes(":")) {
                slug = agentId.split(":").pop()!;
            }
            // Try direct slug match
            if (this._agents.has(slug)) {
                agentId = slug;
            }
            // Non-production mode: server uses wire ID (e.g. "dev-berna-mara") but SDK stores "mara"
            // Compute the wire prefix and strip it to find the local agent name.
            else {
                const wirePrefix = this._mode === "dev" && this._devId
                    ? `dev-${this._devId}-`
                    : this._mode ? `${this._mode}-` : "";
                if (wirePrefix && slug.startsWith(wirePrefix) && this._agents.has(slug.slice(wirePrefix.length))) {
                    agentId = slug.slice(wirePrefix.length);
                }
                // Case-insensitive fallback: server may send "Julia" but SDK stores "julia"
                else {
                    const lower = slug.toLowerCase();
                    if (this._agents.has(lower)) {
                        agentId = lower;
                    }
                }
            }
        }

        switch (eventType) {
            // ── Connected (auth success) ─────────────────────────────────
            case "connected":
                this._connectionId = (data.connection_id as string) ?? "";
                this._orgId = (data.org_id as string) ?? "";
                this._protocolVersion = (data.protocol_version as string) ?? "";
                this._connected = true;
                this._startPing();

                // Send pending agent.create for all pre-registered agents
                for (const [id, agent] of this._agents) {
                    const cfg = agent.getConfig();
                    this._send({
                        event: "agent.create",
                        agent_id: this._wireId(id),
                        ...buildShortcutPayload(cfg),
                        ...(cfg?.historySave ? { history_save: true } : {}),
                        ...(cfg?.allowedOrigins?.length ? { allowed_origins: cfg.allowedOrigins } : {}),
                    });
                }

                this._connectResolve?.();
                this._connectResolve = null;
                this._connectReject = null;
                this.emit("connected");
                break;

            // ── Agent lifecycle ──────────────────────────────────────────
            case "agent.created":
            case "agent.configured":
            case "agent.resumed": {
                const agent = this._agents.get(agentId ?? "");
                if (agent && (eventType === "agent.created" || eventType === "agent.resumed")) {
                    agent._flushPending();
                    agent._emit("ready");
                }
                break;
            }

            // ── Channel events ──────────────────────────────────────────
            case "channel.added":
            case "channel.configured":
            case "channel.removed": {
                const agent = agentId ? this._agents.get(agentId) : null;
                if (agent) agent._handleEvent(data);
                break;
            }

            // ── Call events → route to agent ────────────────────────────
            case "call.started":
            case "call.ended": {
                if (agentId) {
                    const agent = this._agents.get(agentId);
                    if (agent) agent._handleEvent(data);
                }
                break;
            }

            // ── Error ───────────────────────────────────────────────────
            case "error": {
                const code = (data.code as string) ?? "UNKNOWN";
                const err = new PinecallError(
                    data.error as string,
                    code,
                );

                // PHONE_IN_USE: non-fatal channel rejection — warn only, don't propagate as error
                if (code === "PHONE_IN_USE") {
                    const phone = (data.phone as string) ?? "";
                    const owner = (data.owner as string) ?? "unknown";
                    console.warn(
                        `\n  ⚠ Phone ${phone} is already registered by agent "${owner}".\n` +
                        `    Only one agent can own a phone number at a time.\n` +
                        `    Remove it from "${owner}" first, or use a different number.\n`,
                    );
                    // Remove the rejected phone from local agent channels
                    // so it doesn't show in the dashboard/CLI
                    if (phone) {
                        for (const agent of this._agents.values()) {
                            const channels = (agent as any)._channels as Map<string, { type: string; ref?: string }>;
                            if (channels?.has(phone)) {
                                channels.delete(phone);
                                // Notify listeners (EventServer → dashboard) that this channel was rejected
                                agent._emit("channel.removed", phone);
                            }
                        }
                    }
                    break;
                }

                // AGENT_IN_USE: agent already connected from another session — show clear error
                if (code === "AGENT_IN_USE") {
                    const agentId = (data.agent_id as string) ?? "unknown";
                    console.error(
                        `\n  ✗ Agent "${agentId}" is already connected from another session.\n` +
                        `    Only one connection per agent is allowed.\n` +
                        `    Stop the other instance first, then try again.\n`,
                    );
                    // Remove the rejected agent from local registry
                    this._agents.delete(agentId);
                    break;
                }

                this._connectReject?.(err);
                this._connectResolve = null;
                this._connectReject = null;
                this.emit("error", err);
                break;
            }

            // ── Server-initiated ping — respond with pong ─────────────
            case "ping":
                this._send({ event: "pong" });
                break;

            // ── No-op events (expected, no action needed) ───────────────
            case "authenticated":
            case "pong":
            case "call.dialing":
            case "session.configured":
                // Expected protocol responses — no client-side action required
                break;

            // ── Displaced: another client registered same agent_id ──────
            case "agent.displaced":
                this._closing = true;
                this._stopPing();
                this._reconnector?.cancel();
                this._connected = false;
                this.emit(
                    "disconnected",
                    `displaced: ${(data.reason as string) ?? "replaced_by_new_connection"}`,
                );
                try { this._ws?.close(1000, "displaced"); } catch { /* ignore */ }
                break;

            // ── Call error ──────────────────────────────────────────────
            case "call.error": {
                const err = new PinecallError(
                    data.error as string,
                    (data.code as string) ?? "CALL_ERROR",
                );
                this.emit("error", err);
                break;
            }

            // ── All other call-scoped events → route to agent ───────────
            default: {
                // llm.chat.* events use session_id (no agent_id) — route to
                // the target agent, or fall back to the first registered one.
                // history.*, conversations.*, and session.* responses also lack agent_id — same fallback.
                const needsFallback = eventType.startsWith("llm.chat.") 
                    || eventType.startsWith("history.") 
                    || eventType.startsWith("conversation")
                    || eventType.startsWith("session.")
                    || eventType.startsWith("whatsapp.");
                const targetAgent = agentId
                    ? this._agents.get(agentId)
                    : (needsFallback
                        ? this._agents.values().next().value
                        : null);
                if (targetAgent) targetAgent._handleEvent(data);
                break;
            }
        }
    }

    // ── Internal: send JSON ──────────────────────────────────────────────

    private _send(data: Record<string, unknown>): void {
        this._log("→", data);
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify(data));
        }
    }

    /** @internal Append to protocol log file if PINECALL_LOG is set. */
    private _log(dir: string, data: Record<string, unknown>): void {
        if (!this._logFile) return;
        const event = data.event as string;
        // Filter out noisy audio analysis events
        if (event === "audio.metrics" || event === "audio_analysis") return;
        const ts = new Date().toISOString();
        const line = `${ts} ${dir} ${JSON.stringify(data)}\n`;
        try { appendFileSync(this._logFile, line); } catch { /* ignore */ }
    }

    // ── Internal: ping/pong ──────────────────────────────────────────────

    private _startPing(): void {
        this._stopPing();
        const interval = this._opts.pingInterval ?? 30000;
        if (interval <= 0) return;

        this._pingTimer = setInterval(() => {
            this._send({ event: "ping" });
        }, interval);
    }

    private _stopPing(): void {
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
    }
}

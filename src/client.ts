/**
 * Pinecall — main client class. The orchestrator.
 *
 * Composes Transport, Dispatcher, Reconnector, Logger, IdResolver.
 * Owns the agent registry and WebSocket lifecycle.
 *
 * Public API is identical to src.bkp/client.ts.
 */

import { TypedEventBus } from "./kernel/event-bus.js";
import { noopLogger, fileLogger } from "./kernel/logger.js";
import type { Logger } from "./kernel/logger.js";
import { WebSocketTransport } from "./transport/websocket.js";
import { Reconnector } from "./transport/reconnect.js";
import type { Transport } from "./transport/transport.js";
import { StandardAgentIdResolver } from "./protocol/id-resolver.js";
import { buildShortcutPayload } from "./protocol/shortcuts.js";
import { Dispatcher } from "./dispatch/dispatcher.js";
import { forwardAgentEvents } from "./dispatch/proxy.js";
import type { WireEvent } from "./protocol/wire.js";
import type { DispatchContext } from "./dispatch/handler.js";
import { PINECALL_MODE, PINECALL_DEV_ID, PINECALL_LOG } from "./env/mode.js";

// Handlers
import { ConnectionHandler } from "./dispatch/handlers/connection.js";
import { ErrorHandler } from "./dispatch/handlers/error.js";
import { ChannelHandler } from "./dispatch/handlers/channel.js";
import { LifecycleHandler } from "./dispatch/handlers/lifecycle.js";
import { SpeechHandler } from "./dispatch/handlers/speech.js";
import { TurnHandler } from "./dispatch/handlers/turn.js";
import { BotHandler } from "./dispatch/handlers/bot.js";
import { ToolHandler } from "./dispatch/handlers/tool.js";
import { SessionHandler } from "./dispatch/handlers/session.js";
import { ChatHandler } from "./dispatch/handlers/chat.js";
import { WhatsAppHandler } from "./dispatch/handlers/whatsapp.js";
import { HistoryHandler } from "./dispatch/handlers/history.js";
import { SystemHandler } from "./dispatch/handlers/system.js";
import { FallbackHandler } from "./dispatch/handlers/fallback.js";

// Domain
import { Agent } from "./domain/agent.js";
import type { AgentConfig, ChannelConfig, DeployConfig } from "./config/agent.js";
import type { TokenResponse } from "./api/tokens.js";
import type { Turn } from "./domain/turn.js";
import type { Call } from "./domain/call.js";

// SSE
import { createMultiAgentStream } from "./sse/stream.js";
import type { StreamOptions } from "./sse/stream.js";
import type { ServerResponse } from "node:http";

// REST API
import { createToken as createTokenApi } from "./api/tokens.js";

// ─── Types ───────────────────────────────────────────────────────────────

export interface PinecallOptions {
    apiKey: string;
    /** Server URL. Default: wss://voice.pinecall.io */
    apiUrl?: string;
    /** Mode: "dev", "staging", or empty for production. */
    mode?: string;
    /** Developer ID for dev-mode routing. */
    devId?: string;
    /** Auto-reconnect on disconnect. Default: true. */
    autoReconnect?: boolean;
    /** Prompts directory for setPromptFile. Default: "prompts". */
    promptsDir?: string;
}

export interface PinecallEvents {
    [key: string]: (...args: any[]) => void;
    connected: () => void;
    disconnected: (reason: string) => void;
    reconnecting: (attempt: number, delay: number) => void;
    error: (err: Error) => void;
    "call.started": (call: Call) => void;
    "call.ended": (call: Call, reason: string) => void;

    // Proxied events (from Agent → Pinecall)
    "speech.started": (...args: any[]) => void;
    "speech.ended": (...args: any[]) => void;
    "user.speaking": (...args: any[]) => void;
    "user.message": (...args: any[]) => void;
    "eager.turn": (turn: Turn, call: Call) => void;
    "turn.pause": (...args: any[]) => void;
    "turn.end": (turn: Turn, call: Call) => void;
    "turn.resumed": (...args: any[]) => void;
    "turn.continued": (...args: any[]) => void;
    "bot.speaking": (...args: any[]) => void;
    "bot.word": (...args: any[]) => void;
    "bot.finished": (...args: any[]) => void;
    "bot.interrupted": (...args: any[]) => void;
    "message.confirmed": (...args: any[]) => void;
    "reply.rejected": (...args: any[]) => void;
    "audio.metrics": (...args: any[]) => void;
    "llm.tool_call": (...args: any[]) => void;
    "session.timeout": (...args: any[]) => void;
}

export class PinecallError extends Error {
    constructor(message: string, public code?: string) {
        super(message);
        this.name = "PinecallError";
    }
}

// ─── Pinecall ────────────────────────────────────────────────────────────

export class Pinecall extends TypedEventBus<PinecallEvents> {
    readonly #apiKey: string;
    readonly #apiUrl: string;
    readonly #wsUrl: string;
    readonly #mode: string;
    readonly #devId: string;
    readonly #autoReconnect: boolean;
    readonly #promptsDir: string;

    readonly #agents = new Map<string, Agent>();
    readonly #reconnector: Reconnector;
    readonly #resolver: StandardAgentIdResolver;
    readonly #dispatcher: Dispatcher;
    readonly #logger: Logger;

    #transport: Transport | null = null;
    #pingInterval: ReturnType<typeof setInterval> | null = null;
    #intentionalClose = false;
    #connected = false;
    #connectResolve: (() => void) | null = null;
    #connectReject: ((err: Error) => void) | null = null;

    constructor(opts: PinecallOptions) {
        super();
        this.#apiKey = opts.apiKey;

        // Normalize URLs
        const rawUrl = opts.apiUrl ?? "wss://voice.pinecall.io";
        this.#apiUrl = rawUrl.replace(/^ws/, "http");
        this.#wsUrl = rawUrl.replace(/^http/, "ws");

        this.#mode = opts.mode ?? PINECALL_MODE;
        this.#devId = opts.devId ?? PINECALL_DEV_ID;
        this.#autoReconnect = opts.autoReconnect !== false;
        this.#promptsDir = opts.promptsDir ?? "prompts";

        this.#reconnector = new Reconnector();
        this.#resolver = new StandardAgentIdResolver(this.#mode, this.#devId);
        this.#logger = PINECALL_LOG ? fileLogger(PINECALL_LOG) : noopLogger;

        // Build dispatcher with all handlers in priority order
        this.#dispatcher = new Dispatcher([
            new SystemHandler(),
            new ConnectionHandler(),
            new ErrorHandler(),
            new ChannelHandler(),
            new ChatHandler(),
            new LifecycleHandler(),
            new SpeechHandler(),
            new TurnHandler(),
            new BotHandler(),
            new ToolHandler(),
            new SessionHandler(),
            new WhatsAppHandler(),
            new HistoryHandler(),
            new FallbackHandler(),
        ]);
    }

    // ── Public getters ───────────────────────────────────────────────────

    get connected(): boolean {
        return this.#connected;
    }

    get mode(): string {
        return this.#mode;
    }

    get devId(): string {
        return this.#devId;
    }

    get agents(): ReadonlyMap<string, Agent> {
        return this.#agents;
    }

    getAgent(id: string): Agent | undefined {
        return this.#agents.get(id);
    }

    // ── Connect / Disconnect ─────────────────────────────────────────────

    async connect(): Promise<void> {
        this.#intentionalClose = false;

        // Server endpoint is always /client
        const wsUrl = this.#wsUrl.replace(/\/+$/, "") + "/client";
        const transport = new WebSocketTransport({ url: wsUrl });

        transport.onMessage((data) => this.#onMessage(data));
        transport.onClose((reason) => this.#onClose(reason));

        await transport.open();
        this.#transport = transport;

        // Wait for the server's "connected" event before resolving.
        // The old client did this via _connectResolve/_connectReject.
        await new Promise<void>((resolve, reject) => {
            this.#connectResolve = resolve;
            this.#connectReject = reject;

            // Send auth
            this.#send({ event: "connect", api_key: this.#apiKey });

            // Timeout if server doesn't respond
            setTimeout(() => {
                if (!this.#connected) {
                    this.#connectResolve = null;
                    this.#connectReject = null;
                    reject(new PinecallError("Connection timeout: no 'connected' event from server", "CONNECTION_TIMEOUT"));
                }
            }, 10000);
        });
    }

    async disconnect(): Promise<void> {
        this.#intentionalClose = true;
        this.#reconnector.cancel();

        if (this.#pingInterval) {
            clearInterval(this.#pingInterval);
            this.#pingInterval = null;
        }

        // End all calls across all agents
        for (const agent of this.#agents.values()) {
            agent._endAllCalls("client_disconnect");
        }

        if (this.#transport) {
            await this.#transport.close();
            this.#transport = null;
        }

        this.#connected = false;
    }

    // ── Agent management ─────────────────────────────────────────────────

    agent(id: string, config: AgentConfig = {}): Agent {
        if (this.#agents.has(id)) {
            return this.#agents.get(id)!;
        }

        const wireId = this.#buildWireId(id);

        const agent = new Agent(
            id,
            config,
            (data) => this.#send(data),
            wireId,
        );

        agent._setClient({
            createToken: (channel, agentId) => this.createToken(channel, agentId),
            _createTokenRaw: (channel, wId) => this.#createTokenRaw(channel, wId),
        });

        this.#agents.set(id, agent);

        // Set up event forwarding: Agent → Pinecall
        forwardAgentEvents(agent, this);

        // If already connected, register immediately
        if (this.#connected) {
            this.#registerAgent(agent);
        }

        return agent;
    }

    /**
     * Deploy — shorthand for agent() + addChannel() in one call.
     */
    deploy(id: string, config: DeployConfig = {}): Agent {
        // Extract deploy-specific fields from agent config
        const { channels, model, prompt, tools, ...agentConfig } = config;

        // Build LLM config from model field
        if (model) {
            const [provider, ...rest] = model.split(":");
            agentConfig.llm = {
                provider: provider || "openai",
                model: rest.join(":") || model,
                enabled: true,
                ...(prompt ? { prompt } : {}),
            };
        } else if (prompt) {
            // No model specified but prompt given — use default model
            agentConfig.llm = {
                provider: "openai",
                model: "gpt-4.1-mini",
                enabled: true,
                prompt,
            };
        }

        // Pass through tools
        if (tools) (agentConfig as any).tools = tools;

        const agent = this.agent(id, agentConfig);

        // Auto-register channels from config
        if (channels) {
            for (const ch of channels) {
                if (typeof ch === "string") {
                    if (ch === "webrtc" || ch === "mic" || ch === "chat") {
                        agent.addChannel(ch);
                    } else {
                        // Assume it's a phone number
                        agent.addChannel("phone", ch);
                    }
                } else {
                    agent.addChannel(ch.type as any, ch.ref, ch.config);
                }
            }
        }

        return agent;
    }

    removeAgent(id: string): boolean {
        const agent = this.#agents.get(id);
        if (agent) {
            agent._endAllCalls("agent_removed");
            agent.removeAllListeners();
        }
        return this.#agents.delete(id);
    }

    // ── Token generation ─────────────────────────────────────────────────

    async createToken(channel: "webrtc" | "chat", agentId: string): Promise<TokenResponse> {
        const wireId = this.#buildWireId(agentId);
        return this.#createTokenRaw(channel, wireId);
    }

    async #createTokenRaw(channel: "webrtc" | "chat", wireId: string): Promise<TokenResponse> {
        return createTokenApi({
            channel,
            agentId: wireId,
            apiKey: this.#apiKey,
            apiUrl: this.#apiUrl,
        });
    }

    // ── SSE Streaming ────────────────────────────────────────────────────

    stream(opts?: StreamOptions): Response;
    stream(res: ServerResponse, opts?: StreamOptions): void;
    stream(resOrOpts?: ServerResponse | StreamOptions, opts?: StreamOptions): Response | void {
        if (resOrOpts && typeof (resOrOpts as any).writeHead === "function") {
            return createMultiAgentStream(this.#agents, resOrOpts as ServerResponse, opts);
        }
        return createMultiAgentStream(this.#agents, resOrOpts as StreamOptions);
    }

    // ── Raw send (escape hatch) ──────────────────────────────────────────

    send(data: Record<string, unknown>): void {
        this.#send(data);
    }

    // ── Private methods ──────────────────────────────────────────────────

    #send(data: Record<string, unknown>): void {
        if (this.#transport?.isOpen) {
            this.#transport.send(data);
            this.#logger.debug("→", data);
        }
    }

    #buildWireId(slug: string): string {
        if (this.#mode === "dev" && this.#devId) {
            return `dev-${this.#devId}-${slug}`;
        } else if (this.#mode) {
            return `${this.#mode}-${slug}`;
        }
        return slug;
    }

    #registerAgent(agent: Agent): void {
        const wireId = agent._getWireId();
        const config = agent.getConfig();

        this.#send({
            event: "agent.create",
            agent_id: wireId,
            ...buildShortcutPayload(config),
            ...(config.allowedOrigins ? { allowed_origins: config.allowedOrigins } : {}),
            ...(config.historySave !== undefined ? { history_save: config.historySave } : {}),
        });
    }

    #onMessage(data: Record<string, unknown>): void {
        const wire = data as WireEvent;
        this.#logger.debug("←", data);

        // Build dispatch context
        const ctx: DispatchContext = {
            agent: (wireId: string) => {
                // Try direct match first
                const localKeys = new Set(this.#agents.keys());
                const resolved = this.#resolver.resolve(wireId, localKeys);
                return resolved ? this.#agents.get(resolved) ?? null : null;
            },
            call: (agent, callId) => agent._getCall(callId),
            logger: this.#logger,
            send: (d) => this.#send(d),
            onConnected: () => {
                this.#connected = true;
                this.#reconnector.reset();

                // Register all pre-created agents
                for (const agent of this.#agents.values()) {
                    this.#registerAgent(agent);
                }

                // Start ping interval
                if (!this.#pingInterval) {
                    this.#pingInterval = setInterval(() => {
                        this.#send({ event: "ping" });
                    }, 30_000);
                }

                // Resolve the connect() promise
                if (this.#connectResolve) {
                    this.#connectResolve();
                    this.#connectResolve = null;
                    this.#connectReject = null;
                }

                this.emit("connected");
                this.#logger.info("Connected to Pinecall");
            },
            client: {
                _emitWire: (event, ...args) => (this as any).emit(event, ...args),
                _getAgent: (id) => this.#agents.get(id),
            },
        };

        this.#dispatcher.dispatch(wire, ctx);
    }

    #onClose(reason: string): void {
        this.#connected = false;

        if (this.#pingInterval) {
            clearInterval(this.#pingInterval);
            this.#pingInterval = null;
        }

        // End all active calls
        for (const agent of this.#agents.values()) {
            agent._endAllCalls(reason);
        }

        this.emit("disconnected", reason);
        this.#logger.info(`Disconnected: ${reason}`);

        // Auto-reconnect unless intentional close
        if (!this.#intentionalClose && this.#autoReconnect) {
            this.#reconnect();
        }
    }

    async #reconnect(): Promise<void> {
        try {
            const delay = await this.#reconnector.wait();
            this.emit("reconnecting", this.#reconnector.attempt, delay);
            this.#logger.info(`Reconnecting (attempt ${this.#reconnector.attempt}, delay ${delay}ms)`);
            await this.connect();
        } catch (err) {
            this.#logger.error(`Reconnection failed: ${err}`);
            // Schedule another attempt
            if (!this.#intentionalClose) {
                this.#reconnect();
            }
        }
    }

    // ── Friend methods (for dispatch handlers) ───────────────────────────

    /** @internal Emit a typed event (used by dispatch handlers). */
    _emitWire(event: string, ...args: unknown[]): void {
        (this as any).emit(event, ...args);
    }

    /** @internal Get an agent by ID. */
    _getAgent(id: string): Agent | undefined {
        return this.#agents.get(id);
    }
}

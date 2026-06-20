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
import { PreparingHandler } from "./dispatch/handlers/preparing.js";

// Domain
import { Agent } from "./domain/agent.js";
import type { AgentConfig, ChannelConfig } from "./config/agent.js";
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
    /** API key. Falls back to PINECALL_API_KEY env var if not provided. */
    apiKey?: string;
    /** Server URL. Default: wss://voice.pinecall.io */
    apiUrl?: string;
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
    "llm.toolCall": (...args: any[]) => void;
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
    readonly #autoReconnect: boolean;
    readonly #promptsDir: string;

    readonly #agents = new Map<string, Agent>();
    readonly #reconnector: Reconnector;
    readonly #resolver: StandardAgentIdResolver;
    readonly #dispatcher: Dispatcher;
    readonly #logger: Logger;
    readonly #waHandler: WhatsAppHandler;
    #runnerHook: ((agent: Agent) => void) | null = null;

    #transport: Transport | null = null;
    #pingInterval: ReturnType<typeof setInterval> | null = null;
    #intentionalClose = false;
    #connected = false;
    #connectResolve: (() => void) | null = null;
    #connectReject: ((err: Error) => void) | null = null;
    #connectPromise: Promise<void> | null = null;

    constructor(opts: PinecallOptions = {}) {
        super();
        this.#apiKey = opts.apiKey ?? this.#getEnv("PINECALL_API_KEY") ?? "";

        // Normalize URLs
        const rawUrl = opts.apiUrl ?? "wss://voice.pinecall.io";
        this.#apiUrl = rawUrl.replace(/^ws/, "http");
        this.#wsUrl = rawUrl.replace(/^http/, "ws");

        this.#autoReconnect = opts.autoReconnect !== false;
        this.#promptsDir = opts.promptsDir ?? "prompts";

        this.#reconnector = new Reconnector();
        this.#resolver = new StandardAgentIdResolver();

        const logPath = this.#getEnv("PINECALL_LOG");
        this.#logger = logPath ? fileLogger(logPath) : noopLogger;

        // Build dispatcher with all handlers in priority order
        this.#waHandler = new WhatsAppHandler();
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
            new PreparingHandler(),
            new SessionHandler(),
            this.#waHandler,
            new HistoryHandler(),
            new FallbackHandler(),
        ]);

        // Auto-attach runner display for `pinecall run`
        if (this.#getEnv("PINECALL_CLI_RUN") === "1") {
            import("./runner.js").then((mod) => {
                this.#runnerHook = mod.attachRunner();
                // Attach to any agents already created before import resolved
                for (const agent of this.#agents.values()) {
                    this.#runnerHook!(agent);
                }
            }).catch(() => {});
        }

        // Auto-connect on instantiation — connect() is idempotent,
        // so existing `await pc.connect()` calls become a harmless no-op.
        if (this.#apiKey) {
            this.connect();
        }
    }

    // ── Public getters ───────────────────────────────────────────────────

    get connected(): boolean {
        return this.#connected;
    }

    /** Promise that resolves when the connection is established. */
    get ready(): Promise<void> {
        return this.#connectPromise ?? Promise.resolve();
    }

    get agents(): ReadonlyMap<string, Agent> {
        return this.#agents;
    }

    getAgent(id: string): Agent | undefined {
        return this.#agents.get(id);
    }

    // ── Connect / Disconnect ─────────────────────────────────────────────

    async connect(): Promise<void> {
        // Idempotent: if already connecting/connected, return the existing promise
        if (this.#connectPromise && !this.#intentionalClose) {
            return this.#connectPromise;
        }

        this.#connectPromise = this.#doConnect();
        return this.#connectPromise;
    }

    async #doConnect(): Promise<void> {
        this.#intentionalClose = false;

        // Server endpoint is always /client
        const wsUrl = this.#wsUrl.replace(/\/+$/, "") + "/client";
        const transport = new WebSocketTransport({ url: wsUrl });

        transport.onMessage((data) => this.#onMessage(data));
        transport.onClose((reason) => this.#onClose(reason));

        await transport.open();
        this.#transport = transport;

        // Wait for the server's "connected" event before resolving.
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
        this.#connectPromise = null;

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

        // Extract channel/greeting fields before passing to Agent
        const { phoneNumber, phoneNumbers, whatsapp, greeting, ...agentConfig } = config;

        const agent = new Agent(
            id,
            agentConfig,
            (data) => this.#send(data),
        );

        agent._setClient({
            createToken: (channel, agentId, metadata) => this.createToken(channel, agentId, metadata),
        });

        this.#agents.set(id, agent);

        // Set up event forwarding: Agent → Pinecall
        forwardAgentEvents(agent, this);

        // Register phone number(s) — singular takes precedence over deprecated array
        if (phoneNumber) {
            if (typeof phoneNumber === "string") {
                agent._addChannel("phone", phoneNumber);
            } else {
                const { number, ...phoneConfig } = phoneNumber;
                agent._addChannel("phone", number, phoneConfig);
            }
        } else if (phoneNumbers) {
            for (const p of phoneNumbers) {
                if (typeof p === "string") {
                    agent._addChannel("phone", p);
                } else {
                    const { number, ...phoneConfig } = p;
                    agent._addChannel("phone", number, phoneConfig);
                }
            }
        }

        // Register WhatsApp channels
        if (whatsapp) {
            for (const wa of whatsapp) {
                agent._addChannel("whatsapp", wa);
            }
        }

        // Auto-register greeting handler
        if (greeting) {
            agent.on("call.started", async (call) => {
                let text: string;
                let addToHistory = true;

                if (typeof greeting === "function") {
                    text = await greeting(call);
                } else if (typeof greeting === "object") {
                    text = greeting.text;
                    addToHistory = greeting.addToHistory ?? true;
                } else {
                    text = greeting;
                }

                call.say(text, { addToHistory });
            });
        }

        // If already connected, register immediately
        if (this.#connected) {
            this.#registerAgent(agent);
        }

        // Runner display hook (pinecall run)
        if (this.#runnerHook) {
            this.#runnerHook(agent);
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

    async createToken(
        channel: "webrtc" | "chat" | "stream",
        agentId: string,
        metadata?: Record<string, unknown>,
    ): Promise<TokenResponse> {
        return createTokenApi({
            channel,
            agentId,
            apiKey: this.#apiKey,
            apiUrl: this.#apiUrl,
            metadata,
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

    #registerAgent(agent: Agent): void {
        const config = agent.getConfig();

        this.#send({
            event: "agent.create",
            agent_id: agent.id,
            ...buildShortcutPayload(config),
            ...(config.allowedOrigins ? { allowed_origins: config.allowedOrigins } : {}),
        });
    }

    #getEnv(key: string): string | undefined {
        try {
            return (globalThis as any).process?.env?.[key];
        } catch {
            return undefined;
        }
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
                _allAgents: () => [...this.#agents.values()],
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

        // Auto-reconnect unless intentional close or displacement
        const displaced = reason.includes("Displaced") || reason.includes("displaced");
        if (!this.#intentionalClose && this.#autoReconnect && !displaced) {
            this.#reconnect();
        }
    }

    async #reconnect(): Promise<void> {
        // Clear the old promise so connect() creates a fresh connection
        this.#connectPromise = null;
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

    /** @internal Get all registered agents. Used by ToolHandler when agent_id is missing. */
    _allAgents(): Agent[] {
        return [...this.#agents.values()];
    }

    /** @internal Get the WhatsApp handler. Used by HistoryHandler for wa- session routing. */
    _getWhatsAppHandler(): WhatsAppHandler {
        return this.#waHandler;
    }
}

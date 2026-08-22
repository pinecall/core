/**
 * Pinecall — main client class. The orchestrator.
 *
 * Composes Transport, Dispatcher, Reconnector, Logger, IdResolver.
 * Owns the agent registry and WebSocket lifecycle.
 *
 * Public API is identical to src.bkp/client.ts.
 */

import { TypedEventBus } from "./kernel/event-bus.js";
import { PinecallError, AgentConflictError } from "./kernel/errors.js";
import { noopLogger, fileLogger } from "./kernel/logger.js";
import { planConflictRetry, CONFLICT_RETRY_BUDGET_MS } from "./kernel/backoff.js";
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
import type { RegistrationCoordinator } from "./dispatch/registration.js";


// Handlers
import { ConnectionHandler } from "./dispatch/handlers/connection.js";
import { ErrorHandler } from "./dispatch/handlers/error.js";
import { ChannelHandler } from "./dispatch/handlers/channel.js";
import { LifecycleHandler } from "./dispatch/handlers/lifecycle.js";
import { SpeechHandler } from "./dispatch/handlers/speech.js";
import { TurnHandler } from "./dispatch/handlers/turn.js";
import { BotHandler } from "./dispatch/handlers/bot.js";
import { ToolHandler } from "./dispatch/handlers/tool.js";
import { SkillHandler } from "./dispatch/handlers/skill.js";
import { SessionHandler } from "./dispatch/handlers/session.js";
import { ChatHandler } from "./dispatch/handlers/chat.js";
import { WhatsAppHandler } from "./dispatch/handlers/whatsapp.js";
import { HistoryHandler } from "./dispatch/handlers/history.js";
import { SystemHandler } from "./dispatch/handlers/system.js";
import { FallbackHandler } from "./dispatch/handlers/fallback.js";
import { PreparingHandler } from "./dispatch/handlers/preparing.js";
import { MemoryHandler } from "./dispatch/handlers/memory.js";
import { LineHandler } from "./dispatch/handlers/line.js";

// Domain
import { Agent } from "./domain/agent.js";
import { PhoneLine, prepareLine } from "./domain/line.js";
import type { LineOptions } from "./domain/line.js";
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
import type { TokenScopeOptions } from "./api/tokens.js";
import { speech as speechApi, fetchAudioVoices, transcribe as transcribeApi, transcribeStream as transcribeStreamApi } from "./api/audio.js";
import type {
    SpeechOptions,
    SpeechResult,
    FetchAudioVoicesOptions,
    TranscribeInput,
    TranscribeOptions,
    Transcription,
    TranscribeStreamOptions,
    TranscribeStream,
} from "./api/audio.js";
import type { Voice } from "./api/voices.js";

/**
 * `pc.audio` — standalone speech, bound to this client's key and URL. No
 * agent, no call: `speech()` streams one utterance, `voices()` lists what it
 * accepts, `transcribe()` turns a file into text, `transcribeStream()` turns
 * live PCM into partial/final segments. See `src/api/audio.ts` and
 * `src/api/audio-stt.ts` for the wire contracts.
 */
export interface AudioNamespace {
    /** Synthesise `input` with `voice`; resolves on headers, audio streams. */
    speech(opts: SpeechOptions): Promise<SpeechResult>;
    /** Voices `speech()` accepts, optionally filtered by provider/language. */
    voices(opts?: Omit<FetchAudioVoicesOptions, "apiKey" | "apiUrl">): Promise<Voice[]>;
    /** Transcribe one file (bytes, Blob, or a Node path). */
    transcribe(input: TranscribeInput, opts?: TranscribeOptions): Promise<Transcription>;
    /** Open a live transcription socket; write PCM, read partial/final. Node only. */
    transcribeStream(opts?: TranscribeStreamOptions): TranscribeStream;
}

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

// The error types live in kernel/errors.ts so a dispatch handler can build one
// without importing this module (a handler importing its own orchestrator is a
// cycle waiting to happen). Re-exported here so both
// `import { AgentConflictError } from "@pinecall/sdk"` and
// `from "./client.js"` keep working exactly as before.
export { PinecallError, AgentConflictError, ServerAtCapacityError } from "./kernel/errors.js";

/**
 * How long `createToken` waits for a locally-owned agent's `agent.created`
 * before failing with AGENT_NOT_REGISTERED. Mirrors the connect() timeout.
 */
const REGISTRATION_WAIT_MS = 10_000;

// ─── Pinecall ────────────────────────────────────────────────────────────

export class Pinecall extends TypedEventBus<PinecallEvents> {
    readonly #apiKey: string;
    readonly #apiUrl: string;
    readonly #wsUrl: string;
    readonly #autoReconnect: boolean;
    readonly #promptsDir: string;

    /** Standalone TTS/STT — `pc.audio.speech()` / `voices()` / `transcribe()` / `transcribeStream()`. */
    readonly audio: AudioNamespace = {
        speech: (opts) => speechApi({ ...opts, apiKey: this.#apiKey, apiUrl: this.#apiUrl }),
        voices: (opts = {}) => fetchAudioVoices({ ...opts, apiKey: this.#apiKey, apiUrl: this.#apiUrl }),
        transcribe: (input, opts = {}) => transcribeApi(input, { ...opts, apiKey: this.#apiKey, apiUrl: this.#apiUrl }),
        transcribeStream: (opts = {}) => transcribeStreamApi({ ...opts, apiKey: this.#apiKey, apiUrl: this.#apiUrl }),
    };

    readonly #agents = new Map<string, Agent>();
    /** Phone lines, by number. Kept apart from #agents: a line is not an agent. */
    readonly #lines = new Map<string, PhoneLine>();
    readonly #reconnector: Reconnector;
    readonly #resolver: StandardAgentIdResolver;
    readonly #dispatcher: Dispatcher;
    readonly #logger: Logger;
    readonly #waHandler: WhatsAppHandler;
    /**
     * The registration state machine, handed to dispatch as a capability.
     *
     * Built once — the three methods below are the whole contract dispatch has
     * with this class, and stating it as an object (instead of a bag of
     * optional `_` methods on the context) is what lets handlers stop guessing
     * whether a hook is wired.
     */
    readonly #registration: RegistrationCoordinator = {
        scheduleRetry: (id, hint) => this.#scheduleRegisterRetry(id, hint),
        fail: (id) => this.#failRegistration(id, "server_fatal"),
        clear: (id) => this.#clearRegisterRetry(id),
    };
    #runnerHook: ((agent: Agent) => void) | null = null;

    #transport: Transport | null = null;
    #pingInterval: ReturnType<typeof setInterval> | null = null;
    /** Registration-conflict retry state: agentId → attempt count + pending timer. */
    readonly #registerRetries = new Map<string, { attempt: number; timer: ReturnType<typeof setTimeout> | null; holderAlive: boolean; startedAt: number }>();
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
            new LineHandler(),
            new SpeechHandler(),
            new TurnHandler(),
            new BotHandler(),
            new ToolHandler(),
            new SkillHandler(),
            new PreparingHandler(),
            new MemoryHandler(),
            new SessionHandler(),
            this.#waHandler,
            new HistoryHandler(),
            new FallbackHandler(),
        ]);

        // Auto-attach runner display for `pinecall run`
        if (this.#getEnv("PINECALL_CLI_RUN") === "1") {
            import("./runner.js").then((mod) => {
                // The host is what the runner's web console needs — the agents
                // it observes, where to mint tokens, and how to stream. The API
                // key is NOT part of it: it never leaves this object.
                this.#runnerHook = mod.attachRunner({
                    agents: this.#agents,
                    apiUrl: this.#apiUrl,
                    createToken: (channel, agentId, metadata) => this.createToken(channel, agentId, metadata),
                    stream: (res, opts) => this.stream(res, opts),
                    close: () => this.disconnect(),
                });
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

    /** Phone lines registered on this client, by number. */
    get lines(): ReadonlyMap<string, PhoneLine> {
        return this.#lines;
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

        this.#clearAllRegisterRetries();

        // End all calls across all agents and lines
        for (const agent of this.#agents.values()) {
            agent._endAllCalls("client_disconnect");
        }
        for (const line of this.#lines.values()) {
            line._endAllCalls("client_disconnect");
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

        // Extract channel fields before passing to Agent. `greeting` STAYS in
        // the config when it is a string/object: it goes on the wire and the
        // SERVER delivers it on every channel — one text, one owner. Only a
        // FUNCTION greeting is extracted: it cannot serialize, so it keeps the
        // legacy client-side call.say on voice events.
        const { phoneNumber, phoneNumbers, whatsapp, ...agentConfig } = config;
        const greeting = typeof config.greeting === "function" ? config.greeting : undefined;
        if (greeting) delete (agentConfig as any).greeting;

        const agent = new Agent(
            id,
            agentConfig,
            (data) => this.#send(data),
        );

        agent._setClient({
            createToken: (channel, agentId, metadata, opts) => this.createToken(channel, agentId, metadata, opts),
            memoryApi: { apiKey: this.#apiKey, apiUrl: this.#apiUrl },
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

        // Function greetings only — string/object ones rode the wire above and
        // the server delivers them itself (voice speaks, chat emits when
        // greetingInChat is set). A per-call computed greeting cannot
        // serialize, so it keeps the legacy client-side say on voice events.
        if (greeting) {
            agent.on("call.started", async (call) => {
                const text = await greeting(call);
                call.say(text, { addToHistory: true });
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

    /**
     * Claim a phone number as a programmable LINE — its own STT and TTS, no
     * model. It answers first, resolves the dialled extension, speaks and
     * listens in code, and hands the LIVE call to an agent when the code says
     * so (`call.routeTo`). The destination agent does not have to be online for
     * the number to answer.
     *
     * Idempotent per number, like `pc.agent()`. `llm`/`prompt`/`tools`/
     * `greeting` are refused here and now: a line has no model.
     *
     * @example
     * const line = pc.line("+12186633772", { stt: "soniox", voice: "elevenlabs/sarah" });
     * line.extensions({ "10": "pres-restaurantes", "11": "pres-hoteles" });
     * line.on("call", async (call) => {
     *   const a = await call.ask("Press one for sales.", { digits: 1, timeout: 5000 });
     *   if (a.by === "keypad" && a.digit === "1") await call.routeTo("ventas");
     * });
     */
    line(number: string, opts: LineOptions = {}): PhoneLine {
        const normalized = prepareLine(number, opts);
        const existing = this.#lines.get(normalized);
        if (existing) return existing;

        const line = new PhoneLine(normalized, opts, (data) => this.#send(data));
        this.#lines.set(normalized, line);

        // If already connected, claim the number immediately
        if (this.#connected) {
            line._register();
        }

        return line;
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

    /**
     * Mint a short-lived browser token for an agent.
     *
     * `opts` (optional, spec §5) narrows the token: `{ scope: "observe",
     * callId }` mints a read-only Call Log token for a single call. Omitting
     * it mints exactly the token this method has always minted.
     *
     * Ordered AFTER the agent's server-side registration: `pc.agent()` returns
     * synchronously and only queues `agent.create` on the socket, so a mint
     * issued in the next statement used to overtake it on the wire and come
     * back `404 Agent '<id>' is not online` — a valid, healthy registration
     * refused purely because the HTTP request beat the WebSocket frame. For an
     * agent this client owns we wait for `agent.created` first. Agents owned by
     * another process are minted straight through (nothing local to wait on).
     */
    async createToken(
        channel: "webrtc" | "chat" | "stream",
        agentId: string | readonly string[],
        metadata?: Record<string, unknown>,
        opts?: TokenScopeOptions,
    ): Promise<TokenResponse> {
        // An agent set (§5) awaits each locally-owned registration, so a mint
        // issued right after pc.agent(...) cannot race any member's create.
        const ids = Array.isArray(agentId) ? agentId : [agentId as string];
        for (const id of ids) await this.#awaitRegistration(id);
        return createTokenApi({
            channel,
            agentId,
            apiKey: this.#apiKey,
            apiUrl: this.#apiUrl,
            metadata,
            ...(opts?.scope ? { scope: opts.scope } : {}),
            ...(opts?.callId ? { callId: opts.callId } : {}),
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

    /**
     * Wait until the server has acknowledged a locally-owned agent.
     *
     * NOT a grace period: the wait ends the moment `agent.created` arrives (sub-
     * millisecond on a live socket). The deadline exists only so a caller inside
     * a request handler cannot hang forever while the socket is down — and it
     * fails with the real reason instead of minting a token that would 404.
     */
    async #awaitRegistration(agentId: string): Promise<void> {
        const agent = this.#agents.get(agentId);
        if (!agent || agent.registered) return;

        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new PinecallError(
                `Agent "${agentId}" was not registered by the server within ` +
                `${Math.round(REGISTRATION_WAIT_MS / 1000)}s — it cannot be used yet ` +
                `(is the client connected?).`,
                "AGENT_NOT_REGISTERED",
            )), REGISTRATION_WAIT_MS);
            (timer as any)?.unref?.();
        });
        try {
            await Promise.race([agent.ready, deadline]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

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

    /**
     * Retry a registration rejected with AGENT_CONFLICT / AGENT_IN_USE.
     *
     * The rejection is often transient: after a network blip or a process
     * restart, the server may briefly hold our own dead socket as "alive".
     * A new server also tells us WHICH case we're in:
     *   - `retry_after_s` (escalating server-side) is honored directly;
     *   - `holder_alive: true` = a real second process owns the name — cap
     *     grows to 10 min so we never storm the server for hours;
     *   - `holder_alive: false` = the holder died — reset to fast retries.
     * Against an old server (no hint) the legacy 5s→60s backoff applies,
     * now with jitter. Cleared on agent.created/agent.resumed and on socket
     * close (a full reconnect re-registers every agent anyway).
     *
     * Retries are BOUNDED: the whole episode gets CONFLICT_RETRY_BUDGET_MS
     * (2× the server's stale-registration window) — enough for any stale
     * registration to be reaped, and no more. Past it the conflict is
     * terminal (see #failRegistration) instead of a forever-storm. A new
     * server short-circuits this with AGENT_CONFLICT_FATAL; an old server
     * never sends it, and the budget alone still ends the storm.
     *
     * Returns true when this is the FIRST conflict of the episode (the
     * caller logs the human-facing banner exactly once).
     */
    #scheduleRegisterRetry(agentId: string, hint?: { retryAfterS?: number; holderAlive?: boolean }): boolean {
        let state = this.#registerRetries.get(agentId);
        const first = !state;
        if (!state) {
            state = { attempt: 0, timer: null, holderAlive: false, startedAt: Date.now() };
            this.#registerRetries.set(agentId, state);
        }
        if (state.timer) {
            // A retry is already scheduled; still absorb a "holder died" hint.
            if (hint?.holderAlive === false) state.holderAlive = false;
            return first;
        }

        const plan = planConflictRetry(state, hint, Date.now());
        if (plan.action === "terminal") {
            this.#failRegistration(agentId, "retry_budget_exhausted");
            return first;
        }
        const delay = plan.delayMs;

        const timer = setTimeout(() => {
            state!.timer = null;
            const agent = this.#agents.get(agentId);
            if (this.#connected && agent) {
                this.#logger.info(`Retrying registration for "${agentId}" (attempt ${state!.attempt})`);
                this.#registerAgent(agent);
            }
        }, delay);
        // Don't hold the process open just for a retry timer (Node.js)
        (timer as any)?.unref?.();
        state.timer = timer;

        const line = `Registration conflict for "${agentId}" — retrying in ${Math.round(delay / 1000)}s` +
            (state.holderAlive ? " (name actively held elsewhere)" : "");
        // First rejection gets a visible warn; the rest stay quiet (info) —
        // a held name used to spam an error banner every attempt for hours.
        if (first) this.#logger.warn(line);
        else this.#logger.info(line);
        return first;
    }

    /**
     * Give up on a registration — the TERMINAL state for a conflict.
     *
     * Reached either because the server said the holder is provably alive
     * (`AGENT_CONFLICT_FATAL`) or because the retry budget ran out. Drops the
     * retry state (no further attempts) and surfaces a typed
     * {@link AgentConflictError} on the client's `error` event so a developer
     * can catch it — a log line alone is not an API.
     */
    #failRegistration(agentId: string, reason: "server_fatal" | "retry_budget_exhausted"): void {
        const state = this.#registerRetries.get(agentId);
        if (state?.timer) clearTimeout(state.timer);
        this.#registerRetries.delete(agentId);

        const why = reason === "server_fatal"
            ? "the server confirmed another LIVE process holds it"
            : `no registration after ${Math.round(CONFLICT_RETRY_BUDGET_MS / 1000)}s of retries — another LIVE process holds it`;
        const message =
            `Agent "${agentId}" could not be registered: ${why}. ` +
            `Either run \`pinecall kick ${agentId}\` to disconnect the current holder, ` +
            `or register this agent under a different id.`;
        this.#logger.error(message);
        const err = new AgentConflictError(message, agentId, reason);
        // Fail anyone awaiting `agent.ready` (e.g. a token mint) instead of
        // leaving them pending on a registration that will never land.
        this.#agents.get(agentId)?._failRegistration(err);
        this.emit("error", err);
    }

    #clearRegisterRetry(agentId: string): void {
        const state = this.#registerRetries.get(agentId);
        if (state?.timer) clearTimeout(state.timer);
        if (state && state.attempt > 0) {
            this.#logger.info(`Registration for "${agentId}" succeeded after ${state.attempt} retr${state.attempt === 1 ? "y" : "ies"}`);
        }
        this.#registerRetries.delete(agentId);
    }

    #clearAllRegisterRetries(): void {
        for (const state of this.#registerRetries.values()) {
            if (state.timer) clearTimeout(state.timer);
        }
        this.#registerRetries.clear();
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
                // Lines share this namespace on purpose: registered under
                // `line:<number>`, every existing handler routes to one
                // without knowing lines exist.
                const localKeys = new Set(this.#agents.keys());
                for (const line of this.#lines.values()) localKeys.add(line.id);
                const resolved = this.#resolver.resolve(wireId, localKeys);
                if (!resolved) return null;
                if (resolved.startsWith("line:")) {
                    return this.#lines.get(resolved.slice("line:".length))?._agent ?? null;
                }
                return this.#agents.get(resolved) ?? null;
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

                // And re-claim every line's number. A line that comes back
                // from a reconnect without re-sending `line.create` strands
                // its number exactly like an unregistered agent would.
                for (const line of this.#lines.values()) {
                    line._register();
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
            registration: this.#registration,
            // Routed through the friend methods below so each capability has
            // exactly one implementation on this class.
            emitClientEvent: (event, ...args) => this._emitWire(event, ...args),
            allAgents: () => this._allAgents(),
            whatsappSession: (id) => this._getWhatsAppHandler().getSession(id),
            lines: () => [...this.#lines.values()],
        };

        this.#dispatcher.dispatch(wire, ctx);
    }

    #onClose(reason: string): void {
        this.#connected = false;

        if (this.#pingInterval) {
            clearInterval(this.#pingInterval);
            this.#pingInterval = null;
        }

        // Reconnect re-registers every agent — drop per-agent retry timers
        this.#clearAllRegisterRetries();

        // End all active calls. The server drops every registration on this
        // socket too, so `ready` goes back to pending until the reconnect
        // re-registers each agent — otherwise a mint during a reconnect would
        // race `agent.create` exactly like a cold start does.
        for (const agent of this.#agents.values()) {
            agent._endAllCalls(reason);
            agent._markUnregistered();
        }
        for (const line of this.#lines.values()) {
            line._endAllCalls(reason);
            line._markUnregistered();
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

    // ── Friend methods (the client half of the DispatchContext) ──────────

    /** @internal Emit a typed event (the context's `emitClientEvent`). */
    _emitWire(event: string, ...args: unknown[]): void {
        (this as any).emit(event, ...args);
    }

    /** @internal Get an agent by ID. */
    _getAgent(id: string): Agent | undefined {
        return this.#agents.get(id);
    }

    /** @internal Get all registered agents (the context's `allAgents`). Used when agent_id is missing. */
    _allAgents(): Agent[] {
        return [...this.#agents.values()];
    }

    /** @internal Get the WhatsApp handler (backs the context's `whatsappSession`). */
    _getWhatsAppHandler(): WhatsAppHandler {
        return this.#waHandler;
    }
}

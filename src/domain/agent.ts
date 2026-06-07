/**
 * Agent — a logical voice agent within a Pinecall connection.
 *
 * Created via `pc.agent("my-agent", config?)`.
 * Each agent owns channels (phone, webrtc) and receives events
 * independently from other agents on the same connection.
 *
 * The old _handleEvent() 200-line switch is gone. Dispatch handlers now
 * call typed _apply* methods and _emitWire directly.
 */

import { TypedEventBus } from "../kernel/event-bus.js";
import { Call } from "./call.js";
import { RingingCall } from "./ringing-call.js";
import { buildShortcutPayload } from "../protocol/shortcuts.js";
import { createAgentStream } from "../sse/stream.js";
import type { ServerResponse } from "node:http";
import type { Turn } from "./turn.js";
import type { AgentConfig, ChannelConfig, WhatsAppChannelConfig } from "../config/agent.js";
import type { Tool } from "../tool.js";
import type { TokenResponse } from "../api/tokens.js";
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
    SessionTimeoutEvent,
    ToolCallEvent,
} from "../protocol/events.js";

// ─── Agent events ────────────────────────────────────────────────────────

export interface AgentEvents {
    [key: string]: (...args: any[]) => void;

    // Lifecycle
    ready: () => void;
    "call.started": (call: Call) => void;
    "call.ended": (call: Call, reason: string) => void;
    "call.ringing": (call: RingingCall) => void;

    // Speech events
    "speech.started": (event: SpeechStartedEvent, call: Call) => void;
    "speech.ended": (event: SpeechEndedEvent, call: Call) => void;
    "user.speaking": (event: UserSpeakingEvent, call: Call) => void;
    "user.message": (event: UserMessageEvent, call: Call) => void;

    // Turn events
    "eager.turn": (turn: Turn, call: Call) => void;
    "turn.pause": (event: TurnPauseEvent, call: Call) => void;
    "turn.end": (turn: Turn, call: Call) => void;
    "turn.resumed": (event: TurnResumedEvent, call: Call) => void;
    "turn.continued": (event: TurnContinuedEvent, call: Call) => void;

    // Bot events
    "bot.speaking": (event: BotSpeakingEvent, call: Call) => void;
    "bot.word": (event: BotWordEvent, call: Call) => void;
    "bot.finished": (event: BotFinishedEvent, call: Call) => void;
    "bot.interrupted": (event: BotInterruptedEvent, call: Call) => void;

    // Confirmations
    "message.confirmed": (event: MessageConfirmedEvent, call: Call) => void;
    "reply.rejected": (event: ReplyRejectedEvent, call: Call) => void;

    // Analysis
    "audio.metrics": (event: AudioMetricsEvent, call: Call) => void;

    // Session limits
    "session.idleWarning": (event: any, call: Call) => void;
    "session.timeout": (event: SessionTimeoutEvent, call: Call) => void;

    // LLM / Tool calls
    "llm.toolCall": (event: ToolCallEvent, call: Call) => void;

    // Channel events
    "channel.added": (type: string, ref: string) => void;
    "channel.configured": (ref: string) => void;
    "channel.removed": (ref: string) => void;

    // WhatsApp events
    "whatsapp.message": (event: Record<string, unknown>) => void;
    "whatsapp.response": (event: Record<string, unknown>) => void;
    "whatsapp.status": (event: Record<string, unknown>) => void;
    "whatsapp.sessionStarted": (session: import("./wa-session.js").WhatsAppSession) => void;
    "whatsapp.sessionEnded": (event: Record<string, unknown>) => void;

    // Human-in-the-loop
    "session.paused": (event: { sessionId?: string; contact?: string }) => void;
    "session.resumed": (event: { sessionId?: string; contact?: string }) => void;
}

// ─── Agent class ─────────────────────────────────────────────────────────

export class Agent extends TypedEventBus<AgentEvents> {
    readonly id: string;
    /** Human-readable display name. Defaults to id. */
    name: string;
    #config: AgentConfig;
    #tools: Tool[] = [];
    #calls = new Map<string, Call>();
    #sendRaw: (data: Record<string, unknown>) => void;
    #serverReady = false;
    #pendingQueue: Record<string, unknown>[] = [];
    /** Tracks registered channels for re-registration on reconnect. */
    #channels = new Map<string, { type: string; ref?: string; config?: ChannelConfig }>();
    /** Tracked dev callers for re-registration on reconnect. */
    #devCallers: string[] = [];
    /** @internal Reference to parent Pinecall client (for createToken). */
    #client: {
        createToken: (channel: "webrtc" | "chat", agentId: string) => Promise<TokenResponse>;
    } | null = null;

    /** @internal — created by Pinecall.agent() */
    constructor(
        id: string,
        config: AgentConfig,
        send: (data: Record<string, unknown>) => void,
    ) {
        super();
        this.id = id;
        this.name = id;
        this.#config = config;
        this.#tools = config.tools ?? [];
        this.#sendRaw = send;
    }

    /**
     * Send a raw protocol message. Buffers if the agent isn't server-ready yet.
     *
     * Prefer high-level methods like `call.toolResult()`, `call.say()`,
     * `call.reply()`, `agent.setDevCallers()` etc. Use `send()` only
     * as an escape hatch for protocol-level access.
     */
    send(data: Record<string, unknown>): void {
        if (this.#serverReady) {
            this.#sendRaw(data);
        } else {
            this.#pendingQueue.push(data);
        }
    }

    /** @internal Alias for backwards compat — use send() instead. */
    _send(data: Record<string, unknown>): void {
        this.send(data);
    }

    // ── Public getters ───────────────────────────────────────────────────

    /** All active calls for this agent. */
    get calls(): ReadonlyMap<string, Call> {
        return this.#calls;
    }

    /** Get a specific call by ID. */
    call(callId: string): Call | undefined {
        return this.#calls.get(callId);
    }

    /** Get the current agent config. */
    getConfig(): AgentConfig {
        return this.#config;
    }

    // ── Channel management ───────────────────────────────────────────────

    /**
     * Register a phone number or SIP URI. Idempotent — calling again with the
     * same number updates its config.
     *
     * @example
     * agent.addPhoneNumber("+13186330963");
     * agent.addPhoneNumber("+34612345678", { ringing: true, voice: "elevenlabs/lucia" });
     * agent.addPhoneNumber("sip:bot@trunk.twilio.com");
     */
    addPhoneNumber(number: string, config?: ChannelConfig): void {
        this._addChannel("phone", number, config);
    }

    /**
     * Register a WhatsApp channel. Idempotent — calling again with the
     * same phoneNumberId updates its config.
     *
     * @example
     * agent.addWhatsapp({ phoneNumberId: "123", accessToken: "EAA..." });
     */
    addWhatsapp(config: WhatsAppChannelConfig): void {
        this._addChannel("whatsapp", config);
    }

    /**
     * Remove a phone number or SIP URI.
     *
     * @example agent.removePhone("+13186330963");
     */
    removePhone(number: string): void {
        this.#channels.delete(number);
        this._send({ event: "channel.remove", agent_id: this.id, type: "phone", ref: number });
    }

    /**
     * Remove a WhatsApp channel by phoneNumberId.
     *
     * @example agent.removeWhatsapp("123");
     */
    removeWhatsapp(phoneNumberId: string): void {
        this.#channels.delete(phoneNumberId);
        this._send({ event: "channel.remove", agent_id: this.id, type: "whatsapp", ref: phoneNumberId });
    }

    /** @internal — used by client.ts and config processing. */
    _addChannel(type: "phone" | "webrtc" | "chat" | "whatsapp", ref?: string | WhatsAppChannelConfig, config?: ChannelConfig): void {
        // Validate phone numbers early (SIP URIs pass through)
        if (type === "phone" && typeof ref === "string" && ref && !ref.startsWith("sip:")) {
            const cleaned = ref.replace(/[\s\-()]/g, "");
            const normalized = cleaned.startsWith("+") ? cleaned : "+" + cleaned;
            const digits = normalized.slice(1);
            if (!/^\d+$/.test(digits) || digits.length < 7 || digits.length > 15) {
                throw new Error(`Invalid phone number "${ref}": must be E.164 format (+, 7-15 digits)`);
            }
        }

        // Track for re-registration on reconnect
        const key = (typeof ref === "string" ? ref : undefined) ?? type;
        this.#channels.set(key, { type, ref: typeof ref === "string" ? ref : undefined, config: typeof ref === "object" ? ref : config });

        // WhatsApp: ref is a WhatsAppChannelConfig object
        if (type === "whatsapp" && typeof ref === "object" && ref !== null) {
            const waConfig = ref as WhatsAppChannelConfig;
            const msg = {
                event: "channel.add",
                agent_id: this.id,
                type: "whatsapp",
                ref: waConfig.phoneNumberId,
                accessToken: waConfig.accessToken,
                ...(waConfig.verifyToken ? { verifyToken: waConfig.verifyToken } : {}),
                ...(waConfig.appSecret ? { appSecret: waConfig.appSecret } : {}),
                ...(waConfig.phone ? { phone: waConfig.phone } : {}),
                ...buildShortcutPayload(waConfig),
            };
            this._send(msg);
            return;
        }

        const msg = {
            event: "channel.add",
            agent_id: this.id,
            type,
            ...(typeof ref === "string" && ref ? { ref } : {}),
            ...buildShortcutPayload(config),
            ...(config?.ringing ? { ringing: true } : {}),
        };
        this._send(msg);
    }

    configureChannel(ref: string, config: ChannelConfig): void {
        this._send({
            event: "channel.configure",
            agent_id: this.id,
            ref,
            ...buildShortcutPayload(config),
        });
    }

    removeChannel(ref: string): void {
        this.#channels.delete(ref);
        this._send({
            event: "channel.remove",
            agent_id: this.id,
            ref,
        });
    }

    // ── Agent configuration ──────────────────────────────────────────────

    update(opts: AgentConfig): void {
        this.#config = { ...this.#config, ...opts };
        this._send({
            event: "agent.configure",
            agent_id: this.id,
            ...buildShortcutPayload(opts),
        });
    }

    /** @deprecated Use `agent.update()` instead. */
    configure(opts: AgentConfig): void {
        this.update(opts);
    }

    configureSession(sessionId: string, opts: ChannelConfig): void {
        this._send({
            event: "session.configure",
            agent_id: this.id,
            session_id: sessionId,
            ...buildShortcutPayload(opts),
        });
    }

    // ── Development ──────────────────────────────────────────────────────

    routeCallers(callers: string[]): void {
        this.#devCallers = callers;
        this.send({ event: "dev.config", callers });
    }

    // ── Event Streaming ──────────────────────────────────────────────────

    stream(): Response;
    stream(res: ServerResponse): void;
    stream(res?: ServerResponse): Response | void {
        if (res) return createAgentStream(this, res);
        return createAgentStream(this);
    }

    // ── Token generation ─────────────────────────────────────────────────

    async createToken(channel: "webrtc" | "chat"): Promise<TokenResponse> {
        if (!this.#client) {
            throw new Error(
                "Cannot create token: agent is not connected to a Pinecall client. " +
                "Use pc.createToken(channel, agentId) instead.",
            );
        }
        return this.#client.createToken(channel, this.id);
    }

    /** @internal Set the parent Pinecall client reference. */
    _setClient(client: {
        createToken: (channel: "webrtc" | "chat", agentId: string) => Promise<TokenResponse>;
    }): void {
        this.#client = client;
    }

    // ── Dial ──────────────────────────────────────────────────────────────

    dial(options: {
        to: string;
        /** Caller ID. If omitted, uses the agent's only phone channel. */
        from?: string;
        greeting?: string;
        metadata?: Record<string, unknown>;
        config?: Record<string, unknown>;
    }): Promise<Call> {
        // Auto-resolve `from` if not provided
        let from = options.from;
        if (!from) {
            const phoneChannels: string[] = [];
            for (const [key, ch] of this.#channels) {
                if (ch.type === "phone" && ch.ref) phoneChannels.push(ch.ref);
            }
            if (phoneChannels.length === 0) {
                return Promise.reject(new Error(
                    "No phone numbers registered. Add one with `phoneNumber: \"+1...\"` or pass `from` explicitly.",
                ));
            }
            if (phoneChannels.length > 1) {
                return Promise.reject(new Error(
                    `Multiple phone channels registered (${phoneChannels.join(", ")}). Pass \`from\` to specify which one to use.`,
                ));
            }
            from = phoneChannels[0];
        }

        return new Promise<Call>((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                this.off("call.started", onStarted);
                this.off("call.ended", onEnded);
                this.off("error" as any, onError);
            };
            const onStarted = (call: Call) => {
                if (call.to === options.to || call.direction === "outbound") {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    if (options.greeting) call.greeting = options.greeting;
                    resolve(call);
                }
            };
            const onEnded = (call: Call | null, reason: string) => {
                // Outbound call ended before connecting (busy, no-answer, failed, canceled)
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error(reason || "call_rejected"));
            };
            const onError = (err: Error) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(err);
            };
            this.on("call.started", onStarted);
            this.on("call.ended", onEnded);
            this.on("error" as any, onError);

            this._send({
                event: "call.dial",
                agent_id: this.id,
                to: options.to,
                from,
                ...(options.greeting ? { greeting: options.greeting } : {}),
                ...(options.metadata ? { metadata: options.metadata } : {}),
                ...(options.config ? { config: options.config } : {}),
            });

            setTimeout(() => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error("Dial timeout"));
            }, 30000);
        });
    }

    // ── Human-in-the-loop ─────────────────────────────────────────────────

    /**
     * Pause the AI agent. While paused, incoming messages are forwarded to
     * the SDK but the LLM does not generate responses — a human takes over.
     *
     * @param target - Session ID, `{ contact: "+34..." }`, or omit for global pause.
     */
    pause(target?: string | { contact: string }): void {
        const msg: Record<string, unknown> = {
            event: "session.pause",
            agent_id: this.id,
        };
        if (typeof target === "string") {
            msg.session_id = target;
        } else if (target && "contact" in target) {
            msg.contact = target.contact;
        }
        this.send(msg);
    }

    /**
     * Resume the AI agent after a pause.
     *
     * @param target - Session ID, `{ contact: "+34..." }`, or omit for global resume.
     */
    resume(target?: string | { contact: string }): void {
        const msg: Record<string, unknown> = {
            event: "session.resume",
            agent_id: this.id,
        };
        if (typeof target === "string") {
            msg.session_id = target;
        } else if (target && "contact" in target) {
            msg.contact = target.contact;
        }
        this.send(msg);
    }

    /**
     * Send a message as the human operator (not AI-generated).
     * Works while the session is paused — the message is sent through the
     * channel (WhatsApp, etc.) and added to LLM history for context.
     */
    sendMessage(opts: { sessionId: string; text: string }): void {
        this.send({
            event: "session.send",
            agent_id: this.id,
            session_id: opts.sessionId,
            text: opts.text,
        });
    }

    // ── Dispatch-only API (friend methods) ───────────────────────────────

    /** @internal End all calls (on disconnect). */
    _endAllCalls(reason: string): void {
        for (const call of this.#calls.values()) {
            call._applyEnd(reason);
        }
        this.#calls.clear();
        this.#serverReady = false;
    }

    /** @internal Emit a typed event — used by dispatch handlers. */
    _emitWire<K extends keyof AgentEvents>(event: K, ...args: Parameters<AgentEvents[K]>): void {
        this.emit(event, ...args);
    }

    /** @internal Get a call by ID. */
    _getCall(callId: string): Call | undefined {
        return this.#calls.get(callId);
    }

    /** @internal Set a call in the registry. */
    _setCall(callId: string, call: Call): void {
        this.#calls.set(callId, call);
    }

    /** @internal Remove a call from the registry. */
    _deleteCall(callId: string): boolean {
        return this.#calls.delete(callId);
    }

    /** @internal Check if a call exists. */
    _hasCall(callId: string): boolean {
        return this.#calls.has(callId);
    }

    /** @internal Get channels map (for PHONE_IN_USE handling). */
    _getChannels(): Map<string, { type: string; ref?: string; config?: ChannelConfig }> {
        return this.#channels;
    }

    /** @internal Get executable Tool objects for auto-dispatch. */
    _getTools(): Tool[] {
        return this.#tools;
    }

    /** @internal Mark agent as server-ready and flush buffered messages. */
    _flushPending(): void {
        this.#serverReady = true;

        // Re-register all tracked channels (critical for reconnection)
        for (const [key, ch] of this.#channels) {
            // WhatsApp channels need special handling
            if (ch.type === "whatsapp" && ch.config) {
                const waConfig = ch.config as any;
                const msg = {
                    event: "channel.add",
                    agent_id: this.id,
                    type: "whatsapp",
                    ref: waConfig.phoneNumberId,
                    accessToken: waConfig.accessToken,
                    ...(waConfig.verifyToken ? { verifyToken: waConfig.verifyToken } : {}),
                    ...(waConfig.appSecret ? { appSecret: waConfig.appSecret } : {}),
                    ...buildShortcutPayload(waConfig),
                };
                this.#sendRaw(msg);
            } else {
                const msg = {
                    event: "channel.add",
                    agent_id: this.id,
                    type: ch.type,
                    ...(ch.ref ? { ref: ch.ref } : {}),
                    ...buildShortcutPayload(ch.config),
                    ...(ch.config?.ringing ? { ringing: true } : {}),
                };
                this.#sendRaw(msg);
            }
        }

        // Re-send dev callers if configured
        if (this.#devCallers.length > 0) {
            this.#sendRaw({ event: "dev.config", callers: this.#devCallers });
        }

        // Flush any other pending messages (skip channel.add and dev.config — already handled above)
        for (const msg of this.#pendingQueue) {
            if (msg.event === "channel.add" || msg.event === "dev.config") continue;
            this.#sendRaw(msg);
        }
        this.#pendingQueue = [];
    }
}

// ── Re-export ────────────────────────────────────────────────────────────

export { buildShortcutPayload } from "../protocol/shortcuts.js";

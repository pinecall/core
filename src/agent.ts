/**
 * Agent — a logical voice agent within a Pinecall connection.
 *
 * Created via `pc.agent("my-agent", config?)`.
 * Each agent owns channels (phone, webrtc, mic) and receives events
 * independently from other agents on the same connection.
 *
 * @example
 * ```ts
 * const sales = pc.agent("sales-bot", {
 *   voice: "elevenlabs:abc",
 *   language: "es",
 * });
 * sales.addChannel("phone", "+19035551234");
 * sales.addChannel("webrtc");
 *
 * sales.on("call.started", (call) => {
 *   call.say("¡Hola!");
 * });
 * ```
 */

import { TypedEmitter } from "./utils/emitter.js";
import { Call, type Turn } from "./call.js";
import { forwardCallEvents } from "./utils/proxy.js";
import { buildShortcutPayload } from "./utils/protocol.js";
import { createAgentStream } from "./sse.js";
import type { ServerResponse } from "node:http";
import type { SessionConfig } from "./types/config.js";
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
} from "./types/events.js";

// ─── Shortcut types ──────────────────────────────────────────────────────

/** Voice shortcut: "elevenlabs:voiceId" or full config object. */
export type VoiceShortcut = string | Record<string, unknown>;

/** STT shortcut: "deepgram" or full config object. */
export type STTShortcut = string | Record<string, unknown>;

/** Interruption shortcut: false (disable) or config object. */
export type InterruptionShortcut = boolean | Record<string, unknown>;

// ─── Agent config ────────────────────────────────────────────────────────

export interface AgentConfig {
    voice?: VoiceShortcut;
    language?: string;
    stt?: STTShortcut;
    interruption?: InterruptionShortcut;
    /** Server-side LLM: "openai:gpt-4.1-nano" or full config object. */
    llm?: string | Record<string, unknown>;
    /** OpenAI-format tool definitions for server-side LLM. */
    tools?: Array<Record<string, unknown>>;
    config?: SessionConfig;
    /** Persist conversations to MongoDB on the voice server. */
    historySave?: boolean;
}

export interface ChannelConfig {
    voice?: VoiceShortcut;
    language?: string;
    stt?: STTShortcut;
    interruption?: InterruptionShortcut;
    /** Server-side LLM: "openai:gpt-4.1-nano" or full config object. */
    llm?: string | Record<string, unknown>;
    config?: Partial<SessionConfig>;
}

// ─── Agent events ────────────────────────────────────────────────────────

export interface AgentEvents {
    [key: string]: (...args: any[]) => void;

    // Lifecycle
    ready: () => void;
    "call.started": (call: Call) => void;
    "call.ended": (call: Call, reason: string) => void;

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
    "session.idle_warning": (event: any, call: Call) => void;
    "session.timeout": (event: SessionTimeoutEvent, call: Call) => void;

    // Channel events
    "channel.added": (type: string, ref: string) => void;
    "channel.configured": (ref: string) => void;
    "channel.removed": (ref: string) => void;
}

// ─── Agent class ─────────────────────────────────────────────────────────

export class Agent extends TypedEmitter<AgentEvents> {
    readonly id: string;
    /** Human-readable display name. Defaults to id. */
    name: string;
    private _config: AgentConfig;
    private _calls = new Map<string, Call>();
    private _sendRaw: (data: Record<string, unknown>) => void;
    private _serverReady = false;
    private _pendingQueue: Record<string, unknown>[] = [];
    /** Tracks registered channels for re-registration on reconnect. */
    private _channels = new Map<string, { type: string; ref?: string; config?: ChannelConfig }>();

    /** @internal — created by Pinecall.agent() */
    constructor(
        id: string,
        config: AgentConfig,
        send: (data: Record<string, unknown>) => void,
    ) {
        super();
        this.id = id;
        this.name = id;
        this._config = config;
        this._sendRaw = send;
    }

    /**
     * Send a raw protocol message. Buffers if the agent isn't server-ready yet.
     *
     * @example
     * agent.send({ event: "llm.tool_result", call_id, msg_id, results });
     */
    send(data: Record<string, unknown>): void {
        if (this._serverReady) {
            this._sendRaw(data);
        } else {
            this._pendingQueue.push(data);
        }
    }

    /** @internal Alias for backwards compat — use send() instead. */
    _send(data: Record<string, unknown>): void {
        this.send(data);
    }

    // ── Public getters ───────────────────────────────────────────────────

    /** All active calls for this agent. */
    get calls(): ReadonlyMap<string, Call> {
        return this._calls;
    }

    /** Get a specific call by ID. */
    call(callId: string): Call | undefined {
        return this._calls.get(callId);
    }

    /** Get the current agent config. */
    getConfig(): AgentConfig {
        return this._config;
    }

    // ── Channel management ───────────────────────────────────────────────

    /**
     * Add a channel to this agent.
     *
     * @param type - "phone", "webrtc", or "mic"
     * @param ref - Phone number for phone, or optional ref for webrtc/mic
     * @param config - Optional config override for this channel
     *
     * @example
     * agent.addChannel("phone", "+19035551234");
     * agent.addChannel("phone", "+19035555678", { voice: "cartesia:uuid" });
     * agent.addChannel("webrtc");
     */
    addChannel(type: "phone" | "webrtc" | "mic" | "chat", ref?: string, config?: ChannelConfig): void {
        // Validate phone numbers early (SIP URIs pass through)
        if (type === "phone" && ref && !ref.startsWith("sip:")) {
            const cleaned = ref.replace(/[\s\-()]/g, "");
            const normalized = cleaned.startsWith("+") ? cleaned : "+" + cleaned;
            const digits = normalized.slice(1);
            if (!/^\d+$/.test(digits) || digits.length < 7 || digits.length > 15) {
                throw new Error(`Invalid phone number "${ref}": must be E.164 format (+, 7-15 digits)`);
            }
        }

        // Track for re-registration on reconnect
        const key = ref ?? type;
        this._channels.set(key, { type, ref, config });

        const msg = {
            event: "channel.add",
            agent_id: this.id,
            type,
            ...(ref ? { ref } : {}),
            ...buildShortcutPayload(config),
        };

        this._send(msg);
    }

    /**
     * Update config for an existing channel.
     *
     * @example agent.configureChannel("+19035551234", { voice: "cartesia:uuid" });
     */
    configureChannel(ref: string, config: ChannelConfig): void {
        this._send({
            event: "channel.configure",
            agent_id: this.id,
            ref,
            ...buildShortcutPayload(config),
        });
    }

    /**
     * Remove a channel from this agent.
     *
     * @example agent.removeChannel("+19035551234");
     */
    removeChannel(ref: string): void {
        this._channels.delete(ref);
        this._send({
            event: "channel.remove",
            agent_id: this.id,
            ref,
        });
    }

    // ── Agent configuration ──────────────────────────────────────────────

    /**
     * Update agent-wide defaults. Affects all future sessions.
     *
     * @example agent.configure({ voice: "elevenlabs:abc", language: "es" });
     */
    configure(opts: AgentConfig): void {
        this._config = { ...this._config, ...opts };
        this._send({
            event: "agent.configure",
            agent_id: this.id,
            ...buildShortcutPayload(opts),
        });
    }

    /**
     * Update config for an active session (mid-call).
     *
     * @example
     * agent.on("turn.end", (turn, call) => {
     *   agent.configureSession(call.id, { voice: "cartesia:uuid" });
     * });
     */
    configureSession(sessionId: string, opts: ChannelConfig): void {
        this._send({
            event: "session.configure",
            agent_id: this.id,
            session_id: sessionId,
            ...buildShortcutPayload(opts),
        });
    }

    // ── Event Streaming ──────────────────────────────────────────────────

    /**
     * Stream this agent's events as Server-Sent Events (SSE).
     *
     * Works with any framework:
     *   - Web API: `return agent.stream()` → Response (Remix, Next, Hono, Bun)
     *   - Node.js: `agent.stream(res)` → writes to ServerResponse (Express, Fastify)
     *
     * @example
     * // Remix / Next.js / Hono / SvelteKit
     * export async function GET() {
     *   return mara.stream();
     * }
     *
     * // Express
     * app.get("/events", (req, res) => mara.stream(res));
     */
    stream(): Response;
    stream(res: ServerResponse): void;
    stream(res?: ServerResponse): Response | void {
        if (res) return createAgentStream(this, res);
        return createAgentStream(this);
    }

    // ── Dial ──────────────────────────────────────────────────────────────

    /**
     * Initiate an outbound call from this agent.
     *
     * @example
     * const call = await agent.dial({ to: "+1234567890", from: "+0987654321" });
     *
     * // With per-call config override (STT, voice, language):
     * const call = await agent.dial({
     *     to: "+1234567890",
     *     from: "+0987654321",
     *     config: { stt: "deepgram", language: "ar", voice: "elevenlabs:abc" },
     * });
     */
    dial(options: {
        to: string;
        from: string;
        greeting?: string;
        metadata?: Record<string, unknown>;
        /** Per-call config override — merged on top of the channel's base config. */
        config?: Record<string, unknown>;
    }): Promise<Call> {
        return new Promise<Call>((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                this.off("call.started", onStarted);
                this.off("error" as any, onError);
            };
            const onStarted = (call: Call) => {
                if (call.to === options.to || call.direction === "outbound") {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    resolve(call);
                }
            };
            const onError = (err: Error) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(err);
            };
            this.on("call.started", onStarted);
            this.on("error" as any, onError);

            this._send({
                event: "call.dial",
                agent_id: this.id,
                to: options.to,
                from: options.from,
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

    // ── Internal: event handling ──────────────────────────────────────────

    /** @internal Route a server event to this agent. */
    _handleEvent(data: Record<string, unknown>): void {
        const eventType = data.event as string;

        switch (eventType) {
            case "call.started": {
                const callId = data.call_id as string;
                if (callId && !this._calls.has(callId)) {
                    const call = new Call(
                        {
                            call_id: callId,
                            from: (data.from as string) ?? "",
                            to: (data.to as string) ?? "",
                            direction: (data.direction as "inbound" | "outbound") ?? "inbound",
                            transport: (data.transport as "webrtc" | "phone" | "unknown") ?? "unknown",
                            metadata: data.metadata as Record<string, unknown>,
                        },
                        (msg) => this._send({ ...msg, agent_id: this.id }),
                    );
                    this._calls.set(callId, call);
                    this._proxyCallEvents(call);
                    this.emit("call.started", call);
                    if (call.transport === "webrtc") {
                        // Also emit webrtc.started so PinecallAgent can fire onCallStarted
                        this.emit("webrtc.started" as any, call);
                    }
                }
                break;
            }

            case "call.ended": {
                const callId = data.call_id as string;
                let call = this._calls.get(callId);
                if (call) {
                    call._end(data.reason as string, data);
                    this._calls.delete(callId);
                    this.emit("call.ended", call, data.reason as string);
                } else {
                    // Call never connected (busy/no-answer/failed outbound)
                    // Create a temporary Call so onCallEnded can still fire
                    const tempCall = new Call(
                        {
                            call_id: callId,
                            from: (data.from as string) || "",
                            to: (data.to as string) || "",
                            direction: (data.direction as "inbound" | "outbound") || "outbound",
                            transport: "phone",
                            metadata: (data.metadata as Record<string, unknown>) || {},
                        },
                        () => {},
                    );
                    tempCall._end(data.reason as string, data);
                    this.emit("call.ended", tempCall, data.reason as string);
                }
                break;
            }

            case "channel.added":
                this.emit("channel.added", data.type as string, data.ref as string);
                break;

            case "channel.configured":
                this.emit("channel.configured", data.ref as string);
                break;

            case "channel.removed":
                this.emit("channel.removed", data.ref as string);
                break;

            default: {
                // ── LLM Chat events (session_id, no call) ──
                // llm.chat.* events use session_id instead of call_id.
                if (eventType.startsWith("llm.chat.")) {
                    // llm.chat.started: create a Call for tool execution context.
                    // - Uses no-op _send to prevent bot.reply/call.hangup commands
                    //   from reaching the server (chat has no voice session).
                    // - Does NOT proxy call events (prevents call.started from reaching
                    //   the EventServer/dashboard, which would treat it as a phone call).
                    // - Emits "chat.started" instead of "call.started" so PinecallAgent
                    //   can fire onCallStarted without confusing the dashboard.
                    if (eventType === "llm.chat.started") {
                        const chatCallId = data.call_id as string;

                        if (chatCallId && !this._calls.has(chatCallId)) {
                            const noop = () => {}; // Chat Call doesn't send commands to server
                            const call = new Call(
                                {
                                    call_id: chatCallId,
                                    from: (data.from as string) ?? "chat",
                                    to: (data.to as string) ?? "chat",
                                    direction: (data.direction as "inbound" | "outbound") ?? "inbound",
                                    transport: "chat" as any,
                                    metadata: (data.metadata as Record<string, unknown>) ?? {},
                                },
                                noop as any,
                            );
                            this._calls.set(chatCallId, call);

                            // Emit chat.started (NOT call.started) — PinecallAgent wires this
                            this.emit("chat.started" as any, call);
                        }
                    }
                    this.emit(eventType as any, data);
                    break;
                }

                // ── Chat tool calls: call_id is a chat session ──
                // Reuse the Call created by llm.chat.started (has metadata).
                const callId = data.call_id as string;
                if (callId && callId.startsWith("chat-") && eventType === "llm.tool_call") {
                    let call = this._calls.get(callId);

                    if (!call) {
                        // Fallback: create a bare Call if llm.chat.started didn't arrive

                        call = new Call(
                            {
                                call_id: callId,
                                from: "chat",
                                to: "chat",
                                direction: "inbound",
                                transport: "webrtc",
                                metadata: {},
                            },
                            (msg: Record<string, unknown>) => this._send({ ...msg, agent_id: this.id }),
                        );
                        this._calls.set(callId, call);
                    }
                    // Emit llm.tool_call on agent so _executeServerTools picks it up
                    this.emit(eventType as any, call, data);
                    break;
                }

                // ── Conversation responses (agent-scoped, not call-scoped) ──
                if (eventType.startsWith("conversation")) {
                    this.emit(eventType as any, data);
                    break;
                }

                // ── Session events: never auto-create calls ──
                if (callId && eventType.startsWith("session.")) {
                    const call = this._calls.get(callId);
                    if (call) {
                        call._handleEvent(data);
                        this.emit(eventType as any, data, call);
                    }
                    // If call doesn't exist (already ended), silently ignore
                    break;
                }

                // Route to call
                if (callId) {
                    let call = this._calls.get(callId);

                    // Auto-create call for events with call_id but no existing Call.
                    // WebRTC sessions don't send call.started — the Call gets created
                    // here on the first event. This covers both:
                    //   - Server-side LLM (llm.* events arrive first)
                    //   - Client-side LLM (user.message/turn.end/speech.* arrive first)
                    if (!call) {
                        call = new Call(
                            {
                                call_id: callId,
                                from: (data.from as string) || "",
                                to: (data.to as string) || "",
                                direction: (data.direction as "inbound" | "outbound") || "inbound",
                                transport: "webrtc",
                                metadata: (data.metadata as Record<string, unknown>) ?? {},
                            },
                            (msg: Record<string, unknown>) => this._send({ ...msg, agent_id: this.id }),
                        );
                        this._calls.set(callId, call);
                        this._proxyCallEvents(call);
                        this.emit("call.started", call);
                    }

                    if (call) {
                        call._handleEvent(data);
                        // Emit llm.* events on agent too — they aren't proxied
                        // from Call (unlike user.message, bot.speaking, etc.)
                        if (eventType.startsWith("llm.")) {
                            this.emit(eventType as any, call, data);
                        }
                    }
                }
                break;
            }
        }
    }

    /** @internal End all calls (on disconnect). */
    _endAllCalls(reason: string): void {
        for (const call of this._calls.values()) {
            call._end(reason);
        }
        this._calls.clear();
        // Reset server-ready so _flushPending re-runs on reconnect
        this._serverReady = false;
    }

    /** @internal Emit an event — used by Pinecall to trigger events on this agent. */
    _emit<K extends keyof AgentEvents>(event: K, ...args: Parameters<AgentEvents[K]>): void {
        this.emit(event, ...args);
    }

    /** @internal Mark agent as server-ready and flush buffered messages. */
    _flushPending(): void {
        this._serverReady = true;


        // Re-register all tracked channels (critical for reconnection)
        for (const [key, ch] of this._channels) {
            const msg = {
                event: "channel.add",
                agent_id: this.id,
                type: ch.type,
                ...(ch.ref ? { ref: ch.ref } : {}),
                ...buildShortcutPayload(ch.config),
            };

            this._sendRaw(msg);
        }

        // Flush any other pending messages (skip channel.add — already handled above)
        for (const msg of this._pendingQueue) {
            if (msg.event === "channel.add") continue;
            this._sendRaw(msg);
        }
        this._pendingQueue = [];
    }

    /** @internal Proxy call events to agent level. */
    private _proxyCallEvents(call: Call): void {
        forwardCallEvents(call, this, call);
    }
}

// ── Re-export ────────────────────────────────────────────────────────────

// Re-export for backward compatibility (was originally defined here)
export { buildShortcutPayload } from "./utils/protocol.js";

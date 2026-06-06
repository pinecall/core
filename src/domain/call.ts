/**
 * Call — per-session handle for interacting with a voice call.
 *
 * Created automatically when `call.started` is received.
 * Provides high-level methods: say(), reply(), replyStream(), hold(), mute(), cancel(), hangup().
 *
 * Tracks `lastMessageId` from user.message events for automatic `in_reply_to`.
 *
 * The old _handleEvent() 140-line switch is gone. Dispatch handlers now call
 * typed _apply* methods directly. Each method is small, typed, and explicit.
 */

import { TypedEventBus } from "../kernel/event-bus.js";
import { generateId } from "../kernel/id.js";
import { ReplyStream } from "./reply-stream.js";
import type { Turn } from "./turn.js";
import type {
    SpeechStartedEvent,
    SpeechEndedEvent,
    UserSpeakingEvent,
    UserMessageEvent,
    TurnPauseEvent,
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
import type { SessionConfig } from "../config/session.js";
import type { ConversationRecord, HistoryStore } from "../history.js";

// ─── Call-scoped event map ───────────────────────────────────────────────

export interface CallEvents {
    [key: string]: (...args: any[]) => void;
    "speech.started": (event: SpeechStartedEvent) => void;
    "speech.ended": (event: SpeechEndedEvent) => void;
    "user.speaking": (event: UserSpeakingEvent) => void;
    "user.message": (event: UserMessageEvent) => void;
    "eager.turn": (turn: Turn) => void;
    "turn.pause": (event: TurnPauseEvent) => void;
    "turn.end": (turn: Turn) => void;
    "turn.resumed": (event: TurnResumedEvent) => void;
    "turn.continued": (event: TurnContinuedEvent) => void;
    "bot.speaking": (event: BotSpeakingEvent) => void;
    "bot.word": (event: BotWordEvent) => void;
    "bot.finished": (event: BotFinishedEvent) => void;
    "bot.interrupted": (event: BotInterruptedEvent) => void;
    "message.confirmed": (event: MessageConfirmedEvent) => void;
    "reply.rejected": (event: ReplyRejectedEvent) => void;
    "audio.metrics": (event: AudioMetricsEvent) => void;
    "call.held": () => void;
    "call.unheld": () => void;
    "call.muted": () => void;
    "call.unmuted": (mutedTranscript: string | null) => void;
    "llm.tool_call": (event: ToolCallEvent) => void;
    "session.timeout": (event: SessionTimeoutEvent) => void;
    "ended": (reason: string) => void;
}

// ─── Reply options ───────────────────────────────────────────────────────

export interface ReplyOptions {
    messageId?: string;
    inReplyTo?: string;
}

export interface ForwardOptions {
    message?: string;
    announce?: boolean;
}

// ─── Call class ──────────────────────────────────────────────────────────

export class Call extends TypedEventBus<CallEvents> {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly direction: "inbound" | "outbound";
    readonly transport: "webrtc" | "phone" | "unknown";
    readonly metadata: Record<string, unknown>;

    /** Auto-tracked from the latest user.message. Used as default `in_reply_to`. */
    lastMessageId: string | null = null;

    /** Conversation transcript (user + assistant messages only). Derived from `messages`. */
    get transcript(): Array<{ role: string; content: string }> {
        return this.messages
            .filter(m => (m.role === "user" || m.role === "assistant") && m.content)
            .map(m => ({ role: m.role as string, content: m.content as string }));
    }
    /** Full LLM message history. Built incrementally from events; server copy merged on call.ended. */
    messages: Array<Record<string, unknown>> = [];
    /** Conversation status. `"active"` during call, `"ended"` after call.ended. */
    status: "active" | "ended" = "active";
    /** Call duration in seconds. Populated on call.ended. */
    duration: number = 0;
    /** Epoch seconds when call started. Populated on call.ended. */
    startedAt: number = 0;
    /** Epoch seconds when call ended. Populated on call.ended. */
    endedAt: number = 0;
    /** End reason (e.g. "hangup", "timeout"). Populated on call.ended. */
    reason: string = "";

    /** Outbound greeting (set by dial). Used by streamSSE to send the first transcript entry. */
    greeting: string | null = null;

    /** Active ReplyStreams — aborted automatically on turn.continued. */
    #activeStreams = new Set<ReplyStream>();

    /** @internal Base prompt template (for variable interpolation). */
    _promptTemplate = "";

    /** @internal Prompts directory (set by agent). */
    _promptsDir = "prompts";

    /** Send function provided by Pinecall client. */
    #send: (data: Record<string, unknown>) => void;

    // Latest turn data (built from eager.turn + user.message + turn.end)
    #lastTurnId = 0;
    #lastTurnText = "";
    #lastTurnConfidence = 0;
    #lastTurnLanguage: string | undefined;

    /** @internal Pending response resolvers for request/response events. */
    #pendingResponses = new Map<string, (data: any) => void>();

    /** @internal Agent reference for history saves. Set by lifecycle handler. */
    #historyStore: HistoryStore | undefined;
    #historyAgentId = "";
    #historySaveTimer: ReturnType<typeof setTimeout> | undefined;
    /** Debounce interval for incremental history saves (ms). */
    static HISTORY_DEBOUNCE_MS = 200;

    constructor(
        data: {
            call_id: string;
            from: string;
            to: string;
            direction: "inbound" | "outbound";
            transport?: "webrtc" | "phone" | "unknown";
            metadata?: Record<string, unknown>;
        },
        send: (data: Record<string, unknown>) => void,
    ) {
        super();
        this.id = data.call_id;
        this.from = data.from;
        this.to = data.to;
        this.direction = data.direction;
        this.transport = data.transport ?? "unknown";
        this.metadata = data.metadata ?? {};
        this.#send = send;
    }

    // ── High-level reply methods ─────────────────────────────────────────

    /**
     * Send a greeting or standalone message (no in_reply_to required).
     *
     * Pass `{ addToHistory: true }` to inject this text into the server-side
     * LLM conversation history as an assistant message, so the model knows
     * what was said and won't repeat it.
     */
    say(text: string, opts?: { addToHistory?: boolean }): void {
        this.#send({
            event: "bot.reply",
            call_id: this.id,
            message_id: generateId("msg"),
            text,
            in_reply_to: "",
            ...(opts?.addToHistory ? { add_to_history: true } : {}),
        });
    }

    /** Reply to the latest user message (auto-tracks in_reply_to). */
    reply(text: string, options?: ReplyOptions): void {
        const id = options?.messageId ?? generateId("msg");
        const inReplyTo = options?.inReplyTo ?? this.lastMessageId ?? "";
        this.#send({
            event: "bot.reply",
            call_id: this.id,
            message_id: id,
            text,
            in_reply_to: inReplyTo,
        });
    }

    /** Create a streaming reply. Write tokens, then end. */
    replyStream(turn?: Turn, messageId?: string): ReplyStream {
        const inReplyTo = turn?.messageId ?? this.lastMessageId ?? "";
        const stream = new ReplyStream({
            callId: this.id,
            messageId: messageId ?? generateId("msg"),
            inReplyTo,
            send: (data) => this.#send(data),
            onComplete: () => this.#activeStreams.delete(stream),
        });
        this.#activeStreams.add(stream);
        return stream;
    }

    /** Respond to a server-side LLM tool call. */
    toolResult(
        msgId: string,
        results: Array<{ toolCallId: string; result: unknown }>,
    ): void {
        this.#send({
            event: "llm.tool_result",
            call_id: this.id,
            msg_id: msgId,
            results: results.map(r => ({
                tool_call_id: r.toolCallId,
                result: r.result,
            })),
        });
    }

    // ── Control ──────────────────────────────────────────────────────────

    /** Cancel a specific message or the current one. */
    cancel(messageId?: string): void {
        this.#send({
            event: "bot.cancel",
            call_id: this.id,
            ...(messageId ? { message_id: messageId } : {}),
        });
    }

    /** Clear all queued audio. */
    clear(): void {
        this.#send({ event: "bot.clear", call_id: this.id });
    }

    /** Hang up the call. */
    hangup(): void {
        this.#send({ event: "call.hangup", call_id: this.id });
    }

    /** Forward the call to another number. */
    forward(to: string, options?: ForwardOptions): void {
        this.#send({
            event: "call.forward",
            call_id: this.id,
            to,
            message: options?.message ?? "",
            announce: options?.announce ?? false,
        });
    }

    /** Send DTMF tones. */
    sendDTMF(digits: string): void {
        this.#send({ event: "call.dtmf", call_id: this.id, digits });
    }

    /** Update config for this call (mid-call). */
    configure(opts: Record<string, unknown>): void {
        this.#send({
            event: "session.configure",
            session_id: this.id,
            ...opts,
        });
    }

    /** @deprecated Use `call.configure()` instead. */
    updateConfig(config: Partial<SessionConfig>): void {
        this.configure({ config });
    }

    // ── Hold / Mute ────────────────────────────────────────────────────

    hold(): void { this.#send({ event: "call.hold", call_id: this.id }); }
    unhold(): void { this.#send({ event: "call.unhold", call_id: this.id }); }
    mute(): void { this.#send({ event: "call.mute", call_id: this.id }); }
    unmute(): void { this.#send({ event: "call.unmute", call_id: this.id }); }

    // ── History management (server-side LLM) ─────────────────────────────

    /** @internal Send a request and wait for a specific response event. */
    #request(sendEvent: string, responseEvent: string, data: Record<string, unknown> = {}): Promise<any> {
        return new Promise((resolve) => {
            this.#pendingResponses.set(responseEvent, resolve);
            this.#send({ event: sendEvent, call_id: this.id, ...data });
        });
    }

    async getHistory(): Promise<Array<{ role: string; content: string }>> {
        const res = await this.#request("history.get", "history.data");
        return res.messages ?? [];
    }

    async addHistory(messages: Array<{ role: string; content: string }>): Promise<number> {
        const res = await this.#request("history.add", "history.updated", { messages });
        return res.count ?? 0;
    }

    async setHistory(messages: Array<{ role: string; content: string }>): Promise<number> {
        const res = await this.#request("history.set", "history.updated", { messages });
        return res.count ?? 0;
    }

    async clearHistory(): Promise<number> {
        const res = await this.#request("history.clear", "history.updated");
        return res.count ?? 0;
    }

    async setPrompt(prompt: string): Promise<number> {
        this._promptTemplate = prompt;
        return this.#sendPrompt(prompt);
    }

    async setPromptFile(filePath: string): Promise<number> {
        // Lazy import — browser-safe, fixes the require("path")/require("fs") bundler issue
        const { readFileSync } = await import("node:fs");
        const { resolve } = await import("node:path");
        const resolved = resolve(this._promptsDir, filePath);
        this._promptTemplate = readFileSync(resolved, "utf-8").trim();
        return this.#sendPrompt(this._promptTemplate);
    }

    async setPromptVars(vars: Record<string, string>): Promise<number> {
        const res = await this.#request("history.set_vars", "history.updated", { vars });
        return res.count ?? 0;
    }

    async addContext(text: string): Promise<number> {
        const res = await this.#request("history.add_context", "history.updated", { text });
        return res.count ?? 0;
    }

    async #sendPrompt(text: string): Promise<number> {
        const res = await this.#request("history.set_instructions", "history.updated", { prompt: text });
        return res.count ?? 0;
    }

    // ── Dispatch-only API (friend methods) ───────────────────────────────
    // Called by dispatch handlers. Prefixed with _ and marked @internal.
    // Not part of the public contract.

    /** @internal Resolve a pending history request/response promise. */
    _applyHistoryResponse(eventType: string, data: Record<string, unknown>): boolean {
        const resolver = this.#pendingResponses.get(eventType);
        if (resolver) {
            this.#pendingResponses.delete(eventType);
            resolver(data);
            return true;
        }
        return false;
    }

    /** @internal Apply user.message — tracks lastMessageId and turn state. */
    _applyUserMessage(event: UserMessageEvent): void {
        this.lastMessageId = event.messageId;
        // Read raw wire fields for turn tracking (event is already camelized)
        this.#lastTurnId = event.turnId;
        this.#lastTurnText = event.text;
        this.#lastTurnConfidence = event.confidence;
        this.#lastTurnLanguage = event.language;
        this.emit("user.message", event);
    }

    /** @internal Apply eager.turn — pre-tracks turn state. */
    _applyEagerTurn(turn: Turn): void {
        this.lastMessageId = turn.messageId;
        this.#lastTurnId = turn.id;
        this.#lastTurnText = turn.text;
        this.#lastTurnConfidence = 0;
        this.#lastTurnLanguage = undefined;
        this.emit("eager.turn", turn);
    }

    /** @internal Apply turn.end — emits Turn with merged state. */
    _applyTurnEnd(wireEvent: Record<string, unknown>): void {
        const turn: Turn = {
            id: wireEvent.turn_id as number,
            messageId: (wireEvent.message_id as string) || this.lastMessageId || "",
            text: (wireEvent.text as string) || this.#lastTurnText,
            confidence: this.#lastTurnConfidence,
            language: this.#lastTurnLanguage,
            probability: wireEvent.probability as number,
            latencyMs: wireEvent.latency_ms as number,
        };
        if (wireEvent.text) this.#lastTurnText = wireEvent.text as string;
        if (wireEvent.message_id) this.lastMessageId = wireEvent.message_id as string;
        this.emit("turn.end", turn);
    }

    /** @internal Apply turn.continued — aborts all active streams. */
    _applyTurnContinued(event: TurnContinuedEvent): void {
        for (const stream of this.#activeStreams) {
            stream.abort();
        }
        this.#activeStreams.clear();
        this.emit("turn.continued", event);
    }

    /** @internal Emit a typed event. Used by dispatch handlers. */
    _emitWire<K extends keyof CallEvents>(event: K, ...args: Parameters<CallEvents[K]>): void {
        this.emit(event, ...args);
    }

    /** @internal Mark call as ended. Populates messages from server data. */
    _applyEnd(reason: string, data?: Record<string, unknown>): void {
        this.reason = reason;
        this.status = "ended";

        if (data) {
            // Prefer server's definitive messages if available
            if (Array.isArray(data.messages) && (data.messages as any[]).length > 0) {
                this.messages = data.messages as any;
            }
            if (typeof data.duration_seconds === "number") this.duration = data.duration_seconds as number;
            if (typeof data.started_at === "number") this.startedAt = data.started_at as number;
            if (typeof data.ended_at === "number") this.endedAt = data.ended_at as number;
        }

        // Cancel any pending debounced save and force a final save
        if (this.#historySaveTimer) clearTimeout(this.#historySaveTimer);
        this._saveHistoryNow();

        // Abort all streams
        for (const stream of this.#activeStreams) {
            stream.abort();
        }
        this.#activeStreams.clear();
        this.emit("ended", reason);
        // Defer listener cleanup so "ended" handlers can still interact
        queueMicrotask(() => this.removeAllListeners());
    }

    // ─── Incremental history ─────────────────────────────────────────────

    /**
     * @internal Initialize history tracking. Called by lifecycle handler on call.started.
     */
    _initHistory(agentId: string, historyStore: HistoryStore): void {
        this.#historyStore = historyStore;
        this.#historyAgentId = agentId;
        this.startedAt = Date.now() / 1000;
        // Initial save — creates the record with status: "active"
        this._saveHistoryNow();
    }

    /**
     * @internal Append a message and trigger a debounced history save.
     * Called by speech/bot/tool handlers on confirmed events.
     */
    _pushMessage(msg: Record<string, unknown>): void {
        this.messages.push(msg);
        this._saveHistoryDebounced();
    }

    /**
     * @internal Schedule a debounced history save (coalesces rapid events).
     */
    _saveHistoryDebounced(): void {
        if (!this.#historyStore) return;
        if (this.#historySaveTimer) clearTimeout(this.#historySaveTimer);
        this.#historySaveTimer = setTimeout(() => {
            this._saveHistoryNow();
        }, Call.HISTORY_DEBOUNCE_MS);
    }

    /**
     * @internal Immediate history save. Builds a ConversationRecord from current state.
     */
    _saveHistoryNow(): void {
        if (!this.#historyStore) return;

        const contactId = (
            this.metadata?.userId
                ? String(this.metadata.userId)
                : this.from
        );

        const record: ConversationRecord = {
            callId: this.id,
            agentId: this.#historyAgentId,
            channel: this.transport as ConversationRecord["channel"],
            direction: this.direction,
            from: contactId,
            to: this.to,
            startedAt: this.startedAt,
            endedAt: this.endedAt,
            duration: this.duration,
            reason: this.reason,
            status: this.status,
            transcript: this.transcript,
            messages: this.messages,
            metadata: this.metadata,
        };

        // Fire-and-forget — never block event dispatch
        this.#historyStore.save(record).catch(() => {
            // Silently ignore save errors during call
        });
    }


    // ─── SSE streaming ──────────────────────────────────────────────────

    /**
     * Stream this call's events as Server-Sent Events to an HTTP response.
     *
     * Handles SSE headers, word-by-word buffering, event scoping,
     * keepalive pings, and automatic cleanup. Designed for "Call Me"
     * endpoints where the browser needs a live transcript.
     *
     * @param res  Node.js HTTP response (Express, Connect, raw http.ServerResponse)
     * @param opts Optional config
     *
     * @example
     * ```ts
     * app.post("/api/call-me", async (req, res) => {
     *   const call = await agent.dial({ to: req.body.phone, from: "+1...", greeting: "Hi!" });
     *   call.streamSSE(res);
     * });
     * ```
     */
    streamSSE(res: SSEResponse, opts?: StreamSSEOptions): void {
        const greeting = opts?.greeting ?? this.greeting;

        // ── SSE headers ──
        if (typeof res.writeHead === "function") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            });
        }
        if (typeof (res as any).flushHeaders === "function") {
            (res as any).flushHeaders();
        }

        const send = (event: string, data: Record<string, unknown>) => {
            try {
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                if (typeof (res as any).flush === "function") (res as any).flush();
            } catch { /* client gone */ }
        };

        // ── Keepalive ping ──
        const ping = setInterval(() => {
            try {
                res.write(":ping\n\n");
                if (typeof (res as any).flush === "function") (res as any).flush();
            } catch { clearInterval(ping); }
        }, 25_000);

        // ── Initial events ──
        send("call.started", { callId: this.id });

        if (greeting) {
            send("bot.confirmed", { text: greeting, messageId: "greeting" });
        }

        // ── Word buffering ──
        const wordBuffers = new Map<string, string>();

        // ── Event listeners ──
        this.on("bot.word", (event) => {
            const prev = wordBuffers.get(event.messageId) || "";
            const sep = prev && !prev.endsWith(" ") ? " " : "";
            const text = prev + sep + event.word;
            wordBuffers.set(event.messageId, text);
            send("bot.word", { text, messageId: event.messageId });
        });

        this.on("message.confirmed", (event) => {
            wordBuffers.delete(event.messageId);
            if (event.text) {
                send("bot.confirmed", { text: event.text, messageId: event.messageId });
            }
        });

        this.on("user.speaking", (event) => {
            send("user.speaking", { text: event.text, messageId: event.messageId });
        });

        this.on("user.message", (event) => {
            send("user.message", { text: event.text, messageId: event.messageId });
        });

        this.on("llm.tool_call", (event) => {
            const tools = event.toolCalls ?? [];
            for (const tc of tools) {
                send("tool.call", { name: tc.name, args: tc.arguments });
            }
        });

        this.on("ended", (reason) => {
            send("call.ended", { reason, duration: Math.round(this.duration || 0) });
            clearInterval(ping);
            res.end();
        });

        // ── Client disconnect ──
        res.on("close", () => {
            clearInterval(ping);
            // Call listeners auto-cleanup on _applyEnd
        });
    }
}

// ── SSE types (minimal duck-typing for Express/Connect/raw http) ─────

/** Minimal writable response for streamSSE. */
export interface SSEResponse {
    writeHead?: (status: number, headers: Record<string, string>) => void;
    write: (chunk: string) => boolean;
    end: () => void;
    on: (event: string, handler: () => void) => void;
}

export interface StreamSSEOptions {
    /** Greeting text to send as the first bot message (for outbound calls). */
    greeting?: string;
}

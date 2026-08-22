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
import { Requester, REQUEST_TIMEOUT_MS } from "../kernel/requester.js";
import { CallRequests } from "./call-requests.js";
import { ReplyStream } from "./reply-stream.js";
import type { Turn } from "./turn.js";
import type { CallEvents } from "./call-events.js";
import type { ReplyOptions, ForwardOptions } from "./call-events.js";
import type {
    UserMessageEvent,
    TurnContinuedEvent,
    BotSpeakingEvent,
    BotWordEvent,
    BotFinishedEvent,
    BotInterruptedEvent,
    LineTranscriptEntry,
} from "../protocol/events.js";
import { CallHistoryRecorder } from "./call-history.js";
import { streamCallSSE } from "../sse/call-stream.js";
import type { SSEResponse, StreamSSEOptions } from "../sse/call-stream.js";
import type { SessionConfig } from "../config/session.js";
import type { HistoryStore } from "../history.js";

// These types used to live in this file; index.ts (and every app) imports them
// from here, so they keep travelling through it.
export type { SSEResponse, StreamSSEOptions };
export type { CallEvents, PreparingTimeoutEvent, SkillEvent, ReplyOptions, ForwardOptions } from "./call-events.js";
export type { LineTranscriptEntry } from "../protocol/events.js";

/**
 * What a `call.started` carries into a `Call`.
 *
 * Named because `Agent._createCall()` hands it on: a `PhoneLine` builds a
 * `LineCall` from exactly this, so the shape had to stop being an inline
 * literal on one constructor.
 */
export interface CallInit {
    call_id: string;
    from: string;
    to: string;
    direction: "inbound" | "outbound";
    transport?: "webrtc" | "phone" | "chat" | "whatsapp" | "unknown";
    metadata?: Record<string, unknown>;
    language?: string;
    /** The extension dialled after the number, when a line resolved one. */
    extension?: string | null;
    /** Who is driving this session — a line, or an agent. */
    owner?: "line" | "agent";
    /** The line that handed this call over, `line:<number>`. */
    routed_from?: string;
    /** What the line heard and said before the hand-over. */
    line_transcript?: Array<{ who: "caller" | "line"; text: string; at?: number }>;
}

/** What an awaited `say()` reports: whether the caller talked over it. */
export interface SayResult {
    interrupted: boolean;
}

// ─── Call class ──────────────────────────────────────────────────────────

/**
 * How long a history/prompt request waits for its server ack before rejecting.
 * Lives in the kernel now (the requester owns the timer); re-exported here
 * because that is where it has always been imported from.
 */
export { REQUEST_TIMEOUT_MS };

export class Call extends TypedEventBus<CallEvents> {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly direction: "inbound" | "outbound";
    readonly transport: "webrtc" | "phone" | "chat" | "whatsapp" | "unknown";
    readonly metadata: Record<string, unknown>;
    /**
     * The SESSION's language, as the server resolved it: the browser's pick on
     * webrtc (`config.language` in the offer, e.g. a language toggle in the
     * page), the dialled number's channel config on phone, the agent's default
     * otherwise. BCP-47 base ("en", "es"). Empty when the server predates it.
     * Read this — not `metadata` — to localise a session's prompt: it is the
     * same fact the server used to pick STT/TTS language and the greeting.
     *
     * It FOLLOWS a mid-call switch: when a browser changes the session's
     * language (`VoiceSession.configure({ language })`), the server moves STT
     * and TTS and tells the SDK, which updates this before the next
     * `call.preparing`. So a prompt localised in that hook stays in step with
     * what the caller is hearing — read it per turn, do not cache it.
     */
    get language(): string {
        return this.#language;
    }
    #language: string;

    /** @internal The server reported a new session language (mid-call switch). */
    _setLanguage(lang: string): void {
        this.#language = lang;
    }

    /**
     * The extension the caller dialled after the number ("33"), or null.
     *
     * Set by a phone line (`pc.line()`), and carried through `routeTo` so the
     * agent knows which door the call came through. Always null on a call that
     * no line answered.
     */
    readonly extension: string | null;

    /**
     * The line that handed this call over — `line:<number>` — or null when the
     * call came straight to the agent.
     */
    readonly routedFrom: string | null;

    /**
     * What the line heard and said before it routed the call here. Empty on a
     * call no line answered.
     */
    readonly lineTranscript: readonly LineTranscriptEntry[];

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

    /**
     * Live preview of what the bot is currently saying.
     * Accumulated word-by-word from `bot.word` events.
     * Resets when a new bot message starts, clears when finished/interrupted.
     */
    get currentBotText(): string {
        return this.#botWords.join(" ");
    }

    /** @internal Word accumulator for current bot message. */
    #botWords: string[] = [];
    /** @internal Message ID being tracked for word accumulation. */
    #botWordMessageId: string | null = null;

    /** @internal The message id the word buffer belongs to — read by the SSE stream. */
    get _currentBotMessageId(): string | null {
        return this.#botWordMessageId;
    }

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

    /** @internal Server-side history/prompt round-trips — see call-requests.ts. */
    #requests: CallRequests;

    /** Skills currently active on this call (tracked from server skill events). */
    #activeSkills = new Set<string>();

    /** @internal Incremental history persistence — see domain/call-history.ts. */
    #history: CallHistoryRecorder | undefined;

    /**
     * Debounce interval for incremental history saves (ms).
     * The recorder owns it now; kept here because that is where it has always
     * been read from (and set from, in tests).
     */
    static get HISTORY_DEBOUNCE_MS(): number {
        return CallHistoryRecorder.HISTORY_DEBOUNCE_MS;
    }
    static set HISTORY_DEBOUNCE_MS(ms: number) {
        CallHistoryRecorder.HISTORY_DEBOUNCE_MS = ms;
    }

    constructor(
        data: CallInit,
        send: (data: Record<string, unknown>) => void,
    ) {
        super();
        this.id = data.call_id;
        this.from = data.from;
        this.to = data.to;
        this.direction = data.direction;
        this.transport = data.transport ?? "unknown";
        this.metadata = data.metadata ?? {};
        this.#language = data.language ?? "";
        this.extension = data.extension ?? null;
        this.routedFrom = data.routed_from ?? null;
        this.lineTranscript = (data.line_transcript ?? []).map((e) => ({
            who: e.who,
            text: e.text,
            at: e.at ?? Date.now(),
            role: e.who === "caller" ? "user" as const : "assistant" as const,
            content: e.text,
        }));
        this.#send = send;
        this.#requests = new CallRequests(this.id, send);
    }

    // ── High-level reply methods ─────────────────────────────────────────

    /**
     * Send a greeting or standalone message (no in_reply_to required).
     *
     * Pass `{ addToHistory: true }` to inject this text into the server-side
     * LLM conversation history as an assistant message, so the model knows
     * what was said and won't repeat it.
     */
    say(text: string, opts?: { addToHistory?: boolean }): Promise<SayResult> {
        const messageId = generateId("msg");
        this.#send({
            event: "bot.reply",
            call_id: this.id,
            message_id: messageId,
            text,
            in_reply_to: "",
            ...(opts?.addToHistory ? { add_to_history: true } : {}),
        });
        return this._awaitPlayback(messageId);
    }

    /**
     * @internal Resolve when the audio for `messageId` stopped coming out of
     * the speaker — finished, interrupted, or the call ended under it.
     *
     * NEVER rejects. `say()` has always been fire-and-forget and stays that
     * way: an un-awaited call cannot produce an unhandled rejection, because
     * there is nothing to reject.
     */
    protected _awaitPlayback(messageId: string): Promise<SayResult> {
        if (this.status === "ended") return Promise.resolve({ interrupted: true });
        return new Promise<SayResult>((resolve) => {
            const settle = (interrupted: boolean) => {
                this.off("bot.finished", onFinished);
                this.off("bot.interrupted", onInterrupted);
                this.off("ended", onEnded);
                resolve({ interrupted });
            };
            // A server that omits message_id is answering about the only reply
            // in flight — ours.
            const onFinished = (e: BotFinishedEvent) => {
                if (!e?.messageId || e.messageId === messageId) settle(false);
            };
            const onInterrupted = (e: BotInterruptedEvent) => {
                if (!e?.messageId || e.messageId === messageId) settle(true);
            };
            const onEnded = () => settle(true);
            this.on("bot.finished", onFinished);
            this.on("bot.interrupted", onInterrupted);
            this.on("ended", onEnded);
        });
    }

    /**
     * @internal One raw frame out on this call's socket.
     *
     * The private `#send` cannot cross a subclass boundary, and `LineCall`
     * has verbs of its own to send (`call.route`, `set_context`).
     */
    protected _sendRaw(data: Record<string, unknown>): void {
        this.#send(data);
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
        results: Array<{ toolCallId: string; result: unknown; ephemeral?: boolean; noFollowup?: boolean }>,
    ): void {
        this.#send({
            event: "llm.tool_result",
            call_id: this.id,
            msg_id: msgId,
            results: results.map(r => ({
                tool_call_id: r.toolCallId,
                result: r.result,
                // Ephemeral results are dropped from history by the server after
                // they're used for the current reply. Omitted when false.
                ...(r.ephemeral ? { ephemeral: true } : {}),
                // noFollowup: the server skips the follow-up assistant turn after
                // this tool (UI-only tools). Omitted when false.
                ...(r.noFollowup ? { no_followup: true } : {}),
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
    update(opts: Record<string, unknown>): void {
        this.#send({
            event: "session.configure",
            session_id: this.id,
            ...opts,
        });
    }

    /** @deprecated Use `call.update()` instead. */
    configure(opts: Record<string, unknown>): void {
        this.update(opts);
    }

    /** @deprecated Use `call.update()` instead. */
    updateConfig(config: Partial<SessionConfig>): void {
        this.update({ config });
    }

    // ── Skills ──────────────────────────────────────────────────────────────

    /** Skills currently active on this call (server-authoritative). */
    get activeSkills(): string[] {
        return [...this.#activeSkills];
    }

    /**
     * Activate a declared skill on this call now — exposing its tools and
     * instructions to the LLM and adding its knowledge base to RAG. Programmatic
     * counterpart to the model-driven `loadSkill` meta-tool. Takes effect on the
     * next LLM turn. Emits `skill.loaded` once the server confirms.
     */
    loadSkill(name: string): void {
        this.#send({ event: "skill.load", call_id: this.id, skill: name });
    }

    /** Deactivate a skill on this call (inverse of `loadSkill`). */
    unloadSkill(name: string): void {
        this.#send({ event: "skill.unload", call_id: this.id, skill: name });
    }

    /** @internal Update tracked active-skill state from a server skill event. */
    _setSkillActive(name: string, active: boolean): void {
        if (active) this.#activeSkills.add(name);
        else this.#activeSkills.delete(name);
    }

    // ── Hold / Mute ────────────────────────────────────────────────────

    hold(): void { this.#send({ event: "call.hold", call_id: this.id }); }
    unhold(): void { this.#send({ event: "call.unhold", call_id: this.id }); }
    mute(): void { this.#send({ event: "call.mute", call_id: this.id }); }
    unmute(): void { this.#send({ event: "call.unmute", call_id: this.id }); }

    // ── History management (server-side LLM) ─────────────────────────────
    // One frame out, one ack back — the machinery lives in call-requests.ts.

    getHistory(): Promise<Array<{ role: string; content: string }>> { return this.#requests.getHistory(); }
    addHistory(messages: Array<{ role: string; content: string }>): Promise<number> { return this.#requests.addHistory(messages); }
    setHistory(messages: Array<{ role: string; content: string }>): Promise<number> { return this.#requests.setHistory(messages); }
    clearHistory(): Promise<number> { return this.#requests.clearHistory(); }
    addContext(text: string): Promise<number> { return this.#requests.addContext(text); }

    setPrompt(prompt: string): Promise<number> {
        this._promptTemplate = prompt;
        return this.#requests.setInstructions(prompt);
    }

    setPromptFile(filePath: string): Promise<number> {
        return Requester.handled((async () => {
            // Lazy import — browser-safe, fixes the require("path")/require("fs") bundler issue
            const { readFileSync } = await import("node:fs");
            const { resolve } = await import("node:path");
            const resolved = resolve(this._promptsDir, filePath);
            this._promptTemplate = readFileSync(resolved, "utf-8").trim();
            return this.#requests.setInstructions(this._promptTemplate);
        })());
    }

    /**
     * Push `{{var}}` values for the CURRENT turn. Highest precedence: they beat
     * the agent-level `promptVars` and stay until you overwrite them.
     *
     * Inside a `call.preparing` handler this is the per-turn contract — return
     * the promise (or `await` it) and the server holds the generation until it
     * lands. Resolves with the message count, or rejects if the server never
     * acknowledges it.
     */
    setPromptVars(vars: Record<string, string>): Promise<number> { return this.#requests.setVars(vars); }

    // ── Dispatch-only API (friend methods) ───────────────────────────────
    // Called by dispatch handlers. Prefixed with _ and marked @internal.
    // Not part of the public contract.

    /** @internal Reset word buffer and start tracking a new bot message. */
    _applyBotSpeaking(event: BotSpeakingEvent): void {
        this.#botWords = [];
        this.#botWordMessageId = event.messageId;
        this.emit("bot.speaking", event);
    }

    /** @internal Append a word to the live preview buffer. */
    _applyBotWord(event: BotWordEvent): void {
        if (event.messageId === this.#botWordMessageId) {
            this.#botWords.push(event.word);
        }
        this.emit("bot.word", event);
    }

    /** @internal Clear the word buffer (bot finished or interrupted). */
    _clearBotWords(): void {
        this.#botWords = [];
        this.#botWordMessageId = null;
    }

    /** @internal Resolve a pending history request/response promise. */
    _applyHistoryResponse(eventType: string, data: Record<string, unknown>): boolean {
        return this.#requests.applyResponse(eventType, data);
    }

    /**
     * @internal Run the `call.preparing` handlers and hand back whatever they
     * returned, so the caller can await async ones before releasing the turn.
     */
    _emitPreparing(): unknown[] {
        return this.emitCollect("call.preparing", this);
    }

    /** @internal True when the app is listening for the pre-turn hook. */
    _hasPreparingListener(): boolean {
        return this.listenerCount("call.preparing") > 0;
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
        this.#history?.flush();

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
        this.#history = new CallHistoryRecorder(this, agentId, historyStore);
        this.startedAt = Date.now() / 1000;
        // Initial save — creates the record with status: "active"
        this.#history.saveNow();
    }

    /**
     * @internal Append a message and trigger a debounced history save.
     * Called by speech/bot/tool handlers on confirmed events.
     */
    _pushMessage(msg: Record<string, unknown>): void {
        this.messages.push(msg);
        this.#history?.saveDebounced();
    }

    // ─── SSE streaming ──────────────────────────────────────────────────

    /**
     * Stream this call's events as Server-Sent Events to an HTTP response —
     * headers, word buffering, keepalive pings and cleanup. See sse/call-stream.ts.
     */
    streamSSE(res: SSEResponse, opts?: StreamSSEOptions): void {
        streamCallSSE(this, res, opts);
    }
}

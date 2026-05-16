/**
 * ReplyStream — writable stream for bot.reply.stream protocol.
 *
 * Auto-aborts on turn.continued. Pairs naturally with LLM streaming:
 *
 *   const stream = call.replyStream(turn);
 *   for await (const token of llm.stream(prompt)) {
 *     if (stream.aborted) break;
 *     stream.write(token);
 *   }
 *   stream.end();
 */

import { generateId } from "./utils/id.js";

export interface ReplyStreamOptions {
    callId: string;
    messageId?: string;
    inReplyTo: string;
    send: (data: Record<string, unknown>) => void;
    /** Called when the stream ends or is aborted — for cleanup. */
    onComplete?: () => void;
}

export class ReplyStream {
    readonly messageId: string;
    readonly callId: string;

    private _aborted = false;
    private _ended = false;
    private _started = false;
    private _send: (data: Record<string, unknown>) => void;
    private _inReplyTo: string;

    // AbortController for external cancellation
    private _ac = new AbortController();

    private _onComplete?: () => void;

    constructor(opts: ReplyStreamOptions) {
        this.messageId = opts.messageId ?? generateId("msg");
        this.callId = opts.callId;
        this._inReplyTo = opts.inReplyTo;
        this._send = opts.send;
        this._onComplete = opts.onComplete;
    }

    /** True if the stream was aborted (e.g. turn.continued). */
    get aborted(): boolean {
        return this._aborted;
    }

    /** True if end() was called. */
    get ended(): boolean {
        return this._ended;
    }

    /** AbortSignal that fires on abort — use with fetch, LLM clients, etc. */
    get signal(): AbortSignal {
        return this._ac.signal;
    }

    /**
     * Write a token/chunk to the stream.
     * Automatically sends `start` on the first write.
     */
    write(token: string): void {
        if (this._aborted || this._ended) return;

        if (!this._started) {
            this._started = true;
            this._send({
                event: "bot.reply.stream",
                call_id: this.callId,
                message_id: this.messageId,
                action: "start",
                in_reply_to: this._inReplyTo,
            });
        }

        this._send({
            event: "bot.reply.stream",
            call_id: this.callId,
            message_id: this.messageId,
            action: "chunk",
            token,
        });
    }

    /** End the stream normally — flushes remaining buffer on server. */
    end(): void {
        if (this._aborted || this._ended) return;
        this._ended = true;
        this._fireComplete();

        // If we never wrote anything, send start+end so server knows
        if (!this._started) {
            this._started = true;
            this._send({
                event: "bot.reply.stream",
                call_id: this.callId,
                message_id: this.messageId,
                action: "start",
                in_reply_to: this._inReplyTo,
            });
        }

        this._send({
            event: "bot.reply.stream",
            call_id: this.callId,
            message_id: this.messageId,
            action: "end",
        });
    }

    /** Abort the stream immediately (e.g. on turn.continued). */
    abort(): void {
        if (this._aborted) return;
        this._aborted = true;
        this._ended = true;

        // Tell the server this stream is done so it cleans up
        // (_is_streaming, TTS flush, etc.)
        if (this._started) {
            this._send({
                event: "bot.reply.stream",
                call_id: this.callId,
                message_id: this.messageId,
                action: "end",
            });
        }

        this._fireComplete();
        this._ac.abort();
    }

    private _fireComplete(): void {
        if (this._onComplete) {
            const cb = this._onComplete;
            this._onComplete = undefined;
            cb();
        }
    }
}

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

import { generateId } from "../kernel/id.js";

/** Outbox interface — decouples ReplyStream from raw WebSocket send. */
export interface Outbox {
    send(data: Record<string, unknown>): void;
}

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

    #aborted = false;
    #ended = false;
    #started = false;
    #send: (data: Record<string, unknown>) => void;
    #inReplyTo: string;

    // AbortController for external cancellation
    #ac = new AbortController();

    #onComplete?: () => void;

    constructor(opts: ReplyStreamOptions) {
        this.messageId = opts.messageId ?? generateId("msg");
        this.callId = opts.callId;
        this.#inReplyTo = opts.inReplyTo;
        this.#send = opts.send;
        this.#onComplete = opts.onComplete;
    }

    /** True if the stream was aborted (e.g. turn.continued). */
    get aborted(): boolean {
        return this.#aborted;
    }

    /** True if end() was called. */
    get ended(): boolean {
        return this.#ended;
    }

    /** AbortSignal that fires on abort — use with fetch, LLM clients, etc. */
    get signal(): AbortSignal {
        return this.#ac.signal;
    }

    /**
     * Write a token/chunk to the stream.
     * Automatically sends `start` on the first write.
     */
    write(token: string): void {
        if (this.#aborted || this.#ended) return;

        if (!this.#started) {
            this.#started = true;
            this.#send({
                event: "bot.reply.stream",
                call_id: this.callId,
                message_id: this.messageId,
                action: "start",
                in_reply_to: this.#inReplyTo,
            });
        }

        this.#send({
            event: "bot.reply.stream",
            call_id: this.callId,
            message_id: this.messageId,
            action: "chunk",
            token,
        });
    }

    /** End the stream normally — flushes remaining buffer on server. */
    end(): void {
        if (this.#aborted || this.#ended) return;
        this.#ended = true;
        this.#fireComplete();

        // If we never wrote anything, send start+end so server knows
        if (!this.#started) {
            this.#started = true;
            this.#send({
                event: "bot.reply.stream",
                call_id: this.callId,
                message_id: this.messageId,
                action: "start",
                in_reply_to: this.#inReplyTo,
            });
        }

        this.#send({
            event: "bot.reply.stream",
            call_id: this.callId,
            message_id: this.messageId,
            action: "end",
        });
    }

    /** Abort the stream immediately (e.g. on turn.continued). */
    abort(): void {
        if (this.#aborted) return;
        this.#aborted = true;
        this.#ended = true;

        // Tell the server this stream is done so it cleans up
        // (_is_streaming, TTS flush, etc.)
        if (this.#started) {
            this.#send({
                event: "bot.reply.stream",
                call_id: this.callId,
                message_id: this.messageId,
                action: "end",
            });
        }

        this.#fireComplete();
        this.#ac.abort();
    }

    #fireComplete(): void {
        if (this.#onComplete) {
            const cb = this.#onComplete;
            this.#onComplete = undefined;
            cb();
        }
    }
}

/**
 * Call SSE streaming — a live transcript of ONE call, pushed to an HTTP response.
 *
 * This lives outside `domain/call.ts` on purpose: a Call is a handle on a
 * session, not an HTTP concern. `Call.streamSSE()` stays as a one-line delegate
 * so the public API is unchanged.
 */

import type { Call } from "../domain/call.js";

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

// ─── SSE streaming ──────────────────────────────────────────────────

/**
 * Stream a call's events as Server-Sent Events to an HTTP response.
 *
 * Handles SSE headers, word-by-word buffering, event scoping,
 * keepalive pings, and automatic cleanup. Designed for "Call Me"
 * endpoints where the browser needs a live transcript.
 *
 * @param call The call to stream
 * @param res  Node.js HTTP response (Express, Connect, raw http.ServerResponse)
 * @param opts Optional config
 */
export function streamCallSSE(call: Call, res: SSEResponse, opts?: StreamSSEOptions): void {
    const greeting = opts?.greeting ?? call.greeting;

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
    send("call.started", { callId: call.id });

    if (greeting) {
        send("bot.confirmed", { text: greeting, messageId: "greeting" });
    }

    // ── Event listeners ──
    call.on("bot.word", () => {
        send("bot.word", { text: call.currentBotText, messageId: call._currentBotMessageId ?? "" });
    });

    call.on("message.confirmed", (event) => {
        if (event.text) {
            send("bot.confirmed", { text: event.text, messageId: event.messageId });
        }
    });

    call.on("user.speaking", (event) => {
        send("user.speaking", { text: event.text, messageId: event.messageId });
    });

    call.on("user.message", (event) => {
        send("user.message", { text: event.text, messageId: event.messageId });
    });

    call.on("llm.toolCall", (event) => {
        const tools = event.toolCalls ?? [];
        for (const tc of tools) {
            send("tool.call", { name: tc.name, args: tc.arguments });
        }
    });

    call.on("ended", (reason) => {
        send("call.ended", { reason, duration: Math.round(call.duration || 0) });
        clearInterval(ping);
        res.end();
    });

    // ── Client disconnect ──
    res.on("close", () => {
        clearInterval(ping);
        // Call listeners auto-cleanup on _applyEnd
    });
}

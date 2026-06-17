/**
 * WebSocket stream — pipes agent events to a WebSocket connection.
 *
 * This is the WebSocket equivalent of createAgentStream (SSE).
 * Instead of writing SSE text to an HTTP response, it sends JSON
 * messages over a WebSocket connection.
 *
 * Usage:
 *   import { WebSocketServer } from "ws";
 *   const wss = new WebSocketServer({ server, path: "/ws/events" });
 *   wss.on("connection", (ws) => pines.ws(ws));
 *
 * Each message is: { event: "bot.word", word: "hello", agent: "pines" }
 */

import type { Agent } from "../domain/agent.js";
import type { Call } from "../domain/call.js";
import { STREAM_EVENTS } from "../sse/format.js";

/** Minimal WebSocket interface — works with `ws`, native, or any compatible lib. */
export interface WSLike {
    send(data: string): void;
    close(): void;
    readyState: number;
    on(event: "close", handler: () => void): void;
    on(event: "message", handler: (data: unknown) => void): void;
    on(event: string, handler: (...args: unknown[]) => void): void;
}

/** Events forwarded over WebSocket (SSE events + tool results). */
const WS_EVENTS = [
    ...STREAM_EVENTS,
    "llm.toolCall",
] as const;

export interface WSStreamOptions {
    /** Include llm.tool_result events. Default: false */
    toolResults?: boolean;
    /** Filter to events from a specific sessionId / callId. */
    sessionId?: string;
}

/**
 * Pipe agent events to a WebSocket connection.
 *
 * @param agent  The agent whose events to stream
 * @param ws     A WebSocket-like object (ws, native WebSocket, etc.)
 * @param opts   Optional filtering (session scoping, tool results)
 */
export function createAgentWS(agent: Agent, ws: WSLike, opts?: WSStreamOptions): void {
    const handlers: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];

    const cleanup = () => {
        for (const { event, handler } of handlers) {
            agent.off(event, handler);
        }
        handlers.length = 0;
        if (ping) clearInterval(ping);
    };

    const safeSend = (data: Record<string, unknown>) => {
        try {
            if (ws.readyState === 1 /* OPEN */) {
                ws.send(JSON.stringify(data));
            }
        } catch {
            cleanup();
        }
    };

    // Send connected message
    safeSend({ event: "connected", agent: agent.id });

    // Subscribe to agent events
    const events = opts?.toolResults
        ? [...WS_EVENTS, "llm.tool_result" as const]
        : WS_EVENTS;

    for (const evt of events) {
        const handler = (...args: unknown[]) => {
            const data = buildEventData(evt, args);

            // Session filtering
            if (opts?.sessionId && data.callId && data.callId !== opts.sessionId) {
                return;
            }

            safeSend({ event: evt, ...data, agent: agent.id });
        };
        handlers.push({ event: evt, handler });
        agent.on(evt, handler);
    }

    // Ping keepalive
    const ping = setInterval(() => {
        safeSend({ event: "ping" });
    }, 25_000);

    // Handle incoming messages (bidirectional)
    ws.on("message", (raw) => {
        try {
            const msg = JSON.parse(typeof raw === "string" ? raw : String(raw));
            if (msg.action === "ping") {
                safeSend({ event: "pong" });
            }
            // Future: inject_text, set_context, etc.
        } catch { /* ignore */ }
    });

    // Cleanup on close
    ws.on("close", cleanup);
}

// ── Helpers ──

function buildEventData(event: string, args: unknown[]): Record<string, unknown> {
    const data: Record<string, unknown> = {};

    for (const arg of args) {
        if (!arg || typeof arg !== "object") continue;

        // Call object — extract key fields
        if ("id" in arg && "from" in arg && "to" in arg && "transport" in arg) {
            const call = arg as Call;
            data.callId = call.id;
            data.from = call.from;
            data.to = call.to;
            data.direction = call.direction;
            data.transport = call.transport;
            if (call.duration) data.duration = call.duration;
            if (call.reason) data.reason = call.reason;
            continue;
        }

        // Event data — copy safe fields
        for (const [k, v] of Object.entries(arg as Record<string, unknown>)) {
            if (typeof v === "function" || k.startsWith("_")) continue;
            data[k] = v;
        }
    }

    return data;
}

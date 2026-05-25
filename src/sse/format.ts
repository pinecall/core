/**
 * SSE format utilities — shared helpers for SSE streams.
 *
 * Derives STREAM_EVENTS from CALL_PROXY_EVENTS to avoid duplication.
 */

import { CALL_PROXY_EVENTS } from "../dispatch/proxy.js";

/** SSE-streamable events — call lifecycle + all proxy events. */
export const STREAM_EVENTS = [
    "call.started", "call.ended",
    ...CALL_PROXY_EVENTS.filter(e =>
        e !== "call.held" && e !== "call.unheld" &&
        e !== "call.muted" && e !== "call.unmuted" &&
        e !== "llm.tool_call" && e !== "session.timeout"
    ),
] as const;

/** Format a single SSE message. */
export function formatSSE(event: string, data: Record<string, unknown>): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** SSE headers for HTTP responses. */
export const SSE_HEADERS: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no", // nginx
};

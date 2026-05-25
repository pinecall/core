/**
 * Event proxy utility — consolidates the three duplicated proxy methods
 * from client.ts and agent.ts into one reusable function.
 *
 * Replaces:
 *   - Agent._proxyCallEvents (agent.ts)
 *   - Pinecall._proxyCallEvents (client.ts)
 *   - Pinecall._proxyAgentEvents (client.ts)
 */

import type { TypedEmitter } from "./emitter.js";

/** Events that are proxied from Call → Agent (call-scoped → agent-scoped). */
export const CALL_PROXY_EVENTS = [
    "speech.started",
    "speech.ended",
    "user.speaking",
    "user.message",
    "eager.turn",
    "turn.pause",
    "turn.end",
    "turn.resumed",
    "turn.continued",
    "bot.speaking",
    "bot.word",
    "bot.finished",
    "bot.interrupted",
    "message.confirmed",
    "reply.rejected",
    "audio.metrics",
    "call.held",
    "call.unheld",
    "call.muted",
    "call.unmuted",
    "llm.tool_call",
    "session.timeout",
] as const;

/**
 * Forward events from a Call emitter to an Agent/Pinecall emitter.
 *
 * Call emits: `(event, ...callArgs)`
 * Agent emits: `(event, ...callArgs, call)`
 *
 * @param source - The call emitter
 * @param target - The agent or pinecall emitter
 * @param context - Extra argument appended to each emission (typically the Call instance)
 */
export function forwardCallEvents(
    source: TypedEmitter<any>,
    target: TypedEmitter<any>,
    context: unknown,
): void {
    for (const event of CALL_PROXY_EVENTS) {
        source.on(event, (...args: unknown[]) => {
            (target as any).emit(event, ...args, context);
        });
    }
}

/**
 * Forward events from an Agent emitter to a Pinecall emitter.
 *
 * Agent emits: `(event, ...agentArgs)`
 * Pinecall emits: `(event, ...agentArgs)` — passthrough, same signature.
 */
export function forwardAgentEvents(
    source: TypedEmitter<any>,
    target: TypedEmitter<any>,
): void {
    for (const event of CALL_PROXY_EVENTS) {
        source.on(event, (...args: unknown[]) => {
            (target as any).emit(event, ...args);
        });
    }
    // Also forward call lifecycle events
    source.on("call.started", (...args: unknown[]) => {
        (target as any).emit("call.started", ...args);
    });
    source.on("call.ended", (...args: unknown[]) => {
        (target as any).emit("call.ended", ...args);
    });
}

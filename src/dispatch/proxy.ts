/**
 * Event proxy — forward call/agent events up the chain.
 *
 * Call → Agent: event args + call appended
 * Agent → Pinecall: passthrough
 *
 * Port of src.bkp/utils/proxy.ts.
 */

import type { TypedEventBus, EventMap } from "../kernel/event-bus.js";

/** Events that are proxied from Call → Agent (and Agent → Pinecall). */
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
    "llm.toolCall",
    "session.timeout",
] as const;

/**
 * Forward events from a Call emitter to an Agent/Pinecall emitter.
 *
 * Call emits: `(event, ...callArgs)`
 * Agent emits: `(event, ...callArgs, call)`
 */
export function forwardCallEvents(
    source: TypedEventBus<any>,
    target: TypedEventBus<any>,
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
    source: TypedEventBus<any>,
    target: TypedEventBus<any>,
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

/**
 * Event data — the shape an agent event takes on the wire.
 *
 * Agent events are emitted with whatever arguments the emitter had at hand:
 * a Call, a plain data object, or both. Every stream transport (SSE and
 * WebSocket) has to flatten that argument list into ONE JSON object before it
 * can send it, and they must flatten it the SAME way — a browser listening on
 * `/events` and one listening on `/ws/events` are looking at the same call.
 *
 * That is why this lives here instead of once per transport: it IS the shared
 * shape, not a helper either transport happens to need.
 */

import type { Call } from "../domain/call.js";

/**
 * Flatten an event's emitted arguments into a single JSON-safe object.
 *
 * A Call argument is recognised structurally (id + from + to + transport) and
 * reduced to its identifying fields — the whole object is not serialisable.
 * Anything else is copied field by field, skipping functions and `_`-prefixed
 * internals so nothing private leaks to a listener.
 */
export function buildEventData(event: string, args: unknown[]): Record<string, unknown> {
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

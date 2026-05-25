/**
 * SSE (Server-Sent Events) stream utility.
 *
 * Creates a ReadableStream that subscribes to agent events and
 * serializes them as SSE format. Works with any framework that
 * accepts a standard Response or Node.js ServerResponse.
 *
 * Usage:
 *   return agent.stream();           // → Response (Remix, Next, Hono, Bun)
 *   agent.stream(res);              // → writes to ServerResponse (Express)
 *   return pc.stream();             // → all agents
 *   return pc.stream({ agents: ["mara"] }); // → filtered
 */

import type { Agent } from "./agent.js";
import type { Call } from "./call.js";
import type { ServerResponse } from "node:http";

// Events to stream (all meaningful agent events)
const STREAM_EVENTS = [
    "call.started", "call.ended",
    "user.speaking", "user.message",
    "bot.speaking", "bot.word", "bot.finished", "bot.interrupted",
    "turn.end", "turn.pause",
    "speech.started", "speech.ended",
] as const;

/** Format a single SSE message. */
function formatSSE(event: string, data: Record<string, unknown>): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** SSE headers for HTTP responses. */
const SSE_HEADERS: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no", // nginx
};

// ─── Agent stream ────────────────────────────────────────────────────────

export interface StreamOptions {
    /** Filter to specific agent IDs. */
    agents?: string[];
}

/**
 * Create an SSE stream from a single agent's events.
 *
 * @overload stream() → Response (Web API)
 * @overload stream(res) → writes to ServerResponse (Node.js)
 */
export function createAgentStream(agent: Agent): Response;
export function createAgentStream(agent: Agent, res: ServerResponse): void;
export function createAgentStream(agent: Agent, res?: ServerResponse): Response | void {
    const handlers: Array<{ event: string; handler: (...args: any[]) => void }> = [];

    const cleanup = () => {
        for (const { event, handler } of handlers) {
            agent.off(event, handler);
        }
        handlers.length = 0;
    };

    const writeFn = (event: string, data: Record<string, unknown>) => {
        const payload = { ...data, agent: agent.id };
        const msg = formatSSE(event, payload);

        if (res) {
            try { res.write(msg); } catch { cleanup(); }
        }
        return msg;
    };

    // ── Node.js ServerResponse mode ──
    if (res) {
        res.writeHead(200, SSE_HEADERS);
        res.write(formatSSE("connected", { agent: agent.id }));

        for (const evt of STREAM_EVENTS) {
            const handler = (...args: any[]) => {
                const data = buildEventData(evt, args);
                writeFn(evt, data);
            };
            handlers.push({ event: evt, handler });
            agent.on(evt, handler);
        }

        // Keepalive
        const ping = setInterval(() => {
            try { res.write(":ping\n\n"); } catch { clearInterval(ping); cleanup(); }
        }, 30_000);

        res.on("close", () => { clearInterval(ping); cleanup(); });
        return;
    }

    // ── Web API Response mode ──
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(
                formatSSE("connected", { agent: agent.id }),
            ));

            for (const evt of STREAM_EVENTS) {
                const handler = (...args: any[]) => {
                    const data = buildEventData(evt, args);
                    const payload = { ...data, agent: agent.id };
                    try {
                        controller.enqueue(encoder.encode(formatSSE(evt, payload)));
                    } catch { cleanup(); }
                };
                handlers.push({ event: evt, handler });
                agent.on(evt, handler);
            }

            // Keepalive
            const ping = setInterval(() => {
                try { controller.enqueue(encoder.encode(":ping\n\n")); }
                catch { clearInterval(ping); cleanup(); }
            }, 30_000);

            // Store ping for cancel cleanup
            (controller as any)._pingTimer = ping;
        },
        cancel() {
            const ping = (this as any)?._pingTimer;
            if (ping) clearInterval(ping);
            cleanup();
        },
    });

    return new Response(stream, { headers: SSE_HEADERS });
}

// ─── Multi-agent stream ──────────────────────────────────────────────────

/**
 * Create an SSE stream from multiple agents.
 */
export function createMultiAgentStream(
    agents: Map<string, Agent>,
    filter?: StreamOptions,
): Response;
export function createMultiAgentStream(
    agents: Map<string, Agent>,
    res: ServerResponse,
    filter?: StreamOptions,
): void;
export function createMultiAgentStream(
    agents: Map<string, Agent>,
    resOrFilter?: ServerResponse | StreamOptions,
    filter?: StreamOptions,
): Response | void {
    let res: ServerResponse | undefined;
    let opts: StreamOptions | undefined;

    if (resOrFilter && typeof (resOrFilter as any).writeHead === "function") {
        res = resOrFilter as ServerResponse;
        opts = filter;
    } else {
        opts = resOrFilter as StreamOptions;
    }

    const targetAgents = getFilteredAgents(agents, opts);
    const allHandlers: Array<{ agent: Agent; event: string; handler: (...args: any[]) => void }> = [];

    const cleanup = () => {
        for (const { agent, event, handler } of allHandlers) {
            agent.off(event, handler);
        }
        allHandlers.length = 0;
    };

    const agentIds = targetAgents.map(a => a.id);

    // ── Node.js ServerResponse mode ──
    if (res) {
        res.writeHead(200, SSE_HEADERS);
        res.write(formatSSE("connected", { agents: agentIds }));

        for (const agent of targetAgents) {
            for (const evt of STREAM_EVENTS) {
                const handler = (...args: any[]) => {
                    const data = buildEventData(evt, args);
                    const payload = { ...data, agent: agent.id };
                    try { res!.write(formatSSE(evt, payload)); }
                    catch { cleanup(); }
                };
                allHandlers.push({ agent, event: evt, handler });
                agent.on(evt, handler);
            }
        }

        const ping = setInterval(() => {
            try { res!.write(":ping\n\n"); } catch { clearInterval(ping); cleanup(); }
        }, 30_000);

        res.on("close", () => { clearInterval(ping); cleanup(); });
        return;
    }

    // ── Web API Response mode ──
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(
                formatSSE("connected", { agents: agentIds }),
            ));

            for (const agent of targetAgents) {
                for (const evt of STREAM_EVENTS) {
                    const handler = (...args: any[]) => {
                        const data = buildEventData(evt, args);
                        const payload = { ...data, agent: agent.id };
                        try { controller.enqueue(encoder.encode(formatSSE(evt, payload))); }
                        catch { cleanup(); }
                    };
                    allHandlers.push({ agent, event: evt, handler });
                    agent.on(evt, handler);
                }
            }

            const ping = setInterval(() => {
                try { controller.enqueue(encoder.encode(":ping\n\n")); }
                catch { clearInterval(ping); cleanup(); }
            }, 30_000);
            (controller as any)._pingTimer = ping;
        },
        cancel() {
            const ping = (this as any)?._pingTimer;
            if (ping) clearInterval(ping);
            cleanup();
        },
    });

    return new Response(stream, { headers: SSE_HEADERS });
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function getFilteredAgents(agents: Map<string, Agent>, opts?: StreamOptions): Agent[] {
    const all = [...agents.values()];
    if (!opts?.agents?.length) return all;
    return all.filter(a => opts.agents!.includes(a.id));
}

/** Extract serializable data from event handler args. */
function buildEventData(event: string, args: any[]): Record<string, unknown> {
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

        // Event data object — copy safe fields (already camelCase from SDK transform)
        for (const [k, v] of Object.entries(arg)) {
            if (typeof v === "function" || k.startsWith("_")) continue;
            data[k] = v;
        }
    }

    return data;
}

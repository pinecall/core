/**
 * SSE stream — creates SSE responses from agent events.
 *
 * Port of src.bkp/sse.ts — identical behavior.
 */

import type { Agent } from "../domain/agent.js";
import type { Call } from "../domain/call.js";
import type { ServerResponse } from "node:http";
import { formatSSE, SSE_HEADERS, STREAM_EVENTS } from "./format.js";

export interface StreamOptions {
    agents?: string[];
}

// ─── Agent stream ────────────────────────────────────────────────────────

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

    // ── Node.js ServerResponse mode ──
    if (res) {
        // Disable TCP Nagle — critical for real-time SSE delivery
        (res as any).socket?.setNoDelay?.(true);
        res.writeHead(200, SSE_HEADERS);
        res.flushHeaders();
        res.write(formatSSE("connected", { agent: agent.id }));

        for (const evt of STREAM_EVENTS) {
            const handler = (...args: any[]) => {
                const data = buildEventData(evt, args);
                const payload = { ...data, agent: agent.id };
                try { res.write(formatSSE(evt, payload)); } catch { cleanup(); }
            };
            handlers.push({ event: evt, handler });
            agent.on(evt, handler);
        }

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

// ─── Multi-agent stream ──────────────────────────────────────────────────

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
        res.flushHeaders();
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

        // Event data — copy safe fields
        for (const [k, v] of Object.entries(arg)) {
            if (typeof v === "function" || k.startsWith("_")) continue;
            data[k] = v;
        }
    }

    return data;
}

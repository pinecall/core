/**
 * SSE stream — creates SSE responses from agent events.
 *
 * Port of src.bkp/sse.ts — identical behavior.
 */

import type { Agent } from "../domain/agent.js";
import type { ServerResponse } from "node:http";
import { formatSSE, SSE_HEADERS, STREAM_EVENTS } from "./format.js";
import { buildEventData } from "../stream/event-data.js";

export interface StreamOptions {
    agents?: string[];
}

// ─── Dedup ───────────────────────────────────────────────────────────────

/**
 * A call's events can reach an agent listener more than once for the same
 * logical message — a re-sent wire frame from the server, or a call proxied
 * twice under a race. Each SSE connection guards against writing the same
 * (event, callId, messageId) frame twice: the FIRST copy wins, every later
 * one is dropped before it reaches `res.write()`. Events with no messageId
 * (call.started, audio.metrics, …) are never deduped — only a message has an
 * id to be idempotent on.
 */
function createDedupeGuard(): (event: string, data: Record<string, unknown>) => boolean {
    const seen = new Set<string>();
    return (event, data) => {
        const messageId = typeof data.messageId === "string" ? data.messageId : "";
        if (!messageId) return false;
        const key = `${event}|${data.callId ?? ""}|${messageId}`;
        if (seen.has(key)) return true;
        seen.add(key);
        return false;
    };
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

        const dedupe = createDedupeGuard();
        for (const evt of STREAM_EVENTS) {
            const handler = (...args: any[]) => {
                const data = buildEventData(evt, args);
                if (dedupe(evt, data)) return;
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

            const dedupe = createDedupeGuard();
            for (const evt of STREAM_EVENTS) {
                const handler = (...args: any[]) => {
                    const data = buildEventData(evt, args);
                    if (dedupe(evt, data)) return;
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

        const dedupe = createDedupeGuard();
        for (const agent of targetAgents) {
            for (const evt of STREAM_EVENTS) {
                const handler = (...args: any[]) => {
                    const data = buildEventData(evt, args);
                    if (dedupe(evt, data)) return;
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

            const dedupe = createDedupeGuard();
            for (const agent of targetAgents) {
                for (const evt of STREAM_EVENTS) {
                    const handler = (...args: any[]) => {
                        const data = buildEventData(evt, args);
                        if (dedupe(evt, data)) return;
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


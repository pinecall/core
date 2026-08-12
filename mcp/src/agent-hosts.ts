/**
 * AgentHosts — the live SDK connections this MCP session is holding open.
 *
 * WHY THIS EXISTS (the lifetime question, answered from the code, not guessed):
 *
 * A Pinecall agent is NOT a stored record. `pc.agent(slug, config)` sends
 * `agent.create` over the client WebSocket (src/client.ts `#registerAgent`),
 * and the server keeps the result in an IN-MEMORY registry keyed by
 * `org_id:slug` (`ClientManager._clients`, sdk-server session/manager.py).
 * When that socket closes, the WS handler's `finally` calls
 * `unregister_client(...)` and the agent is GONE — no row survives it.
 * `GET /api/agents` says so in its own docstring: "List all currently
 * registered (CONNECTED) agents … returns in-memory state".
 *
 * So register-then-disconnect leaves NOTHING reachable. `pinecall run` is a
 * long-lived spawned process for exactly this reason (src/cli/commands/run.ts
 * spawns tsx/node and waits on it). The MCP server must do the same thing:
 * hold one Pinecall client per configured slug for the life of the session.
 * That is what `heldBySession: true` in the tool result reports.
 *
 * Re-configuring the same slug replaces the connection: `pc.agent(id)` returns
 * the EXISTING agent and ignores the new config when the id is already known
 * to that client, so a fresh config needs a fresh client. The old one is
 * disconnected first — which frees the server-side name — and only then is the
 * new one registered, avoiding an AGENT_CONFLICT against ourselves.
 */

import { Pinecall } from "../../src/client.js";
import type { AgentConfig } from "../../src/config/agent.js";
import type { Agent } from "../../src/domain/agent.js";

export interface HostedAgent {
    slug: string;
    client: Pinecall;
    agent: Agent;
    /** Epoch ms of the (re)configuration that produced this connection. */
    configuredAt: number;
    /** How many times this slug has been configured in this session. */
    revision: number;
}

/** Registration is fast; a hung one is a real failure, not a slow network. */
export const READY_TIMEOUT_MS = 20_000;

export class AgentHosts {
    readonly #hosts = new Map<string, HostedAgent>();

    get(slug: string): HostedAgent | undefined {
        return this.#hosts.get(slug);
    }

    list(): HostedAgent[] {
        return [...this.#hosts.values()];
    }

    /**
     * Register (or hot-reload) `slug` and KEEP the connection open.
     * Resolves once the server has acked with `agent.created`/`agent.resumed`.
     */
    async configure(
        slug: string,
        config: AgentConfig,
        opts: { apiKey: string; apiUrl?: string; timeoutMs?: number },
    ): Promise<HostedAgent> {
        const previous = this.#hosts.get(slug);
        if (previous) {
            this.#hosts.delete(slug);
            await previous.client.disconnect().catch(() => {});
        }

        const client = new Pinecall({
            apiKey: opts.apiKey,
            ...(opts.apiUrl ? { apiUrl: opts.apiUrl } : {}),
        });

        try {
            await client.connect();
            const agent = client.agent(slug, config);
            await waitForReady(client, agent, opts.timeoutMs ?? READY_TIMEOUT_MS);

            const host: HostedAgent = {
                slug,
                client,
                agent,
                configuredAt: Date.now(),
                revision: (previous?.revision ?? 0) + 1,
            };
            this.#hosts.set(slug, host);
            return host;
        } catch (err) {
            await client.disconnect().catch(() => {});
            throw err;
        }
    }

    /** Drop one held agent (the server unregisters it as the socket closes). */
    async release(slug: string): Promise<boolean> {
        const host = this.#hosts.get(slug);
        if (!host) return false;
        this.#hosts.delete(slug);
        await host.client.disconnect().catch(() => {});
        return true;
    }

    /** Session teardown. */
    async releaseAll(): Promise<void> {
        await Promise.all(this.list().map((h) => this.release(h.slug)));
    }
}

/**
 * Resolve on the agent's `ready` (emitted from `agent.created`/`agent.resumed`),
 * reject on a terminal registration conflict or on timeout.
 */
export function waitForReady(client: Pinecall, agent: Agent, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const done = (err?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            agent.off("ready", onReady as any);
            client.off("error", onError as any);
            err ? reject(err) : resolve();
        };
        const onReady = () => done();
        const onError = (err: Error) => done(err);
        const timer = setTimeout(
            () =>
                done(
                    new Error(
                        `Timed out after ${timeoutMs}ms waiting for the server to register agent "${agent.id}". ` +
                        `The socket connected but no agent.created arrived — check the API key's org and the server URL.`,
                    ),
                ),
            timeoutMs,
        );
        agent.on("ready", onReady as any);
        client.on("error", onError as any);
    });
}

/** One per process = one per MCP session. */
export const agentHosts = new AgentHosts();

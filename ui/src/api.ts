/**
 * The console's HTTP client — the frozen contract with the runner's server.
 *
 *   GET  /api/agents             → { agents }
 *   GET  /api/calls              → { calls }
 *   GET  /events                 → SSE (console.hello first, then agent events)
 *   POST /token       { agent }  → { token, server, agent }   (WebRTC)
 *   POST /chat-token  { agent }  → { token, server, agent }   (text chat)
 *   POST /api/calls/:id/hangup   → { ok: true }
 *
 * The Pinecall API key NEVER reaches this page: the runner mints every token.
 * When the console is bound to a non-loopback host the run key travels as
 * `?k=` (the first request also sets the cookie the server reads afterwards).
 */

import type { CallSnapshot } from "./state/transcript-reducer.js";

export interface AgentInfo {
    id: string;
    label?: string;
    channels: string[];
    phone?: string;
    llm?: string;
    voice?: string;
    tools: string[];
    /** Advertised when the runner can ring you back (`--call`). */
    canCall?: boolean;
}

export const RUN_KEY = new URLSearchParams(location.search).get("k") ?? "";

/** Add the run key to a path when this console was opened with one. */
export function withKey(path: string): string {
    if (!RUN_KEY) return path;
    return `${path}${path.includes("?") ? "&" : "?"}k=${encodeURIComponent(RUN_KEY)}`;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(withKey(path), { credentials: "same-origin", ...init });
    if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
    return (await res.json()) as T;
}

const post = <T,>(path: string, body: unknown) =>
    json<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const fetchAgents = () => json<{ agents: AgentInfo[] }>("/api/agents").then((r) => r.agents ?? []);
export const fetchCalls = () => json<{ calls: CallSnapshot[] }>("/api/calls").then((r) => r.calls ?? []);
export const hangup = (id: string) => post<{ ok: boolean }>(`/api/calls/${encodeURIComponent(id)}/hangup`, {});

export interface MintedToken {
    token: string;
    server: string;
    expires_in?: number;
}

/** Token providers for @pinecall/web — the runner holds the key, we hold nothing. */
export const voiceToken = (agent: string) => () => post<MintedToken>("/token", { agent });
export const chatToken = (agent: string) => () => post<MintedToken>("/chat-token", { agent });

export const eventsUrl = (agent?: string) => withKey(agent ? `/events?agent=${encodeURIComponent(agent)}` : "/events");

/**
 * Call-log access for the MCP tools — the ONE place that knows how to reach
 * call-log v3 (docs/guides/call-log.md).
 *
 * Two things live here and nowhere else:
 *
 *  1. **Minting.** The log endpoints do not take the API key; they take a
 *     `stream` token, minted server-side per request with the SDK's
 *     `createToken` (src/api/tokens.ts). The token seals the agent SET it may
 *     see, so one is minted per agent, per request, and is never returned to
 *     the caller.
 *  2. **Row reduction for the AGENT log.** `GET /v1/agents/{slug}/calls`
 *     returns log ENTRIES, not rows — lifecycle only. Folding them into one
 *     row per call is done here so both the tool and its tests share it.
 *
 * The CALL log is NOT reduced here: `@pinecall/sdk/log` already ships the one
 * reducer (`CallLogView`), including supersedes/ephemeral semantics. Tools use
 * it directly rather than growing a second implementation.
 */

import { createToken } from "../../src/api/tokens.js";
import type { AnyLogEntry, CallDirection } from "../../src/log/types.js";
import type { Session } from "./session.js";

/** What the two HTTP log endpoints return. */
export interface LogPage {
    entries: AnyLogEntry[];
    live?: boolean;
    /** Cursor to resume from. Absent on the agent log — fall back to max seq. */
    next?: number;
}

/** One row of `list_calls`. */
export interface CallRow {
    call: string;
    /** Started and not ended, as far as this log says. */
    live: boolean;
    direction?: CallDirection;
    from?: string;
    to?: string;
    /** ISO-8601, from the entry `ts` (server clock), never wall clock. */
    startedAt?: string;
    endedAt?: string;
    /** `call.ended.reason`, when it ended. */
    reason?: string;
    durationSec?: number;
}

/** Entry `ts` is float seconds; the tools speak ISO so a reader can read it. */
export function tsToIso(ts: number | undefined): string | undefined {
    if (typeof ts !== "number" || !Number.isFinite(ts)) return undefined;
    return new Date(ts * 1000).toISOString();
}

/**
 * Mint a stream token for one agent. Scope `observe` is the read-only one —
 * a log tool must never be able to speak on a call.
 */
export async function mintStreamToken(
    session: Session,
    agent: string | readonly string[],
    callId?: string,
): Promise<{ token: string; server: string }> {
    const { token, server } = await createToken({
        channel: "stream",
        agentId: agent as string | readonly string[],
        scope: "observe",
        ...(callId ? { callId } : {}),
        apiKey: session.apiKey(),
        apiUrl: session.serverUrl,
    });
    return { token, server: server || session.serverUrl };
}

/**
 * Every agent slug in the org — the agent SET a call-scoped token is minted
 * over when the caller gives a call id but not its agent. A token covers a
 * call iff the call's agent is in its set (call-log guide, "Tokens"), and
 * `get_call(call_id)` is deliberately callable with the id alone.
 */
export async function allAgentSlugs(session: Session): Promise<string[]> {
    const res = await session.server<{ agents?: { slug?: string }[] }>("/api/sdk/agents");
    const slugs = (res.agents ?? []).map((a) => a.slug).filter((s): s is string => !!s);
    if (slugs.length === 0) throw new Error("No agents in this org — nothing to observe.");
    return slugs;
}

/** GET one page of a log. The token travels in the query, as the wire API takes it. */
export async function fetchLogPage(
    session: Session,
    server: string,
    path: string,
    params: Record<string, string | number | undefined>,
): Promise<LogPage> {
    const url = new URL(`${server.replace(/\/+$/, "")}${path}`);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url);
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(session.redact(`Call log ${res.status} on ${path}: ${body}`));
    }
    const page = (await res.json()) as LogPage;
    return { entries: Array.isArray(page.entries) ? page.entries : [], live: page.live, next: page.next };
}

/** Highest seq in a page, or the cursor we came in with if the page was empty. */
export function maxSeq(entries: readonly AnyLogEntry[], fallback: number): number {
    let out = fallback;
    for (const e of entries) if (typeof e.seq === "number" && e.seq > out) out = e.seq;
    return out;
}

/**
 * Fold an AGENT log into one row per call.
 *
 * ⚠️ The trap this function exists for: in an agent-log entry the envelope's
 * `call` is **null** — the entry belongs to the agent's log, not a call's —
 * and the call id lives in `data.call` (call-log guide, "Two logs"). Reading
 * `entry.call` alone yields a list of nulls, silently.
 */
export function reduceAgentLog(entries: readonly AnyLogEntry[]): CallRow[] {
    const rows = new Map<string, CallRow>();

    for (const entry of entries) {
        const data = (entry.data ?? {}) as Record<string, any>;
        const id: unknown = entry.call ?? data.call;
        if (typeof id !== "string" || !id) continue;

        let row = rows.get(id);
        if (!row) {
            row = { call: id, live: false };
            rows.set(id, row);
        }

        switch (entry.type) {
            case "call.ringing":
                row.direction ??= data.direction;
                row.from ??= data.from;
                row.to ??= data.to;
                break;
            case "call.started":
                row.direction = data.direction ?? row.direction;
                row.from = data.from ?? row.from;
                row.to = data.to ?? row.to;
                row.startedAt = tsToIso(entry.ts) ?? row.startedAt;
                if (!row.endedAt) row.live = true;
                break;
            case "call.ended":
                row.endedAt = tsToIso(entry.ts) ?? row.endedAt;
                row.reason = data.reason ?? row.reason;
                if (typeof data.duration === "number") row.durationSec = round(data.duration);
                row.live = false;
                break;
            default:
                break;
        }
    }

    // Newest first — the debugger almost always wants the call it just made.
    return [...rows.values()].sort((a, b) => order(b) - order(a));
}

function order(row: CallRow): number {
    const t = row.endedAt ?? row.startedAt;
    return t ? Date.parse(t) : 0;
}

export function round(n: number, digits = 2): number {
    const f = 10 ** digits;
    return Math.round(n * f) / f;
}

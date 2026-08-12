/**
 * list_calls — what calls this agent has, and which are still running.
 *
 * Reads the AGENT log (`GET /v1/agents/{slug}/calls`), which is lifecycle
 * only: ringing / started / ended, never transcripts. Content comes from
 * `get_call`.
 */

import { z } from "zod";
import { defineTool } from "./types.js";
import { fetchLogPage, maxSeq, mintStreamToken, reduceAgentLog } from "../call-log.js";
import type { AnyLogEntry } from "../../../src/log/types.js";

/** Safety rail on the page loop — an agent log is small, but never unbounded. */
const MAX_PAGES = 20;

export default defineTool({
    name: "list_calls",
    description:
        "Calls of one agent — id, live?, direction, from, started/ended — newest first. The index into the call log; read one with get_call.",
    schema: {
        agent: z.string().min(1).describe("Agent slug, e.g. dev-bistro."),
        live: z.boolean().optional().describe("Only calls still running."),
        limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 20)."),
    },
    manual: [
        "**`list_calls`** — the index of the call log. `{ agent, live?, limit? }` →",
        "`{ agent, calls: [{ call, live, direction, from, startedAt, endedAt, reason }], truncated }`,",
        "newest first. It reads the agent's LIFECYCLE log, so there are no transcripts here —",
        "take a `call` id and pass it to `get_call`.",
        "",
        "After a `chat` turn or a phone call, this is where you find the id of what just",
        "happened. `live: true` narrows to calls still running.",
    ].join("\n"),
    async handler(args: { agent: string; live?: boolean; limit?: number }, { session }) {
        const limit = args.limit ?? 20;
        const { token, server } = await mintStreamToken(session, args.agent);

        const entries: AnyLogEntry[] = [];
        let after = 0;
        for (let page = 0; page < MAX_PAGES; page++) {
            const res = await fetchLogPage(session, server, `/v1/agents/${encodeURIComponent(args.agent)}/calls`, {
                token,
                after,
            });
            if (res.entries.length === 0) break;
            entries.push(...res.entries);
            const next = res.next ?? maxSeq(res.entries, after);
            if (next <= after) break; // no progress — the log is exhausted
            after = next;
        }

        let calls = reduceAgentLog(entries);
        if (args.live) calls = calls.filter((c) => c.live);
        const truncated = calls.length > limit;

        return {
            agent: args.agent,
            calls: calls.slice(0, limit),
            truncated,
            ...(truncated ? { total: calls.length } : {}),
        };
    },
});

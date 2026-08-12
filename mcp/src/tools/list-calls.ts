/**
 * list_calls — what calls this agent has, and which are still running.
 *
 * Reads the AGENT log (`GET /v1/agents/{slug}/calls`), which is lifecycle
 * only: ringing / started / ended, never transcripts. Content comes from
 * `get_call`.
 */

import { z } from "zod";
import { defineTool } from "./types.js";
import { mintStreamToken, readAgentLog, reduceAgentLog } from "../call-log.js";

export default defineTool({
    name: "list_calls",
    description:
        "Calls of one agent — id, live?, direction, from, started/ended — newest first. The index into the call log; read one with get_call.",
    schema: {
        agent: z.string().min(1).describe("Agent slug, e.g. dev-bistro."),
        live: z.boolean().optional().describe("Only calls still running."),
        limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 20)."),
    },
    manual: "The lifecycle index, no transcripts: find the `call` id of what just happened, then read it with `get_call`.",
    async handler(args: { agent: string; live?: boolean; limit?: number }, { session }) {
        const limit = args.limit ?? 20;
        const { token, server } = await mintStreamToken(session, args.agent);

        const { entries } = await readAgentLog(session, server, token, args.agent);

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

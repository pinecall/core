/**
 * get_call — one call, reduced. THE debugger.
 *
 * `GET /v1/calls/{id}/events?after=` returns raw log entries, including the
 * ephemeral ones (partial transcripts, per-word TTS timing) that exist only to
 * animate a UI. Handing those to a coding agent is noise, so the page is folded
 * through `CallLogView` — the ONE reducer, shipped by `@pinecall/sdk/log`,
 * which already implements the supersedes/ephemeral semantics of the spec.
 * Reimplementing it here would be a second answer to the same question.
 *
 * The cursor is the whole protocol: `after` in, `nextAfter` out. `truncated`
 * says the page was cut on purpose and the next call should start at
 * `nextAfter` — never a silent loss.
 */

import { z } from "zod";
import { defineTool } from "./types.js";
import { allAgentSlugs, fetchLogPage, maxSeq, mintStreamToken, reduceCallEntries, tsToIso } from "../call-log.js";

/** Entries applied per call. Big enough for a normal call, small enough to read. */
const DEFAULT_LIMIT = 300;

export default defineTool({
    name: "get_call",
    description:
        "One call's log, reduced: phase, transcript messages with seqs, tool calls with args and results, turn latencies, summary. Cursor-paged with after/nextAfter.",
    schema: {
        call_id: z.string().min(1).describe("Call id, e.g. CA4cbc... — from list_calls."),
        after: z.number().int().min(0).optional().describe("Resume cursor: the nextAfter of the previous page."),
        agent: z.string().optional().describe("Agent slug, if known — skips resolving it."),
        limit: z.number().int().min(1).max(2000).optional().describe("Max log entries per page (default 300)."),
    },
    manual: "The debugger: read the log instead of guessing. `truncated` → call again with `after = nextAfter`; `gaps` = the hot buffer moved past you.",
    async handler(
        args: { call_id: string; after?: number; agent?: string; limit?: number },
        { session },
    ) {
        const after = args.after ?? 0;
        const limit = args.limit ?? DEFAULT_LIMIT;

        const agents = args.agent ?? (await allAgentSlugs(session));
        const { token, server } = await mintStreamToken(session, agents, args.call_id);

        const page = await fetchLogPage(session, server, `/v1/calls/${encodeURIComponent(args.call_id)}/events`, {
            token,
            after,
        });

        const truncated = page.entries.length > limit;
        const applied = truncated ? page.entries.slice(0, limit) : page.entries;

        // Truncated ⇒ resume at the last entry we actually applied, not the
        // server's cursor, or the tail of this page would be skipped.
        const nextAfter = truncated
            ? maxSeq(applied, after)
            : (page.next ?? maxSeq(applied, after));

        const reduced = reduceCallEntries(applied, args.call_id, page.live);

        return {
            ...reduced,
            startedAt: tsToIso(applied[0]?.ts),
            entryCount: applied.length,
            nextAfter,
            truncated,
        };
    },
});

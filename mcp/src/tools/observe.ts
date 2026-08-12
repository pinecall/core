/**
 * observe — the LIVE half of the call log. `get_call` restores a transcript;
 * this one waits for the next thing to happen.
 *
 * An MCP tool call cannot push, so live is expressed as a LONG POLL: attach to
 * `WS /v1/attach`, return the moment entries past `after` arrive, close the
 * socket on the way out. The agent runs it in a loop while a human talks to
 * the agent and watches the call unfold a turn at a time.
 *
 * Two modes, the two logs of the spec:
 *
 *   · `call`  — one call's content: transcripts, tools, phase. Reduced to the
 *     exact shape `get_call` answers with (shared reducer in call-log.ts), so
 *     a loop that switches between history and live never changes vocabulary.
 *   · `agent` — the agent's lifecycle log, which is how you catch a call you
 *     do not have the id of yet: it returns the moment one starts, handing
 *     back the id to observe. ⚠️ In an agent-log entry the envelope's `call`
 *     is null and the id lives in `data.call` — `reduceAgentLog` owns that.
 *
 * Silence is an ANSWER: `{ timedOut: true, nextAfter: <unchanged> }`, never an
 * error, because an error would end the loop the tool exists to sustain.
 */

import { z } from "zod";
import { defineTool } from "./types.js";
import { attachOnce, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS } from "../attach.js";
import { allAgentSlugs, maxSeq, mintStreamToken, reduceAgentLog, reduceCallEntries } from "../call-log.js";

export default defineTool({
    name: "observe",
    description:
        "Live tail of the call log as a long poll: waits until something happens, then returns it. With call_id — new transcript, tool calls and phase for that call. With agent — returns the moment a call starts, with its id. Silence returns timedOut, never an error.",
    schema: {
        call_id: z.string().optional().describe("Call id to tail. Give this OR agent, not both."),
        agent: z
            .string()
            .optional()
            .describe("Agent slug to tail — returns when a call starts. Also skips resolving the agent for call_id."),
        after: z.number().int().min(0).optional().describe("Resume cursor: the nextAfter of the previous observe (default 0)."),
        waitSeconds: z
            .number()
            .int()
            .min(1)
            .max(MAX_WAIT_SECONDS)
            .optional()
            .describe(`How long to hold the poll open with nothing happening (default ${DEFAULT_WAIT_SECONDS}s, max ${MAX_WAIT_SECONDS}s).`),
    },
    manual:
        "The live debugger: loop it while a human talks to the agent, passing back `nextAfter` each time — `timedOut: true` means nothing happened, just call again with the SAME cursor. Start with `observe(agent)` to catch a call you have no id for, then switch to `observe(call_id)`; `get_call` for the finished transcript.",
    async handler(
        args: { call_id?: string; agent?: string; after?: number; waitSeconds?: number },
        { session },
    ) {
        // Exactly one target: the wire API takes `?call=` or `?agent=`, and
        // guessing which the caller meant would silently tail the wrong log.
        const byCall = !!args.call_id;
        const byAgent = !!args.agent && !args.call_id;
        if (!byCall && !byAgent) {
            throw new Error("observe needs either call_id (tail one call) or agent (tail the agent's log for a new call).");
        }

        const after = args.after ?? 0;
        const waitMs = Math.min(args.waitSeconds ?? DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS) * 1000;

        // Same minting rule as get_call: with a call id but no agent, the token
        // is minted over the whole org's agent set, since a token covers a call
        // iff the call's agent is in its set.
        const agents = args.agent ?? (await allAgentSlugs(session));
        const { token, server } = await mintStreamToken(session, agents, args.call_id);

        const res = await attachOnce(
            {
                server,
                token,
                ...(byCall ? { call: args.call_id } : { agent: args.agent }),
                after,
            },
            waitMs,
        );

        // Nothing happened. The cursor does NOT move — this is the whole
        // contract of the loop: call again with what you were given.
        if (res.timedOut) {
            return { timedOut: true, nextAfter: after, ...(byCall ? { call: args.call_id } : { agent: args.agent }) };
        }

        const nextAfter = maxSeq(res.entries, after);

        if (byAgent) {
            const calls = reduceAgentLog(res.entries);
            return {
                agent: args.agent,
                calls,
                // The point of this mode: the id to switch to. Newest first.
                call: calls[0]?.call,
                live: calls.some((c) => c.live),
                entryCount: res.entries.length,
                nextAfter,
                timedOut: false,
            };
        }

        return {
            ...reduceCallEntries(res.entries, args.call_id!, res.live),
            entryCount: res.entries.length,
            nextAfter,
            timedOut: false,
        };
    },
});

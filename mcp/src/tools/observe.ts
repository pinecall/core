/**
 * observe — the LIVE half of the call log. `get_call` restores a transcript;
 * this one waits for the next thing to happen.
 *
 * An MCP tool call cannot push, so live is expressed as a LONG POLL: attach to
 * `WS /v1/attach`, return the moment entries past `after` arrive, close the
 * socket on the way out. The agent runs it in a loop while a human talks to
 * the agent and watches the call unfold a turn at a time.
 *
 * ## One loop, not two
 *
 * There are two logs — the agent's lifecycle log (a call started / ended) and
 * each call's own log (transcripts, tools, phase) — but a debugger should not
 * have to run a loop over the first to learn an id, stop, and start a second
 * loop over the other. So `observe(agent)` does the whole job:
 *
 *   1. nothing running → it tails the AGENT log, from *now* (the head of that
 *      log) unless given a cursor, so it answers when a call STARTS;
 *   2. a call starts → the same answer carries `call` AND that call's first
 *      entries, already reduced;
 *   3. from then on it tails THAT CALL's log, so the same `observe(agent,
 *      after)` in the same loop streams the transcript;
 *   4. the call ends → it returns the last entries and goes back to step 1,
 *      ready for the next call. No manual switch anywhere.
 *
 * `after` stays the agent-log cursor throughout (`nextAfter` hands it back);
 * the call-log cursor is remembered per agent in follow.ts and is also returned
 * as `callAfter`, so a caller that prefers explicit control can pass
 * `call_after`, or drop to `observe(call_id)` and drive it itself.
 *
 * ⚠️ In an agent-log entry the envelope's `call` is null and the id lives in
 * `data.call` — `reduceAgentLog` owns that trap.
 *
 * Silence is an ANSWER: `{ timedOut: true }` with the cursors unmoved, never an
 * error, because an error would end the loop the tool exists to sustain. That
 * includes a socket dropped without a close frame (1006) — see attach.ts.
 */

import { z } from "zod";
import { defineTool } from "./types.js";
import { attachOnce, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS } from "../attach.js";
import {
    allAgentSlugs,
    fetchLogPage,
    maxSeq,
    mintStreamToken,
    readAgentLog,
    reduceAgentLog,
    reduceCallEntries,
    type CallRow,
    type LogPage,
} from "../call-log.js";
import { getFollow, setFollow } from "../follow.js";
import type { Session } from "../session.js";
import type { AnyLogEntry } from "../../../src/log/types.js";

export default defineTool({
    name: "observe",
    description:
        "Live tail of the call log as a long poll: waits until something happens, then returns it. With agent — the whole job in one loop: it answers when a call starts, carrying the call id AND its first entries, then keeps streaming that call's transcript on the next calls, and goes back to waiting when it ends. With call_id — the same tail for one known call. Silence returns timedOut, never an error.",
    schema: {
        call_id: z.string().optional().describe("Tail exactly this call. Usually unnecessary: observe(agent) follows the live call by itself."),
        agent: z
            .string()
            .optional()
            .describe("Agent slug to tail — catches a call starting and then streams it. Also skips resolving the agent for call_id."),
        after: z.number().int().min(0).optional().describe("Resume cursor: the nextAfter of the previous observe. Omit on the first call to start from now."),
        call_after: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Agent mode, optional: cursor into the followed call's log. Omit — it is tracked for you and returned as callAfter."),
        waitSeconds: z
            .number()
            .int()
            .min(1)
            .max(MAX_WAIT_SECONDS)
            .optional()
            .describe(`How long to hold the poll open with nothing happening (default ${DEFAULT_WAIT_SECONDS}s, max ${MAX_WAIT_SECONDS}s).`),
    },
    manual:
        "The live debugger: call `observe(agent)` in a loop, passing back `nextAfter` each time, and nothing else — it waits for a call to start, hands you `call` with its first entries, then streams that call's transcript, then waits again. `timedOut: true` means nothing happened: call again with the SAME cursor. `following` says which log it is on. `get_call` for a finished transcript.",
    async handler(
        args: { call_id?: string; agent?: string; after?: number; call_after?: number; waitSeconds?: number },
        { session },
    ) {
        // Exactly one target: the wire API takes `?call=` or `?agent=`, and
        // guessing which the caller meant would silently tail the wrong log.
        const byCall = !!args.call_id;
        const byAgent = !!args.agent && !args.call_id;
        if (!byCall && !byAgent) {
            throw new Error("observe needs either call_id (tail one call) or agent (tail the agent's log for a new call).");
        }

        const waitMs = Math.min(args.waitSeconds ?? DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS) * 1000;

        if (byAgent) return observeAgent(session, args.agent!, args, waitMs);

        const after = args.after ?? 0;
        // Same minting rule as get_call: with a call id but no agent, the token
        // is minted over the whole org's agent set, since a token covers a call
        // iff the call's agent is in its set.
        const agents = args.agent ?? (await allAgentSlugs(session));
        const { token, server } = await mintStreamToken(session, agents, args.call_id);

        const res = await attachOnce({ server, token, call: args.call_id, after }, waitMs);

        // Nothing happened. The cursor does NOT move — this is the whole
        // contract of the loop: call again with what you were given.
        if (res.timedOut) return { timedOut: true, nextAfter: after, call: args.call_id };

        return {
            ...reduceCallEntries(res.entries, args.call_id!, res.live),
            entryCount: res.entries.length,
            nextAfter: maxSeq(res.entries, after),
            timedOut: false,
        };
    },
});

/**
 * Agent mode: the two-log loop, collapsed into one call.
 *
 * The branch is simply "is a call already being followed" — if yes we are on
 * its log, if no we are on the agent's, and the answer always says which with
 * `following` plus both cursors, so the next iteration needs no decision from
 * the caller.
 */
async function observeAgent(
    session: Session,
    agent: string,
    args: { after?: number; call_after?: number },
    waitMs: number,
): Promise<Record<string, unknown>> {
    const { token, server } = await mintStreamToken(session, agent);
    const memo = getFollow(agent, args.after);

    // Where to attach on the AGENT log. A caller-supplied cursor wins; then
    // what we handed out last time; otherwise the head of the log — "from now",
    // so the first poll of a loop waits for the NEXT call instead of returning
    // every call this agent has ever taken.
    let agentAfter = args.after ?? memo?.agentAfter;
    let rows: CallRow[] | undefined;
    if (agentAfter === undefined) {
        const log = await readAgentLog(session, server, token, agent);
        agentAfter = log.head;
        rows = reduceAgentLog(log.entries);
        // A call is ALREADY running when the loop starts — the common case when
        // a human picked up the phone a second before. Follow it from its start
        // rather than waiting for a call that has already begun.
        const running = rows.find((r) => r.live);
        if (running) {
            return followCall(session, server, agent, running.call, 0, agentAfter, rows, waitMs);
        }
    }

    if (memo?.call) {
        const callAfter = args.call_after ?? memo.callAfter;
        return followCall(session, server, agent, memo.call, callAfter, agentAfter, undefined, waitMs);
    }

    // Waiting for a call. This is the socket that used to die with 1006 on a
    // quiet agent — it now answers `timedOut` (attach.ts).
    const res = await attachOnce({ server, token, agent, after: agentAfter }, waitMs);
    const nextAfter = maxSeq(res.entries, agentAfter);

    if (res.timedOut) {
        setFollow(agent, { agentAfter: nextAfter, callAfter: 0 });
        return { timedOut: true, agent, following: "agent", nextAfter, ...(rows ? { calls: rows } : {}) };
    }

    const calls = reduceAgentLog(res.entries);
    const started = calls.find((c) => c.live) ?? calls[0];

    // A call just started: do not make the caller ask again for its content —
    // read its first entries now and answer with both in one go.
    if (started?.live) {
        return followCall(session, server, agent, started.call, 0, nextAfter, calls, waitMs, { immediate: true });
    }

    setFollow(agent, { agentAfter: nextAfter, callAfter: 0 });
    return {
        agent,
        following: "agent",
        calls,
        call: calls[0]?.call,
        live: false,
        entryCount: res.entries.length,
        nextAfter,
        timedOut: false,
    };
}

/**
 * Stream one call's log on behalf of agent mode.
 *
 * `immediate` = the call was discovered in this very poll, so its opening
 * entries are read over HTTP and returned at once (there is no waiting to do
 * for something that has already happened). Otherwise this is the steady state:
 * a long poll on the call's log, one turn per answer.
 *
 * When the call ends, the follow is dropped in the same answer that reports it
 * (`following: "agent"`), so the very next iteration of the caller's unchanged
 * loop is back to waiting for the next call.
 */
async function followCall(
    session: Session,
    server: string,
    agent: string,
    call: string,
    callAfter: number,
    agentAfter: number,
    calls: unknown[] | undefined,
    waitMs: number,
    opts: { immediate?: boolean } = {},
): Promise<Record<string, unknown>> {
    // The call-scoped token: a token covers a call iff the call's agent is in
    // its set, and we know the agent here, so no org-wide fan-out is needed.
    const { token } = await mintStreamToken(session, agent, call);

    let entries: AnyLogEntry[];
    let live: boolean | undefined;
    let timedOut = false;

    if (opts.immediate || callAfter === 0) {
        const page: LogPage = await fetchLogPage(session, server, `/v1/calls/${encodeURIComponent(call)}/events`, {
            token,
            after: callAfter,
        });
        entries = page.entries;
        live = page.live;
        // A brand-new call can have nothing in its log yet; that is not silence
        // worth reporting, the next iteration picks it up a beat later.
        timedOut = entries.length === 0;
    } else {
        const res = await attachOnce({ server, token, call, after: callAfter }, waitMs);
        entries = res.entries;
        live = res.live;
        timedOut = res.timedOut;
    }

    // Nothing on this call for a whole budget. Before answering "quiet", look
    // at the agent log: a call that has gone silent must not pin the loop to
    // itself while a NEWER one is ringing — a chat session left open would
    // otherwise make the loop deaf to every phone call after it. Seen for real
    // on dev-bistro. Only on a timeout, so a talking call costs nothing.
    if (timedOut && !opts.immediate) {
        const { token: agentToken } = await mintStreamToken(session, agent);
        const log = await readAgentLog(session, server, agentToken, agent);
        const rows = reduceAgentLog(log.entries);
        const newer = rows.find((r) => r.live && r.call !== call);
        if (newer) {
            return followCall(session, server, agent, newer.call, 0, log.head, rows, waitMs, { immediate: true });
        }
    }

    const nextCallAfter = maxSeq(entries, callAfter);
    const reduced = reduceCallEntries(entries, call, live);
    const ended = entries.some((e) => e.type === "call.ended") || reduced.phase === "ended";

    // Ended → stop following, so the same loop goes back to the agent log.
    setFollow(agent, { agentAfter, call: ended ? undefined : call, callAfter: ended ? 0 : nextCallAfter });

    if (timedOut) {
        return {
            timedOut: true,
            agent,
            call,
            following: ended ? "agent" : "call",
            nextAfter: agentAfter,
            callAfter: nextCallAfter,
        };
    }

    return {
        ...reduced,
        agent,
        following: ended ? "agent" : "call",
        ...(calls ? { calls } : {}),
        entryCount: entries.length,
        nextAfter: agentAfter,
        callAfter: nextCallAfter,
        timedOut: false,
    };
}

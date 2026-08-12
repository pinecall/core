/**
 * Which call is `observe(agent)` currently following, and where in each log.
 *
 * `observe` is one tool call in, one answer out — the caller carries the cursor
 * in `after`, and that is deliberately the whole resume protocol for a single
 * log. But agent mode reads TWO logs (the agent's lifecycle log to catch a call
 * starting, then that call's own log to stream it), and one `after` cannot
 * index both. Rather than grow the tool a second cursor argument the caller has
 * to thread correctly, the second one is remembered here, per agent slug.
 *
 * It is a MEMO, never state correctness depends on:
 *
 *  · the caller can always override it — `call_after`, or `observe(call_id)`
 *    directly, which never consults this at all;
 *  · a caller that passes an `after` other than the one it was handed is
 *    steering somewhere else, so the follow is dropped and agent mode starts
 *    over from the lifecycle log;
 *  · losing the whole map (a restarted server) costs one replay of the current
 *    call from its start, not a wrong answer.
 *
 * Nothing here holds a socket or a timer, so an abandoned loop leaks a few
 * numbers and no resources.
 */

export interface Follow {
    /** Cursor into the AGENT log — the value handed back as `nextAfter`. */
    agentAfter: number;
    /** The call being streamed, if one is. */
    call?: string;
    /** Cursor into that call's log. */
    callAfter: number;
}

const follows = new Map<string, Follow>();

/**
 * What we remember for `agent`, honoured only if the caller resumed with the
 * cursor we gave it. `after` undefined = "wherever you were" (the first call of
 * a loop that has not been told a cursor yet).
 */
export function getFollow(agent: string, after: number | undefined): Follow | undefined {
    const memo = follows.get(agent);
    if (!memo) return undefined;
    if (after !== undefined && after !== memo.agentAfter) return undefined; // caller is steering
    return memo;
}

export function setFollow(agent: string, follow: Follow): Follow {
    follows.set(agent, follow);
    return follow;
}

/** Tests only — the map is process-wide by design. */
export function resetFollows(): void {
    follows.clear();
}

/**
 * Registration-retry backoff — pure delay math for AGENT_CONFLICT retries.
 *
 * Two regimes, chosen by what the server told us:
 *   - holder ALIVE (a real second process owns the name): server-guided
 *     `retryAfterS` (escalating server-side) or local exponential growth,
 *     capped at 10 minutes — never a constant-cadence storm for hours.
 *   - holder unknown/dead (old server, or a stale registration about to be
 *     freed): legacy 5s → 60s exponential, so recovery stays fast.
 * Jitter (±15%) keeps N processes fighting for one name from syncing up.
 */

export const RETRY_CAP_HELD_MS = 600_000; // name actively held elsewhere
export const RETRY_CAP_STALE_MS = 60_000; // stale/unknown — server frees it soon

/**
 * The server's stale-registration window (`LIVENESS_WINDOW_SECS` in
 * sdk-server `session/manager.py`): a registration whose socket has gone
 * silent for this long fails the liveness probe and is displaced.
 */
export const SERVER_LIVENESS_WINDOW_MS = 45_000;

/**
 * TOTAL time a plain (non-fatal) AGENT_CONFLICT may be retried — 2× the
 * server's liveness window, i.e. long enough for a stale registration to be
 * reaped twice over. Past it, the name is held by something the server keeps
 * calling alive, and retrying forever is a storm, not persistence.
 * NOT a per-attempt cap: it bounds the whole episode.
 */
export const CONFLICT_RETRY_BUDGET_MS = 2 * SERVER_LIVENESS_WINDOW_MS;

/** Mutable per-agent conflict-retry state (owned by the client). */
export interface ConflictRetryState {
    attempt: number;
    holderAlive: boolean;
    /** Epoch ms the current conflict episode began — the budget clock. */
    startedAt: number;
}

/**
 * Decide the next move for a conflicted registration: retry after a delay, or
 * stop for good. Pure — the client only owns the timer.
 *
 * - `holderAlive: false` (the server says the holder died) starts a FRESH
 *   episode: fast retries again, budget clock restarted.
 * - the delay never overshoots what is left of the budget, so the last
 *   attempt lands exactly at CONFLICT_RETRY_BUDGET_MS.
 * - once the budget is spent, the answer is terminal.
 */
export function planConflictRetry(
    state: ConflictRetryState,
    hint: { retryAfterS?: number; holderAlive?: boolean } | undefined,
    now: number,
    random: () => number = Math.random,
): { action: "retry"; delayMs: number } | { action: "terminal" } {
    if (hint?.holderAlive === true) state.holderAlive = true;
    if (hint?.holderAlive === false) {
        state.holderAlive = false;
        state.attempt = 0;
        state.startedAt = now;
    }

    const remaining = CONFLICT_RETRY_BUDGET_MS - (now - state.startedAt);
    if (remaining <= 0) return { action: "terminal" };

    const delayMs = Math.min(
        computeRegisterRetryDelay(state.attempt, state.holderAlive, hint?.retryAfterS, random),
        remaining,
    );
    state.attempt++;
    return { action: "retry", delayMs };
}

export function computeRegisterRetryDelay(
    attempt: number,
    holderAlive: boolean,
    retryAfterS?: number,
    random: () => number = Math.random,
): number {
    const cap = holderAlive ? RETRY_CAP_HELD_MS : RETRY_CAP_STALE_MS;
    const base = retryAfterS != null
        ? Math.min(retryAfterS * 1_000, cap)
        : Math.min(5_000 * 2 ** attempt, cap);
    return Math.round(base * (0.85 + random() * 0.3));
}

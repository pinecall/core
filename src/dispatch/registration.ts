/**
 * RegistrationCoordinator — the ONE seam between dispatch and the client's
 * registration state machine.
 *
 * Dispatch handlers used to reach back into the client through a bag of
 * optional underscore-prefixed methods (`_scheduleRegisterRetry?`, …), each
 * called with `?.` and a comment apologising for the shapes an "older
 * implementation" might return. That softness was not defensive, it was a
 * layering leak: the handler could not say what it needed, so it guessed.
 *
 * This interface is the requirement, stated once. It is REQUIRED on the
 * dispatch context — there is no "unwired" case to code around.
 */

/** Server guidance attached to an AGENT_CONFLICT/AGENT_IN_USE rejection. */
export interface RegisterRetryHint {
    /** Server-suggested delay before the next attempt (escalates server-side). */
    retryAfterS?: number;
    /** true = the name is held by a LIVE process (back off hard);
     *  false = the holder is known dead (retry fast). */
    holderAlive?: boolean;
}

export interface RegistrationCoordinator {
    /**
     * Schedule a registration retry after AGENT_CONFLICT/AGENT_IN_USE.
     * `hint` carries the server's structured guidance (retry_after_s,
     * holder_alive) when present.
     *
     * Returns true when this is the FIRST conflict of the episode — callers
     * use it to log the human-facing banner exactly once, because a name
     * actively held elsewhere used to spam it every attempt for hours.
     */
    scheduleRetry(agentId: string, hint?: RegisterRetryHint): boolean;

    /**
     * Terminal conflict: the server proved the name is held by a LIVE process
     * (AGENT_CONFLICT_FATAL). Stop retrying and surface a typed error the
     * developer can catch.
     */
    fail(agentId: string): void;

    /** The server confirmed the registration — drop any pending retry. */
    clear(agentId: string): void;
}

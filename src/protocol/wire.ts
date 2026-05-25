/**
 * Wire types — on-the-wire event shape (snake_case).
 *
 * Internal only. NOT exported from index.ts.
 * Used by the dispatcher and handlers to type raw server messages.
 */

/** Base wire event — every server message has at least an `event` field. */
export interface WireEvent {
    event: string;
    agent_id?: string;
    call_id?: string;
    session_id?: string;
    [key: string]: unknown;
}

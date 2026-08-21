/**
 * CallsModel — the console's read model over the shared transcript store.
 *
 * The third observer of a `pinecall run` process (after the terminal live view
 * and anything the developer wires with `pc.stream()`): it holds no logic of
 * its own, it reads the SAME `TranscriptStore` the terminal renders from, so
 * `GET /api/calls` and the terminal can never disagree about what was said.
 *
 * What it adds on top of the store is only what HTTP needs: a newest-first
 * list capped at the live calls plus the last N ended ones, lookup by id, and
 * hanging a live call up through the agent that owns it.
 */

import type { CallSnapshot, TranscriptStore } from "./transcript-reducer.js";

/** The slice of Agent the model needs — structural, so tests pass fakes. */
export interface CallsModelAgent {
    id: string;
    call(callId: string): { hangup(): void } | undefined;
}

export interface CallsModelOptions {
    store: TranscriptStore;
    agents: ReadonlyMap<string, CallsModelAgent>;
    /** Cap on the returned list (live + ended). Default 50. */
    limit?: number;
}

export interface CallsModel {
    /** Live + recently ended sessions, newest first. */
    list(): CallSnapshot[];
    get(id: string): CallSnapshot | undefined;
    /** End a live call. False when the id is unknown or already ended. */
    hangup(id: string): boolean;
}

export function createCallsModel(opts: CallsModelOptions): CallsModel {
    const limit = opts.limit ?? 50;

    return {
        list() {
            return opts.store.snapshots().slice(0, limit);
        },
        get(id) {
            return opts.store.get(id);
        },
        hangup(id) {
            const snapshot = opts.store.live.get(id);
            if (!snapshot) return false;
            const call = opts.agents.get(snapshot.agent)?.call(id);
            if (!call) return false;
            call.hangup();
            return true;
        },
    };
}

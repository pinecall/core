/**
 * CallHistoryRecorder — incremental persistence of a call's conversation.
 *
 * A call writes its record many times: once when it starts (status "active"),
 * once per confirmed message, and a final time when it ends. The middle ones
 * are debounced — a burst of tool/bot/user events would otherwise hammer the
 * store with near-identical records — and the final one is FLUSHED, so the
 * ended record is never left behind a pending timer.
 *
 * Kept out of `call.ts` so a Call stays a handle on a session; the record is
 * built from the call's public fields only.
 */

import type { Call } from "./call.js";
import type { ConversationRecord, HistoryStore } from "../history.js";

export class CallHistoryRecorder {
    /** Debounce interval for incremental history saves (ms). */
    static HISTORY_DEBOUNCE_MS = 200;

    #call: Call;
    #agentId: string;
    #store: HistoryStore;
    #timer: ReturnType<typeof setTimeout> | undefined;

    constructor(call: Call, agentId: string, store: HistoryStore) {
        this.#call = call;
        this.#agentId = agentId;
        this.#store = store;
    }

    /**
     * Schedule a debounced save (coalesces rapid events).
     */
    saveDebounced(): void {
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = setTimeout(() => {
            this.#timer = undefined;
            this.saveNow();
        }, CallHistoryRecorder.HISTORY_DEBOUNCE_MS);
    }

    /**
     * Immediate save. Builds a ConversationRecord from the call's current state.
     */
    saveNow(): void {
        const call = this.#call;

        const contactId = (
            call.metadata?.userId
                ? String(call.metadata.userId)
                : call.from
        );

        const record: ConversationRecord = {
            callId: call.id,
            agentId: this.#agentId,
            channel: call.transport as ConversationRecord["channel"],
            direction: call.direction,
            from: contactId,
            to: call.to,
            startedAt: call.startedAt,
            endedAt: call.endedAt,
            duration: call.duration,
            reason: call.reason,
            status: call.status,
            transcript: call.transcript,
            messages: call.messages,
            metadata: call.metadata,
        };

        // Fire-and-forget — never block event dispatch
        this.#store.save(record).catch(() => {
            // Silently ignore save errors during call
        });
    }

    /**
     * Cancel any pending debounced save and write the current state now.
     * Used on call.ended, where the last record must be the final one.
     */
    flush(): void {
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = undefined;
        this.saveNow();
    }
}

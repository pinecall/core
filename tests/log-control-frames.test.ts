/**
 * Control frames (`log.caught_up` / `log.gap`) vs the seq dedupe.
 *
 * Per spec §5 (amended from the routes card's finding): control markers are
 * FULL §1 envelopes whose `seq` REPEATS the last seq delivered — never a
 * fresh number, which a future real entry would own and then lose to dedupe.
 * The reducer therefore must dispatch them BEFORE the seq guard and never
 * store them: `entries()` is the resume payload, and a marker in it would
 * both misreport the log and block the real entry that owns that seq.
 */
import { describe, it, expect } from "vitest";
import { CallLogView } from "../src/log/index.js";
import type { AnyLogEntry } from "../src/log/index.js";

const env = (seq: number, type: string, data: Record<string, unknown>): AnyLogEntry =>
    ({
        seq,
        ts: 1000 + seq,
        call: "CA_ctl",
        agent: "lucia",
        type,
        ephemeral: false,
        data,
    }) as AnyLogEntry;

const started = env(1, "call.started", {
    direction: "inbound",
    from: "+1",
    to: "+2",
    channel: "chat",
    metadata: {},
});
const msg = (seq: number, text: string) =>
    env(seq, "user.message", { id: `u${seq}`, text, final: true });
// Consecutive user finals MERGE into one bubble (Flux semantics) — a bot
// reply in between makes each user message its own line.
const bot = (seq: number, text: string) =>
    env(seq, "bot.speaking", { id: `b${seq}`, text });

describe("CallLogView — control frames vs the seq guard", () => {
    it("fires log.caught_up even though its seq repeats a delivered entry", () => {
        const view = new CallLogView();
        view.applyAll([started, msg(2, "hola")]);
        expect(view.state.caughtUp).toBe(false);

        // The marker repeats seq 2 — the last delivered — per §5.
        const changed = view.apply(env(2, "log.caught_up", { seq: 2 }));
        expect(changed).toBe(true);
        expect(view.state.caughtUp).toBe(true);
    });

    it("never stores a marker: entries() stays pure and the real seq survives", () => {
        const view = new CallLogView();
        view.applyAll([started, msg(2, "hola")]);
        view.apply(env(2, "log.caught_up", { seq: 2 }));

        // The resume payload carries only real entries.
        expect(view.entries().map((e) => e.type)).toEqual([
            "call.started",
            "user.message",
        ]);

        // LATER real entries still apply — nothing was poisoned.
        expect(view.apply(bot(3, "¡Hola!"))).toBe(true);
        expect(view.apply(msg(4, "quiero reservar"))).toBe(true);
        expect(view.state.messages.map((m) => m.text)).toEqual([
            "hola",
            "¡Hola!",
            "quiero reservar",
        ]);
    });

    it("a marker with a FRESH seq cannot swallow the future entry that owns it", () => {
        // The failure mode the routes card described: if markers were stored,
        // a marker minted at seq 3 would make the real seq-3 entry a "dup".
        const view = new CallLogView();
        view.applyAll([started, msg(2, "hola")]);
        view.apply(env(3, "log.caught_up", { seq: 2 })); // wrong-but-possible server
        expect(view.apply(bot(3, "¡Hola!"))).toBe(true); // must NOT be dropped
        expect(view.state.messages).toHaveLength(2);
    });

    it("log.gap records the hole and clears caughtUp; a second identical gap re-fires", () => {
        const view = new CallLogView();
        view.applyAll([started, msg(2, "hola")]);
        view.apply(env(2, "log.caught_up", { seq: 2 }));
        expect(view.state.caughtUp).toBe(true);

        view.apply(env(2, "log.gap", { from: 2, resume_from: 840 }));
        expect(view.state.caughtUp).toBe(false);
        expect(view.state.gaps).toEqual([{ from: 2, resumeFrom: 840 }]);

        // Reconnect story: caught_up again after the gap — same repeated seq,
        // must fire again (a stored marker would have been deduped here).
        view.apply(env(2, "log.caught_up", { seq: 2 }));
        expect(view.state.caughtUp).toBe(true);
    });

    it("notifies subscribers with fresh references on a control frame", () => {
        const view = new CallLogView();
        view.applyAll([started, msg(2, "hola")]);
        const before = view.state;
        let notified = 0;
        view.subscribe(() => notified++);
        view.apply(env(2, "log.caught_up", { seq: 2 }));
        expect(notified).toBe(1);
        expect(view.state).not.toBe(before);
        // Untouched siblings keep identity (the COW contract holds here too).
        expect(view.state.messages[0]).toBe(before.messages[0]);
    });
});

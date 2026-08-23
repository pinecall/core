/**
 * `custom` entries — `call.log(name, value)` as the reducer sees them
 * (synthesis §2c/§2d): durable → upsert by (name, id) in `state.custom`,
 * wholesale replacement; ephemeral → listeners only, never state; replay of
 * the same entries lands on the same state as watching them live.
 */

import { describe, it, expect } from "vitest";
import { CallLogView, LOG_EVENT_TYPES, isKnownLogEntry } from "../src/log/index.js";
import type { AnyLogEntry, CallLogState, CustomData, CallCustomEntry } from "../src/log/index.js";

let seq = 0;
function custom(data: CustomData, ephemeral = false): AnyLogEntry {
    seq += 1;
    return {
        seq, ts: 1786312200 + seq * 0.5, call: "CA_custom", agent: "lucia",
        type: "custom", ephemeral, data,
    };
}

function build(input: readonly AnyLogEntry[]): CallLogState {
    const view = new CallLogView();
    view.applyAll(input);
    return view.state;
}

describe("custom — vocabulary", () => {
    it("is a known type", () => {
        expect(LOG_EVENT_TYPES).toContain("custom");
        expect(isKnownLogEntry(custom({ name: "a", value: 1 }))).toBe(true);
    });

    it("starts empty", () => {
        expect(new CallLogView().state.custom).toEqual([]);
    });
});

describe("custom — durable upsert by (name, id)", () => {
    it("appends when the (name, id) is new; id defaults to the entry's seq", () => {
        seq = 0;
        const s = build([
            custom({ name: "note", value: "first" }),
            custom({ name: "note", value: "second" }),
            custom({ name: "crm.lookup", value: { tier: "gold" }, id: "c_1", turn: 2 }),
        ]);
        expect(s.custom).toEqual<CallCustomEntry[]>([
            { name: "note", id: "1", value: "first", seq: 1, ts: 1786312200.5 },
            { name: "note", id: "2", value: "second", seq: 2, ts: 1786312201 },
            { name: "crm.lookup", id: "c_1", value: { tier: "gold" }, seq: 3, ts: 1786312201.5, turn: 2 },
        ]);
    });

    it("replaces the row wholesale — value, seq, ts, turn — never merges", () => {
        seq = 0;
        const s = build([
            custom({ name: "crm.lookup", value: { tier: "silver", since: "2020" }, id: "c_1", turn: 1 }),
            custom({ name: "other", value: 0 }),
            custom({ name: "crm.lookup", value: { tier: "gold" }, id: "c_1", turn: 3 }),
        ]);
        expect(s.custom).toHaveLength(2);
        expect(s.custom[0]).toEqual({
            name: "crm.lookup", id: "c_1", value: { tier: "gold" }, seq: 3, ts: 1786312201.5, turn: 3,
        });
        // keeps first-seen order
        expect(s.custom.map((c) => c.name)).toEqual(["crm.lookup", "other"]);
    });

    it("keys on BOTH name and id — same id under another name is another row", () => {
        seq = 0;
        const s = build([
            custom({ name: "a", value: 1, id: "x" }),
            custom({ name: "b", value: 2, id: "x" }),
        ]);
        expect(s.custom.map((c) => [c.name, c.id, c.value])).toEqual([["a", "x", 1], ["b", "x", 2]]);
    });

    it("drops a turn that a later entry no longer carries (wholesale)", () => {
        seq = 0;
        const s = build([
            custom({ name: "a", value: 1, id: "x", turn: 4 }),
            custom({ name: "a", value: 2, id: "x" }),
        ]);
        expect(s.custom[0]).toEqual({ name: "a", id: "x", value: 2, seq: 2, ts: 1786312201 });
        expect("turn" in s.custom[0]!).toBe(false);
    });

    it("is order-independent: the latest SEQ wins, not the latest arrival", () => {
        seq = 0;
        const a = custom({ name: "a", value: "old", id: "x" });
        const b = custom({ name: "a", value: "new", id: "x" });
        expect(build([b, a]).custom[0]!.value).toBe("new");
        expect(build([b, a])).toEqual(build([a, b]));
    });
});

describe("custom — ephemeral", () => {
    it("never lands in state.custom, but listeners still see the apply", () => {
        seq = 0;
        const view = new CallLogView();
        let calls = 0;
        view.subscribe(() => { calls += 1; });
        expect(view.apply(custom({ name: "progress", value: 50 }, true))).toBe(true);
        expect(calls).toBe(1);
        expect(view.state.custom).toEqual([]);
        expect(view.lastSeq).toBe(1);
    });

    it("does not touch an existing durable row with the same (name, id)", () => {
        seq = 0;
        const s = build([
            custom({ name: "a", value: "kept", id: "x" }),
            custom({ name: "a", value: "live-only", id: "x" }, true),
        ]);
        expect(s.custom).toEqual([{ name: "a", id: "x", value: "kept", seq: 1, ts: 1786312200.5 }]);
    });

    it("replay (durable only) equals live (durable + ephemeral) — custom included", () => {
        seq = 0;
        const live = [
            custom({ name: "a", value: 1, id: "x" }),
            custom({ name: "p", value: 10 }, true),
            custom({ name: "a", value: 2, id: "x" }),
            custom({ name: "p", value: 20 }, true),
            custom({ name: "n", value: "free" }),
        ];
        const replay = live.filter((e) => !e.ephemeral);
        expect(build(replay).custom).toEqual(build(live).custom);
    });
});

describe("custom — structural sharing", () => {
    it("hands out a new custom array and a new row, leaving untouched rows alone", () => {
        seq = 0;
        const view = new CallLogView();
        view.applyAll([
            custom({ name: "a", value: 1, id: "x" }),
            custom({ name: "b", value: 1, id: "y" }),
        ]);
        const before = view.state;
        const [a0, b0] = before.custom;
        view.apply(custom({ name: "b", value: 2, id: "y" }));
        const after = view.state;
        expect(after).not.toBe(before);
        expect(after.custom).not.toBe(before.custom);
        expect(after.custom[0]).toBe(a0);
        expect(after.custom[1]).not.toBe(b0);
        expect(b0!.value).toBe(1);           // the held snapshot is untouched
        expect(after.custom[1]!.value).toBe(2);
    });
});

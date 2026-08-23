/**
 * `log.gap` hydration (§3; ag-ui "For Pinecall" 5 and 9).
 *
 * A gap is declared, never papered over — AND the consumer lands with the
 * consolidated state the server could still see, merged by key into what
 * it already had. The acceptance criterion of the hydrate card: a replay
 * cut by a gap whose snapshot folds the skipped prefix reaches the SAME
 * state as the full replay, for every cut.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CallLogView, snapshotOf } from "../src/log/index.js";
import type { AnyLogEntry, CallLogState, LogGapSnapshot } from "../src/log/index.js";

const GOLDEN = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/call-log-golden.json", import.meta.url)), "utf8"),
) as { call: string; agent: string; entries: AnyLogEntry[] };
const entries = GOLDEN.entries;

function build(input: readonly AnyLogEntry[]): CallLogState {
    const view = new CallLogView();
    view.applyAll(input);
    return view.state;
}

/** The gap marker the server would mint: seq = resume_from - 1, ts = when it was minted. */
function gapEntry(from: number, resumeFrom: number, snapshot: LogGapSnapshot, ts?: number): AnyLogEntry {
    return {
        seq: Math.max(from, resumeFrom - 1),
        ts: ts ?? 1786312999,
        call: GOLDEN.call,
        agent: GOLDEN.agent,
        type: "log.gap",
        ephemeral: false,
        data: { from, resume_from: resumeFrom, snapshot },
    } as AnyLogEntry;
}

/**
 * The state minus the transport signals a gapped view legitimately differs
 * in: `gaps` (it has one) and `caughtUp` (the gap clears it; the transport
 * that delivered the gap re-asserts it with its own marker).
 */
const sansGaps = ({ gaps: _g, caughtUp: _c, ...rest }: CallLogState) => rest;

/** Snapshot of the prefix `entries[0..cut)` as the server would fold it. */
function prefixSnapshot(cut: number): LogGapSnapshot {
    const started = entries.find((e) => e.type === "call.started" && e.seq <= cut);
    return snapshotOf(build(entries.slice(0, cut)), started ? started.ts : null);
}

describe("golden — a gapped replay equals the full replay", () => {
    const full = build(entries);
    const ended = entries.findIndex((e) => e.type === "call.ended") + 1; // seq 49

    // Every cut before call.ended: the prefix is lost, its snapshot lands,
    // the suffix follows. (After call.ended the cursor is sealed and the
    // server answers 204 instead of a gap — not a case the reducer sees.)
    for (let cut = 1; cut < ended; cut++) {
        it(`cut after seq ${cut}`, () => {
            const view = new CallLogView();
            view.apply(gapEntry(0, cut + 1, prefixSnapshot(cut)));
            expect(view.lastSeq).toBe(cut);
            view.applyAll(entries.slice(cut));
            expect(view.state.gaps).toEqual([{ from: 0, resumeFrom: cut + 1 }]);
            expect(sansGaps(view.state)).toEqual(sansGaps(full));
        });
    }

    it("a gap on a view that already holds a stretch merges, it does not wipe", () => {
        // The client had 1..10, lost 11..30, resumes at 31 with a snapshot of 1..30.
        const view = new CallLogView();
        view.applyAll(entries.slice(0, 10));
        const held = view.state.messages[0]!;
        view.apply(gapEntry(10, 31, prefixSnapshot(30)));
        expect(view.state.messages[0]).toEqual(held);          // same content
        expect(view.state.lastSeq).toBe(30);
        view.applyAll(entries.slice(30));
        expect(sansGaps(view.state)).toEqual(sansGaps(full));
    });

    it("re-applying the entries the snapshot was folded from is a no-op", () => {
        // The server folds the snapshot over the page it is about to SERVE
        // (it cannot see the evicted prefix), so the served entries overlap
        // the snapshot. Hydration must be keyed so that is harmless.
        const view = new CallLogView();
        view.apply(gapEntry(0, 25, prefixSnapshot(40)));
        view.applyAll(entries.slice(24));
        expect(sansGaps(view.state)).toEqual(sansGaps(full));
    });

    it("survives an out-of-order rebuild (the gap is re-stepped in place)", () => {
        const view = new CallLogView();
        view.applyAll(entries.slice(0, 5));
        view.apply(gapEntry(5, 21, prefixSnapshot(20)));
        view.applyAll(entries.slice(20));
        // A straggler from the client's own stretch arrives late → rebuild.
        expect(view.apply(entries[2]!)).toBe(false); // already there
        const late = { ...entries[5]!, seq: 5.5 } as AnyLogEntry; // synthetic, below maxSeq
        view.apply(late);
        // hydrated prefix still present after the rebuild
        expect(view.state.toolCalls.length).toBe(full.toolCalls.length);
        expect(view.state.turns.length).toBe(full.turns.length);
        expect(view.state.custom).toEqual(full.custom);
        expect(view.state.gaps).toEqual([{ from: 5, resumeFrom: 21 }]);
    });

    it("does not let the marker's wall-clock ts move the duration", () => {
        const view = new CallLogView();
        view.apply(gapEntry(0, 21, prefixSnapshot(20), 9_999_999_999));
        view.applyAll(entries.slice(20));
        expect(view.state.duration).toBeCloseTo(full.duration, 6);
    });
});

describe("hydration — merge semantics", () => {
    const env = (seq: number, type: string, data: Record<string, unknown>, ephemeral = false): AnyLogEntry =>
        ({ seq, ts: 1000 + seq, call: "CA_h", agent: "lucia", type, ephemeral, data }) as AnyLogEntry;
    const gap = (resumeFrom: number, snapshot: Record<string, unknown>, from = 0) =>
        env(Math.max(from, resumeFrom - 1), "log.gap", { from, resume_from: resumeFrom, snapshot });

    it("custom: the snapshot row replaces an OLDER local row for the same (name, id)", () => {
        const view = new CallLogView();
        view.apply(env(3, "custom", { name: "crm", value: "old", id: "c1" }));
        view.apply(gap(20, {
            custom: [{ name: "crm", id: "c1", value: "snap", seq: 12, ts: 1012, turn: 2 }],
        }, 3));
        expect(view.state.custom).toEqual([
            { name: "crm", id: "c1", value: "snap", seq: 12, ts: 1012, turn: 2 },
        ]);
    });

    it("custom: a LATER entry for the same (name, id) beats the snapshot row, whichever arrives first", () => {
        const a = new CallLogView();
        a.apply(gap(20, { custom: [{ name: "crm", id: "c1", value: "snap", seq: 12, ts: 1012 }] }));
        a.apply(env(25, "custom", { name: "crm", value: "later", id: "c1" }));
        expect(a.state.custom).toEqual([{ name: "crm", id: "c1", value: "later", seq: 25, ts: 1025 }]);

        const b = new CallLogView();
        b.apply(env(25, "custom", { name: "crm", value: "later", id: "c1" }));
        b.apply(gap(20, { custom: [{ name: "crm", id: "c1", value: "snap", seq: 12, ts: 1012 }] }));
        expect(b.state.custom).toEqual([{ name: "crm", id: "c1", value: "later", seq: 25, ts: 1025 }]);
    });

    it("custom: rows without an id key by their seq; new keys append in snapshot order", () => {
        const view = new CallLogView();
        view.apply(env(2, "custom", { name: "note", value: "mine" }));
        view.apply(gap(20, {
            custom: [
                { name: "note", value: "a", seq: 7, ts: 1007 },
                { name: "note", id: "2", value: "same-key-as-local", seq: 2, ts: 1002 },
            ],
        }, 2));
        expect(view.state.custom.map((c) => [c.name, c.id, c.value])).toEqual([
            ["note", "2", "same-key-as-local"],   // seq 2 >= seq 2 → replaced
            ["note", "7", "a"],
        ]);
    });

    it("messages: merged by seq (bot by id), sorted by seq, local-only rows survive", () => {
        const view = new CallLogView();
        view.apply(env(1, "call.started", { direction: "inbound", from: "+1", to: "+2", channel: "chat", metadata: {} }));
        view.apply(env(2, "user.message", { id: "u2", text: "hel", final: false }));  // interim, local-only
        view.apply(gap(10, {
            messages: [
                { seq: 5, role: "bot", id: "b5", text: "Hello there", speaking: false },
                { seq: 3, role: "system", text: "Using x…", toolCallId: "t3" },
            ],
            tool_calls: [{ id: "t3", name: "x", args: { q: 1 }, seq: 3, done: false }],
        }, 2));
        expect(view.state.messages.map((m) => [m.seq, m.role, m.text])).toEqual([
            [2, "user", "hel"],
            [3, "system", "Using x…"],
            [5, "bot", "Hello there"],
        ]);
        // the bot bubble is indexed: a later bot.finished finds it
        view.apply(env(11, "bot.speaking", { id: "b5", text: "Hello there!" }));
        expect(view.state.messages[2]!.text).toBe("Hello there!");
        // the open tool is indexed: its result lands on it
        view.apply(env(12, "tool.result", { id: "t3", name: "x", result: "{\"ok\":true}", ms: 9 }));
        expect(view.state.toolCalls).toEqual([
            { id: "t3", name: "x", args: { q: 1 }, seq: 3, done: true, result: { ok: true }, ms: 9 },
        ]);
        expect(view.state.messages[1]!.text).toBe("x");
    });

    it("turns: field-merged, latency mean recomputed", () => {
        const view = new CallLogView();
        view.apply(gap(10, {
            turns: [
                { turn: 1, role: "user", startedAt: 1001, endedAt: 1003, latency: { e2e: 1 } },
                { turn: 2, role: "bot", startedAt: 1004 },
            ],
        }));
        expect(view.state.metrics.turnCount).toBe(2);
        expect(view.state.metrics.e2eMean).toBe(1);
        view.apply(env(12, "turn.end", { turn: 2, latency: { e2e: 3 } }));
        expect(view.state.turns[1]).toEqual({ turn: 2, role: "bot", startedAt: 1004, endedAt: 1012, latency: { e2e: 3 } });
        expect(view.state.metrics.e2eMean).toBe(2);
    });

    it("scalars are values: present wins, absent leaves local alone; unknown keys are ignored", () => {
        const view = new CallLogView();
        view.apply(env(1, "call.started", { direction: "inbound", from: "+1", to: "+2", channel: "chat", metadata: {} }));
        view.apply(env(2, "skill.loaded", { skill: "local" }));
        view.apply(gap(30, {
            phase: "speaking", live: true, bot_speaking: true, handoff: "active",
            skills: ["remote"], sources: [{ id: 1 }], ended_reason: undefined,
            phase_of_the_moon: "waxing",
        }, 2));
        const s = view.state;
        expect(s.phase).toBe("speaking");
        expect(s.botSpeaking).toBe(true);
        expect(s.userSpeaking).toBe(false);     // absent → untouched
        expect(s.handoff).toBe("active");
        expect(s.skills).toEqual(["remote"]);
        expect(s.sources).toEqual([{ id: 1 }]);
        expect(s.endedReason).toBeUndefined();
        expect(s.lastSeq).toBe(29);
        expect(s.gaps).toEqual([{ from: 2, resumeFrom: 30 }]);
        expect(s.caughtUp).toBe(false);
    });

    it("a gap without a snapshot still declares itself and moves the cursor", () => {
        const view = new CallLogView();
        view.apply(env(9, "log.gap", { from: 0, resume_from: 10 }));
        expect(view.state.gaps).toEqual([{ from: 0, resumeFrom: 10 }]);
        expect(view.lastSeq).toBe(9);
        expect(view.state.messages).toEqual([]);
    });

    it("tolerates garbage rows (§1: ignore, never throw)", () => {
        const view = new CallLogView();
        expect(() => view.apply(gap(5, {
            messages: [null, 1, "x", { role: "bot" }, { seq: 2, role: "user", text: "ok" }],
            tool_calls: [{ name: "no-id" }],
            turns: ["nope"],
            custom: [{ id: "x" }],
            phase: "banana",
            handoff: 42,
        }))).not.toThrow();
        expect(view.state.messages).toEqual([{ seq: 2, role: "user", text: "ok" }]);
        expect(view.state.toolCalls).toEqual([]);
        expect(view.state.turns).toEqual([]);
        expect(view.state.custom).toEqual([]);
        expect(view.state.phase).toBe("idle");
        expect(view.state.handoff).toBe("none");
    });

    it("snapshotOf(state) round-trips into an equal state", () => {
        const s = build(entries.slice(0, 40));
        const view = new CallLogView();
        view.apply(gap(41, snapshotOf(s, entries[1]!.ts) as unknown as Record<string, unknown>));
        const { gaps: _a, lastSeq: _b, caughtUp: _c, duration: _d, call: _e1, agent: _e2, ...hydrated } = view.state;
        const { gaps: _e, lastSeq: _f, caughtUp: _g, duration: _h, call: _h1, agent: _h2, ...original } = s;
        expect(hydrated).toEqual(original);
    });
});

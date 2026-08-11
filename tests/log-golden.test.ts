/**
 * The golden reducer test (CALL_LOG_SPEC.md §10.5).
 *
 * "Replaying a finished call through the client reducer reproduces the same
 * final UI state as having watched it live."
 *
 * fixtures/call-log-golden.json is a CROSS-REPO artifact: sdk-server and
 * @pinecall/web assert against these exact bytes. Do not regenerate it to
 * make a test pass — if the reducer and the fixture disagree, one of them is
 * wrong about the spec and that is the finding.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CallLogView } from "../src/log/index.js";
import type { AnyLogEntry, CallLogState } from "../src/log/index.js";

const GOLDEN = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/call-log-golden.json", import.meta.url)), "utf8"),
) as { call: string; agent: string; entries: AnyLogEntry[] };

const entries = GOLDEN.entries;

/** Deterministic shuffle — a flaky golden test is worse than no golden test. */
function shuffle<T>(items: readonly T[], seed = 1337): T[] {
    const out = [...items];
    let s = seed;
    const rnd = () => {
        s = (s * 1103515245 + 12345) % 2147483648;
        return s / 2147483648;
    };
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
}

function build(input: readonly AnyLogEntry[]): CallLogState {
    const view = new CallLogView();
    view.applyAll(input);
    return view.state;
}

describe("golden fixture", () => {
    it("is the shape the spec describes", () => {
        expect(entries.length).toBe(45);
        for (const e of entries) {
            expect(Object.keys(e).sort()).toEqual(
                ["agent", "call", "data", "ephemeral", "seq", "ts", "type"],
            );
        }
        // seq is monotonic and contiguous at write time (§1).
        expect(entries.map((e) => e.seq)).toEqual(
            entries.map((_, i) => i + 1),
        );
        // call.summary is ALWAYS the last entry (§2).
        expect(entries[entries.length - 1]!.type).toBe("call.summary");
        // It exercises every behavior this card is accepted against.
        const types = new Set(entries.map((e) => e.type));
        for (const t of [
            "tool.call", "tool.result", "bot.corrected", "bot.interrupted",
            "turn.end", "call.summary", "log.caught_up",
        ]) expect(types).toContain(t);
    });
});

describe("CallLogView — the one reducer", () => {
    const inOrder = build(entries);

    it("reduces the call to the state the spec implies", () => {
        expect(inOrder.phase).toBe("ended");
        expect(inOrder.live).toBe(false);
        expect(inOrder.lastSeq).toBe(45);
        expect(inOrder.call).toBe("CA_golden");
        expect(inOrder.agent).toBe("lucia");
        expect(inOrder.endedReason).toBe("caller_hangup");
        expect(inOrder.caughtUp).toBe(true);
        expect(inOrder.gaps).toEqual([]);
    });

    it("derives duration from entry ts, never wall clock", () => {
        const first = entries.find((e) => e.type === "call.started")!;
        const last = entries[entries.length - 1]!;
        expect(inOrder.duration).toBeCloseTo(last.ts - first.ts, 6);
    });

    it("merges the interim + multi-final user turn into ONE bubble", () => {
        const users = inOrder.messages.filter((m) => m.role === "user");
        // three user turns in the fixture, not one bubble per transcript event
        expect(users.length).toBe(3);
        expect(users[0]!.text).toBe("Hi, I need to check my order status. Order A-1187.");
        expect(users[0]!.interim).toBe(false);
    });

    it("reassembles bot words and drops the phantom empty bubble", () => {
        const bots = inOrder.messages.filter((m) => m.role === "bot");
        expect(bots.some((m) => m.id === "b0")).toBe(false); // straight to tool call
        const b1 = bots.find((m) => m.id === "b1")!;
        expect(b1.text).toBe("Your order A-1187 has shipped.");
        expect(b1.speaking).toBe(false);
    });

    it("applies bot.corrected by REPLACING the superseded text", () => {
        const b2 = inOrder.messages.find((m) => m.id === "b2")!;
        expect(b2.seq).toBe(30);
        expect(b2.text).toBe("It arrives on Thursday.");
        expect(b2.corrected).toBe(true);
        expect(b2.interrupted).toBe(true);
        // and does NOT append a second bubble
        expect(inOrder.messages.filter((m) => m.id === "b2")).toHaveLength(1);
    });

    it("correlates the tool pair and parses string args and results", () => {
        expect(inOrder.toolCalls).toHaveLength(2);
        const [t1, t2] = inOrder.toolCalls;
        expect(t1!.name).toBe("lookup_order");
        expect(t1!.args).toEqual({ order_id: "A-1187" });   // was a JSON string
        expect(t1!.result).toEqual({ status: "shipped", eta: "Tuesday" });
        expect(t1!.ms).toBe(412);
        expect(t1!.done).toBe(true);
        expect(t2!.args).toEqual({ order_id: "A-1187", reason: "customer_request" });
        expect(t2!.error).toBe("order_already_shipped");
    });

    it("exposes every tool call — no trackedTools filter", () => {
        expect(inOrder.toolCalls.map((t) => t.name)).toEqual(["lookup_order", "cancel_order"]);
    });

    it("keeps per-turn latency first-class", () => {
        expect(inOrder.turns).toHaveLength(4);
        expect(inOrder.turns.map((t) => t.turn)).toEqual([1, 2, 3, 4]);
        expect(inOrder.turns[0]!.role).toBe("user");
        expect(inOrder.turns[0]!.latency!.e2e).toBe(0.83);
        expect(inOrder.metrics.turnCount).toBe(4);
        expect(inOrder.metrics.e2eMean).toBeCloseTo((0.83 + 1.11 + 0.75 + 1.24) / 4, 6);
    });

    it("rolls up call.summary", () => {
        expect(inOrder.metrics.summary!.e2e.n).toBe(4);
        expect(inOrder.metrics.cost).toBe(0.0412);
        expect(inOrder.metrics.recordingUrl).toContain("CA_golden.mp3");
    });

    it("surfaces the disconnect as an INTENT, never a transport call", () => {
        expect(inOrder.intents).toEqual([
            { kind: "disconnect", reason: "caller_hangup", seq: 44 },
        ]);
    });

    it("tracks handoff and skill lifecycles", () => {
        expect(inOrder.handoff).toBe("none");  // requested → active → released
        expect(inOrder.skills).toEqual([]);    // loaded → unloaded
        expect(inOrder.sources).toHaveLength(1);
    });

    // ── The three-way equivalence: the acceptance criterion ──

    it("is identical applied SHUFFLED and DUPLICATED (idempotent by seq)", () => {
        const noisy = shuffle([...entries, ...entries.slice(10, 30), ...entries]);
        expect(build(noisy)).toEqual(inOrder);
    });

    it("is identical applied in two halves (resume equivalence)", () => {
        const cut = 23;
        const view = new CallLogView();
        view.applyAll(entries.slice(0, cut));
        // Socket drops here. The client reconnects with ?after=lastSeq and the
        // server replays from there — with the customary overlap.
        expect(view.lastSeq).toBe(entries[cut - 1]!.seq);
        const resumed = entries.filter((e) => e.seq > view.lastSeq - 3);
        view.applyAll(resumed);
        expect(view.state).toEqual(inOrder);
    });

    it("is identical when the two halves arrive on two views and are merged", () => {
        const a = new CallLogView();
        a.applyAll(entries.slice(0, 23));
        const b = new CallLogView();
        b.applyAll(entries.slice(23));
        const merged = new CallLogView();
        merged.applyAll(b.entries());   // tail first, on purpose
        merged.applyAll(a.entries());
        expect(merged.state).toEqual(inOrder);
    });

    it("loses nothing and duplicates nothing across a kill-and-reattach (§10.3)", () => {
        const view = new CallLogView();
        let applied = 0;
        for (const e of entries.slice(0, 20)) if (view.apply(e)) applied++;
        const cursor = view.lastSeq;
        for (const e of entries) {
            if (e.seq <= cursor) continue;      // what `after=` would omit
            if (view.apply(e)) applied++;
        }
        expect(applied).toBe(entries.length);
        expect(view.entries().map((e) => e.seq)).toEqual(entries.map((e) => e.seq));
    });
});

describe("forward compatibility (§1)", () => {
    it("ignores unknown types instead of rejecting them", () => {
        const view = new CallLogView();
        view.applyAll(entries);
        const before = view.state;
        expect(view.apply({
            seq: 999, ts: 1786312999, call: "CA_golden", agent: "lucia",
            type: "quantum.entangled", ephemeral: false, data: {},
        } as unknown as AnyLogEntry)).toBe(false);
        expect(view.state).toBe(before);
    });

    it("ignores malformed envelopes", () => {
        const view = new CallLogView();
        expect(view.apply({ type: "call.started" } as unknown as AnyLogEntry)).toBe(false);
        expect(view.state.lastSeq).toBe(0);
    });
});

describe("gap declaration (§3)", () => {
    it("records a declared gap and clears caught-up — never papers over it", () => {
        const view = new CallLogView();
        view.applyAll(entries.slice(0, 20));
        view.apply({
            seq: 21, ts: 1786312250, call: "CA_golden", agent: "lucia",
            type: "log.gap", ephemeral: false,
            data: { from: 21, resume_from: 840, snapshot: { phase: "speaking" } },
        } as AnyLogEntry);
        expect(view.state.gaps).toEqual([{ from: 21, resumeFrom: 840 }]);
        expect(view.state.caughtUp).toBe(false);
    });
});

/**
 * The transcript store and the CallsModel — the state the web console reads
 * and the terminal live view paints, driven by the same event sequences.
 *
 * These are assertions about the SNAPSHOT (`GET /api/calls`), the other half
 * of tests/live-view.test.ts, which asserts what the same sequences look like
 * on screen. They share one reducer, so if the two ever disagree, one of these
 * two files fails.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTranscriptStore, type CallSnapshot } from "../src/cli/console/transcript-reducer.js";
import { createCallsModel } from "../src/cli/console/calls-model.js";

// ── Fakes ────────────────────────────────────────────────────────────────

class FakeAgent {
    #handlers = new Map<string, Set<(...a: any[]) => void>>();
    hungUp: string[] = [];
    constructor(public id: string) {}
    on(event: string, handler: (...a: any[]) => void) {
        if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
        this.#handlers.get(event)!.add(handler);
        return this;
    }
    off(event: string, handler: (...a: any[]) => void) {
        this.#handlers.get(event)?.delete(handler);
        return this;
    }
    emit(event: string, ...args: any[]) {
        for (const h of [...(this.#handlers.get(event) ?? [])]) h(...args);
    }
    listenerCount(event: string) { return this.#handlers.get(event)?.size ?? 0; }
    call(callId: string) { return { hangup: () => { this.hungUp.push(callId); } }; }
}

function call(id = "call_abc123", transport = "phone", extra: Record<string, unknown> = {}) {
    return { id, from: "+14155550177", to: "+15550001111", direction: "inbound", transport, duration: 0, ...extra };
}

let now = 1_000_000;
const clock = () => now;
const tick = (ms: number) => { now += ms; };

function store(settleMs = 300) {
    return createTranscriptStore({ clock, settleMs });
}

const said = (c: CallSnapshot) => c.lines.map((l) => [l.who, l.text]);

beforeEach(() => { now = 1_000_000; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

// ── Voice ────────────────────────────────────────────────────────────────

describe("transcript store — a voice call", () => {
    it("keeps interims in the draft and only finals in the transcript", () => {
        const s = store();
        const a = new FakeAgent("pines");
        s.attach(a as any);
        const c = call();

        a.emit("call.started", c);
        const snapshot = s.get(c.id)!;
        expect(snapshot).toMatchObject({
            id: c.id, agent: "pines", channel: "phone", direction: "inbound",
            peer: "+14155550177", state: "listening", lines: [],
        });

        a.emit("speech.started", { turnId: 1 }, c);
        a.emit("user.speaking", { text: "Hey" }, c);
        expect(snapshot.draft.caller).toBe("Hey");
        a.emit("user.speaking", { text: "Hey I'd like a table" }, c);
        expect(snapshot.draft.caller).toBe("Hey I'd like a table");
        expect(snapshot.lines).toHaveLength(0);

        a.emit("user.message", { text: "Hey, I'd like a table for two." }, c);
        expect(snapshot.draft.caller).toBeUndefined();
        expect(said(snapshot)).toEqual([["caller", "Hey, I'd like a table for two."]]);

        a.emit("turn.end", { turnId: 1 }, c);
        expect(snapshot.state).toBe("thinking");
    });

    it("grows the agent line word by word — what was HEARD, not what was announced", () => {
        const s = store();
        const a = new FakeAgent("pines");
        s.attach(a as any);
        const c = call();
        a.emit("call.started", c);
        const snapshot = s.get(c.id)!;

        a.emit("bot.speaking", { messageId: "m1", text: "Of course! How many guests?" }, c);
        expect(snapshot.state).toBe("speaking");
        expect(snapshot.draft.agent).toBe(""); // announced, not yet spoken
        expect(snapshot.lines).toHaveLength(0);

        for (const w of ["Of", "course!", "How"]) a.emit("bot.word", { word: w }, c);
        expect(snapshot.draft.agent).toBe("Of course! How");
        expect(snapshot.lines).toHaveLength(0);

        a.emit("bot.finished", { messageId: "m1" }, c);
        expect(said(snapshot)).toEqual([["agent", "Of course! How"]]);
        expect(snapshot.draft.agent).toBeUndefined();
        expect(snapshot.state).toBe("listening");
    });

    it("marks an interrupted reply as cut", () => {
        const s = store();
        const a = new FakeAgent("pines");
        s.attach(a as any);
        const c = call();
        a.emit("call.started", c);
        a.emit("bot.speaking", { text: "Sure, let me check that for you" }, c);
        a.emit("bot.word", { word: "Sure," }, c);
        a.emit("bot.word", { word: "let" }, c);
        a.emit("bot.interrupted", {}, c);

        const snapshot = s.get(c.id)!;
        expect(snapshot.lines[0]).toMatchObject({ who: "agent", text: "Sure, let", cut: true, final: true });
        expect(snapshot.state).toBe("listening");
    });

    it("records a tool call and pairs its result with it", () => {
        const s = store();
        const a = new FakeAgent("pines");
        s.attach(a as any);
        const c = call();
        a.emit("call.started", c);

        a.emit("llm.toolCall", { toolCalls: [{ name: "checkAvailability", arguments: '{"partySize":2}' }] }, c);
        const snapshot = s.get(c.id)!;
        expect(snapshot.state).toBe("thinking");
        expect(snapshot.lines[0]).toMatchObject({
            who: "tool", text: "checkAvailability", final: false,
            tool: { name: "checkAvailability", args: { partySize: 2 } },
        });

        s.toolResult("pines", c, { available: true, table: "window" });
        expect(snapshot.lines[0]).toMatchObject({
            final: true, tool: { name: "checkAvailability", result: { available: true, table: "window" } },
        });
    });

    it("closes with a duration and a reason, and stays in the list", () => {
        const s = store();
        const a = new FakeAgent("pines");
        s.attach(a as any);
        const c = call();
        a.emit("call.started", c);
        tick(12_300);
        a.emit("call.ended", { ...c, duration: 12.3 }, "hangup");

        expect(s.live.size).toBe(0);
        const snapshot = s.get(c.id)!;
        expect(snapshot).toMatchObject({ state: "ended", durationS: 12.3, reason: "hangup" });
        expect(snapshot.endedAt).toBe(now);
    });

    it("falls back to the wall clock when the server sends no duration", () => {
        const s = store();
        const a = new FakeAgent("pines");
        s.attach(a as any);
        const c = call();
        a.emit("call.started", c);
        tick(4_500);
        a.emit("call.ended", { ...c, duration: 0 }, "completed");
        expect(s.get(c.id)!.durationS).toBe(4.5);
    });
});

// ── Chat ─────────────────────────────────────────────────────────────────

describe("transcript store — a chat session", () => {
    it("opens an implicit session for a client that never announced itself", () => {
        const s = store();
        const a = new FakeAgent("pines");
        s.attach(a as any);

        a.emit("user.message", { text: "hello?" }, undefined);
        const snapshot = [...s.live.values()][0]!;
        expect(snapshot.id).toBe("pines:implicit");
        expect(snapshot.channel).toBe("unknown");
        expect(said(snapshot)).toEqual([["caller", "hello?"]]);
        expect(snapshot.state).toBe("thinking");
    });

    it("coalesces streamed chunks and fixes the line once they settle", () => {
        const s = store(300);
        const a = new FakeAgent("pines");
        s.attach(a as any);
        const c = call("chat_1", "chat");
        a.emit("chat.started", c);
        const snapshot = s.get(c.id)!;

        a.emit("bot.speaking", { text: "Hi" }, c);
        a.emit("bot.speaking", { text: "Hi there" }, c);   // cumulative
        a.emit("bot.speaking", { text: "!" }, c);          // delta
        expect(snapshot.draft.agent).toBe("Hi there!");
        expect(snapshot.lines).toHaveLength(0);

        vi.advanceTimersByTime(300);
        expect(said(snapshot)).toEqual([["agent", "Hi there!"]]);
        expect(snapshot.state).toBe("listening");
    });

    it("does not print a reply the server re-sends after it was fixed", () => {
        const s = store(300);
        const a = new FakeAgent("pines");
        s.attach(a as any);
        const c = call("chat_1", "chat");
        a.emit("chat.started", c);
        a.emit("bot.speaking", { text: "All set." }, c);
        vi.advanceTimersByTime(300);
        a.emit("bot.speaking", { text: "All set." }, c); // echo
        vi.advanceTimersByTime(300);

        expect(said(s.get(c.id)!)).toEqual([["agent", "All set."]]);
    });
});

// ── The model ────────────────────────────────────────────────────────────

describe("CallsModel", () => {
    it("lists live calls before ended ones, newest first, capped", () => {
        const s = store();
        const a = new FakeAgent("pines");
        s.attach(a as any);
        const model = createCallsModel({ store: s, agents: new Map([["pines", a as any]]), limit: 3 });

        for (let i = 0; i < 4; i++) {
            const c = call(`old_${i}`);
            a.emit("call.started", c);
            tick(1000);
            a.emit("call.ended", c, "hangup");
        }
        const liveCall = call("live_1");
        a.emit("call.started", liveCall);

        const list = model.list();
        expect(list).toHaveLength(3);
        expect(list[0]!.id).toBe("live_1");
        expect(list.slice(1).map((c) => c.id)).toEqual(["old_3", "old_2"]);
    });

    it("hangs up through the agent that owns the call, and refuses an ended one", () => {
        const s = store();
        const a = new FakeAgent("pines");
        s.attach(a as any);
        const model = createCallsModel({ store: s, agents: new Map([["pines", a as any]]) });
        const c = call();

        expect(model.hangup(c.id)).toBe(false); // not started yet
        a.emit("call.started", c);
        expect(model.hangup(c.id)).toBe(true);
        expect(a.hungUp).toEqual([c.id]);

        a.emit("call.ended", c, "hangup");
        expect(model.hangup(c.id)).toBe(false);
    });

    it("detaching releases every listener the store took", () => {
        const s = store();
        const a = new FakeAgent("pines");
        const release = s.attach(a as any);
        expect(a.listenerCount("user.message")).toBe(1);
        release();
        expect(a.listenerCount("user.message")).toBe(0);
    });
});

/**
 * The `pinecall run` live view — the renderer behind src/runner.ts.
 *
 * Driven with a fake agent emitter and a fake stream; a tiny terminal
 * simulator turns the raw bytes (with `\r` + erase-line redraws) into the
 * frame a human would see, so the assertions are about what is ON SCREEN:
 * interims replaced (not stacked), the bot's line grown word by word and
 * printed once, the turn state on the last line, and — off a TTY — one plain
 * line per final event with no escape codes at all.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createLiveView, summarize } from "../src/cli/live-view.js";

// ── Fakes ────────────────────────────────────────────────────────────────

class FakeAgent {
    #handlers = new Map<string, Set<(...a: any[]) => void>>();
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
        for (const h of this.#handlers.get(event) ?? []) h(...args);
    }
    listenerCount(event: string) {
        return this.#handlers.get(event)?.size ?? 0;
    }
}

class FakeStream {
    chunks: string[] = [];
    columns = 120;
    write(chunk: string) {
        this.chunks.push(chunk);
        return true;
    }
    get raw() {
        return this.chunks.join("");
    }
}

const SGR = /\x1b\[[0-9;]*m/g;

/** Simulate a terminal: `\r` returns to column 0, ESC[2K erases the line, `\n` commits it. Colours are dropped. */
function screen(raw: string): string[] {
    const lines: string[] = [];
    let cur = "";
    const s = raw.replace(SGR, "");
    for (let i = 0; i < s.length; i++) {
        const ch = s[i]!;
        if (ch === "\r") { cur = ""; continue; }
        if (ch === "\n") { lines.push(cur); cur = ""; continue; }
        if (ch === "\x1b" && s.slice(i, i + 4) === "\x1b[2K") { cur = ""; i += 3; continue; }
        cur += ch;
    }
    lines.push(cur);
    return lines;
}

function call(id = "call_abc123", transport = "phone", extra: Record<string, unknown> = {}) {
    return { id, from: "+14155550177", to: "+15550001111", direction: "inbound", transport, duration: 0, ...extra };
}

function voiceView(opts: Partial<Parameters<typeof createLiveView>[0]> = {}) {
    const out = new FakeStream();
    let now = 1_000_000;
    const clock = () => now;
    const tick = (ms: number) => { now += ms; };
    const view = createLiveView({ out, tty: true, color: true, clock, ...opts });
    const agent = new FakeAgent("pines");
    view.attach(agent);
    return { out, view, agent, tick };
}

/** The reference sequence: one caller turn, one bot reply, hang up. */
function playCall(agent: FakeAgent, tick: (ms: number) => void, c = call()) {
    agent.emit("call.started", c);
    tick(1200);
    agent.emit("speech.started", { callId: c.id, turnId: 1 }, c);
    agent.emit("user.speaking", { text: "Hey" }, c);
    tick(300);
    agent.emit("user.speaking", { text: "Hey I'd like" }, c);
    tick(300);
    agent.emit("user.speaking", { text: "Hey I'd like a table" }, c);
    tick(200);
    agent.emit("user.message", { text: "Hey, I'd like a table for two." }, c);
    agent.emit("turn.end", { turnId: 1 }, c);
    tick(800);
    agent.emit("bot.speaking", { messageId: "m1", text: "Of course! How many guests?" }, c);
    for (const w of ["Of", "course!", "How", "many", "guests?"]) {
        tick(150);
        agent.emit("bot.word", { messageId: "m1", word: w }, c);
    }
    agent.emit("bot.finished", { messageId: "m1", durationMs: 750 }, c);
    tick(500);
    agent.emit("call.ended", { ...c, duration: 12.3 }, "hangup");
}

// ── TTY ──────────────────────────────────────────────────────────────────

describe("live view — TTY", () => {
    it("replaces interims, grows the bot line word by word, and prints each line once", () => {
        const { out, agent, tick } = voiceView();
        playCall(agent, tick);
        const frame = screen(out.raw);

        const callerLines = frame.filter((l) => l.includes("caller ›"));
        expect(callerLines).toHaveLength(1);
        expect(callerLines[0]).toContain("caller › Hey, I'd like a table for two.");
        // no interim survived on screen
        expect(frame.some((l) => /caller › Hey I'd like( a table)?\s*·/.test(l))).toBe(false);

        const agentLines = frame.filter((l) => l.includes("pines  ›"));
        expect(agentLines).toHaveLength(1);
        expect(agentLines[0]).toContain("pines  › Of course! How many guests?");
        expect(agentLines[0]).not.toContain("⏏");

        expect(frame.some((l) => l.includes("incoming call — +14155550177 · phone"))).toBe(true);
        expect(frame.some((l) => l.includes("call ended — hangup (12s)"))).toBe(true);
        // nothing live remains after the call
        expect(frame[frame.length - 1]).toBe("");
    });

    it("shows the turn state on the last line and walks listening → thinking → speaking → listening", () => {
        const { out, agent, tick } = voiceView();
        const c = call();
        agent.emit("call.started", c);
        expect(screen(out.raw).at(-1)).toMatch(/● listening t\+0\.0s/);

        tick(1000);
        agent.emit("user.speaking", { text: "Hey there" }, c);
        expect(screen(out.raw).at(-1)).toMatch(/caller › Hey there · ● listening t\+1\.0s/);

        agent.emit("user.message", { text: "Hey there." }, c);
        agent.emit("eager.turn", {}, c);
        expect(screen(out.raw).at(-1)).toMatch(/● thinking/);

        agent.emit("turn.continued", {}, c);
        expect(screen(out.raw).at(-1)).toMatch(/● listening/);

        agent.emit("turn.end", {}, c);
        agent.emit("bot.speaking", { messageId: "m1", text: "Hi! Welcome." }, c);
        // text announced up front is NOT shown until words play
        expect(screen(out.raw).at(-1)).toMatch(/pines  › · ● speaking/);
        agent.emit("bot.word", { messageId: "m1", word: "Hi!" }, c);
        expect(screen(out.raw).at(-1)).toMatch(/pines  › Hi! · ● speaking/);
        agent.emit("bot.word", { messageId: "m1", word: "Welcome." }, c);
        expect(screen(out.raw).at(-1)).toMatch(/pines  › Hi! Welcome\. · ● speaking/);

        agent.emit("bot.finished", { messageId: "m1" }, c);
        const frame = screen(out.raw);
        expect(frame.at(-1)).toMatch(/● listening/);
        expect(frame.filter((l) => l.includes("pines  › Hi! Welcome."))).toHaveLength(1);
    });

    it("only ever redraws the last line — every redraw is preceded by \\r + erase-line, never a cursor-up", () => {
        const { out, agent, tick } = voiceView();
        playCall(agent, tick);
        expect(out.raw).not.toMatch(/\x1b\[\d*A/); // no cursor-up
        // every erase is an erase of the CURRENT line
        const erases = out.raw.match(/\x1b\[2K/g) ?? [];
        expect(erases.length).toBeGreaterThan(3);
        expect(out.raw.match(/\r\x1b\[2K/g)?.length).toBe(erases.length);
    });

    it("marks an interrupted bot line as cut", () => {
        const { out, agent } = voiceView();
        const c = call();
        agent.emit("call.started", c);
        agent.emit("bot.speaking", { messageId: "m1", text: "Let me check that for you right now" }, c);
        for (const w of ["Let", "me", "check"]) agent.emit("bot.word", { messageId: "m1", word: w }, c);
        agent.emit("bot.interrupted", { messageId: "m1", playedMs: 900, wordsSpoken: 3, reason: "user_spoke" }, c);
        const frame = screen(out.raw);
        const line = frame.find((l) => l.includes("pines  › Let me check"));
        expect(line).toBeDefined();
        expect(line).toContain("⏏");
        expect(line).not.toContain("for you right now");
    });

    it("falls back to the announced text when bot.finished arrives with no words", () => {
        const { out, agent } = voiceView();
        const c = call("c2", "webrtc");
        agent.emit("call.started", c);
        agent.emit("bot.speaking", { messageId: "m1", text: "Goodbye!" }, c);
        agent.emit("bot.finished", { messageId: "m1" }, c);
        expect(screen(out.raw).filter((l) => l.includes("pines  › Goodbye!"))).toHaveLength(1);
    });

    it("prints tool calls and results inline, in order", () => {
        const { out, view, agent } = voiceView();
        const c = call();
        agent.emit("call.started", c);
        agent.emit("llm.toolCall", {
            callId: c.id, msgId: "x",
            toolCalls: [{ id: "t1", name: "checkAvailability", arguments: JSON.stringify({ date: "2026-06-13", partySize: 2 }) }],
        }, c);
        view.toolResult(agent, c, { available: true, table: "window" });
        const frame = screen(out.raw);
        const i = frame.findIndex((l) => l.includes('⚡ checkAvailability(date: "2026-06-13", partySize: 2)'));
        const j = frame.findIndex((l) => l.includes("✓") && l.includes("available: true"));
        expect(i).toBeGreaterThan(-1);
        expect(j).toBeGreaterThan(i);
    });

    it("shows a chat agent's bot.speaking chunks as one growing line", () => {
        const { out, agent } = voiceView();
        const c = call("chat-1", "chat", { from: "chat", direction: "inbound" });
        agent.emit("call.started", c);
        agent.emit("user.message", { text: "hola" }, c);
        expect(screen(out.raw).at(-1)).toMatch(/● thinking/);
        agent.emit("bot.speaking", { messageId: "m1", text: "¡Hola! " }, c);
        agent.emit("bot.speaking", { messageId: "m1", text: "¿En qué " }, c);
        agent.emit("bot.speaking", { messageId: "m1", text: "puedo ayudarte?" }, c);
        expect(screen(out.raw).at(-1)).toMatch(/pines  › ¡Hola! ¿En qué puedo ayudarte\? · ● speaking/);
        agent.emit("call.ended", c, "chat_completed");
        const frame = screen(out.raw);
        expect(frame.filter((l) => l.includes("pines  › ¡Hola! ¿En qué puedo ayudarte?"))).toHaveLength(1);
        expect(frame.some((l) => l.includes("incoming chat — chat · chat"))).toBe(true);
        expect(frame.some((l) => l.includes("caller › hola"))).toBe(true);
    });

    it("honours NO_COLOR (color:false) — no SGR sequences, redraws still work", () => {
        const { out, agent, tick } = voiceView({ color: false });
        playCall(agent, tick);
        expect(out.raw).not.toMatch(SGR);
        expect(out.raw).toContain("\r\x1b[2K");
        expect(screen(out.raw).some((l) => l.includes("pines  › Of course! How many guests?"))).toBe(true);
    });

    it("prefixes lines with the agent id when more than one agent is attached", () => {
        const out = new FakeStream();
        const view = createLiveView({ out, tty: true, color: false, clock: () => 0 });
        const a = new FakeAgent("pines");
        const b = new FakeAgent("nova");
        view.attach(a);
        view.attach(b);
        const ca = call("c-a");
        const cb = call("c-b", "webrtc", { from: "browser" });
        a.emit("call.started", ca);
        b.emit("call.started", cb);
        a.emit("user.message", { text: "one" }, ca);
        b.emit("user.message", { text: "two" }, cb);
        const frame = screen(out.raw);
        expect(frame.some((l) => /\[pines\] \[c-a\] caller › one/.test(l))).toBe(true);
        expect(frame.some((l) => /\[nova\] \[c-b\] caller › two/.test(l))).toBe(true);
    });

    it("keeps the banner/print lines above the live line", () => {
        const { out, view, agent } = voiceView();
        const c = call();
        agent.emit("call.started", c);
        agent.emit("user.speaking", { text: "hello" }, c);
        view.print("  notice");
        const frame = screen(out.raw);
        expect(frame.at(-2)).toBe("  notice");
        expect(frame.at(-1)).toMatch(/caller › hello/);
    });

    it("detach unsubscribes every handler", () => {
        const { view, agent } = voiceView();
        expect(agent.listenerCount("bot.word")).toBe(1);
        view.detach(agent);
        expect(agent.listenerCount("bot.word")).toBe(0);
        expect(agent.listenerCount("call.started")).toBe(0);
    });
});

// ── non-TTY ──────────────────────────────────────────────────────────────

describe("live view — non-TTY", () => {
    it("prints one plain line per final event, timestamped, without escapes", () => {
        const out = new FakeStream();
        let now = 0;
        const view = createLiveView({ out, tty: false, color: false, clock: () => now });
        const agent = new FakeAgent("pines");
        view.attach(agent);
        playCall(agent, (ms) => { now += ms; });

        expect(out.raw).not.toContain("\r");
        expect(out.raw).not.toContain("\x1b");
        const lines = out.raw.split("\n").filter((l) => l.trim() !== "");
        expect(lines).toEqual([
            expect.stringMatching(/^ {2}t\+0\.0s +☎ {2}incoming call — \+14155550177 · phone$/),
            expect.stringMatching(/^ {2}t\+2\.0s +caller › Hey, I'd like a table for two\.$/),
            expect.stringMatching(/^ {2}t\+3\.[56]s +pines {2}› Of course! How many guests\?$/),
            expect.stringMatching(/^ {2}t\+4\.[01]s +☎ {2}call ended — hangup \(12s\)$/),
        ]);
    });

    it("never prints interims or turn state off a TTY", () => {
        const out = new FakeStream();
        const view = createLiveView({ out, tty: false, color: false, clock: () => 0 });
        const agent = new FakeAgent("pines");
        view.attach(agent);
        const c = call();
        agent.emit("call.started", c);
        agent.emit("user.speaking", { text: "partial" }, c);
        agent.emit("eager.turn", {}, c);
        agent.emit("bot.speaking", { messageId: "m1", text: "x" }, c);
        agent.emit("bot.word", { messageId: "m1", word: "x" }, c);
        expect(out.raw).not.toContain("partial");
        expect(out.raw).not.toContain("thinking");
        expect(out.raw).not.toContain("speaking");
        expect(out.raw).not.toContain("pines  › x");
    });

    it("--events prints every event name with a payload summary", () => {
        const out = new FakeStream();
        const view = createLiveView({ out, tty: false, color: false, events: true, clock: () => 0 });
        const agent = new FakeAgent("pines");
        view.attach(agent);
        const c = call();
        agent.emit("call.started", c);
        agent.emit("user.speaking", { event: "user.speaking", callId: c.id, text: "partial", confidence: 0.8 }, c);
        agent.emit("bot.word", { event: "bot.word", callId: c.id, messageId: "m1", word: "hi", wordIndex: 0 }, c);
        const raw = out.raw;
        expect(raw).toMatch(/· call\.started \{id:"call_abc123",from:"\+14155550177".*transport:"phone"\}/);
        expect(raw).toMatch(/· user\.speaking \{text:"partial",confidence:0\.8\}/);
        expect(raw).toMatch(/· bot\.word \{messageId:"m1",word:"hi",wordIndex:0\}/);
        expect(raw).not.toContain("\x1b");
    });
});

// ── Sessions nobody announced (pinecall chat, MCP chat tool, llm.chat) ─────

describe("live view — chat sessions without call.started", () => {
    afterEach(() => vi.useRealTimers());

    /** The exact sequence seen in the pty repro: no call.started, no chat.started, messageId "". */
    function playMcpChat(agent: FakeAgent, view: ReturnType<typeof createLiveView>) {
        agent.emit("user.message", { event: "user.message", callId: "chat-x", messageId: "", text: "Hello, anything free on Monday?", confidence: 1, turnId: 0 }, undefined);
        agent.emit("llm.toolCall", { callId: "chat-x", msgId: "", toolCalls: [{ id: "1", name: "checkAvailability", arguments: '{"date":"2026-08-24"}' }] }, undefined);
        view.toolResult(agent, undefined, { date: "2026-08-24", slots: ["10:00", "11:30"] });
        agent.emit("bot.speaking", { event: "bot.speaking", callId: "chat-x", messageId: "", text: "Yes — Monday has availability at 10:00 and 11:30." }, undefined);
    }

    it("TTY: renders caller › and agent › around the tool lines, once each, after the reply settles", () => {
        vi.useFakeTimers();
        const out = new FakeStream();
        const view = createLiveView({ out, tty: true, color: false, clock: () => 0 });
        const agent = new FakeAgent("pines");
        view.attach(agent);
        playMcpChat(agent, view);
        // before the settle the reply is live (last line), not yet fixed
        expect(screen(out.raw).at(-1)).toMatch(/pines {2}› Yes — Monday has availability at 10:00 and 11:30\. · ● speaking/);
        vi.advanceTimersByTime(300);
        const frame = screen(out.raw);
        const i = frame.findIndex((l) => l.includes("caller › Hello, anything free on Monday?"));
        const j = frame.findIndex((l) => l.includes('⚡ checkAvailability(date: "2026-08-24")'));
        const k = frame.findIndex((l) => l.includes("✓") && l.includes("slots"));
        const m = frame.findIndex((l) => l.includes("pines  › Yes — Monday has availability at 10:00 and 11:30."));
        expect([i, j, k, m].every((n) => n > -1)).toBe(true);
        expect(i < j && j < k && k < m).toBe(true);
        expect(frame.filter((l) => l.includes("caller ›"))).toHaveLength(1);
        expect(frame.filter((l) => l.includes("pines  ›"))).toHaveLength(1);
        expect(frame.some((l) => l.includes("☎  session — chat"))).toBe(true);
        expect(frame.at(-1)).toMatch(/● listening/);
    });

    it("non-TTY: one plain line each, in order, no escapes", () => {
        vi.useFakeTimers();
        const out = new FakeStream();
        const view = createLiveView({ out, tty: false, color: false, clock: () => 0 });
        const agent = new FakeAgent("pines");
        view.attach(agent);
        playMcpChat(agent, view);
        vi.advanceTimersByTime(300);
        expect(out.raw).not.toContain("\x1b");
        expect(out.raw).not.toContain("\r");
        const lines = out.raw.split("\n").filter((l) => l.trim());
        expect(lines.map((l) => l.trim())).toEqual([
            "t+0.0s   ☎  session — chat · unknown",
            "t+0.0s   caller › Hello, anything free on Monday?",
            't+0.0s           ⚡ checkAvailability(date: "2026-08-24")',
            't+0.0s           ✓ date: "2026-08-24", slots: ["10:00", "11:30"]',
            "t+0.0s   pines  › Yes — Monday has availability at 10:00 and 11:30.",
        ]);
    });

    it("coalesces streamed chunks — deltas or growing text — into ONE agent line", () => {
        vi.useFakeTimers();
        const out = new FakeStream();
        const view = createLiveView({ out, tty: false, color: false, clock: () => 0 });
        const agent = new FakeAgent("pines");
        view.attach(agent);
        // deltas
        for (const t of ["Yes, ", "Monday ", "works."]) {
            agent.emit("bot.speaking", { messageId: "", text: t }, undefined);
            vi.advanceTimersByTime(100); // each chunk re-arms the settle
        }
        vi.advanceTimersByTime(300);
        // growing text
        for (const t of ["And", "And Tuesday", "And Tuesday too."]) {
            agent.emit("bot.speaking", { messageId: "", text: t }, undefined);
            vi.advanceTimersByTime(100);
        }
        vi.advanceTimersByTime(300);
        const lines = out.raw.split("\n").filter((l) => l.includes("pines  ›")).map((l) => l.trim());
        expect(lines).toEqual([
            "t+0.0s   pines  › Yes, Monday works.",
            "t+0.0s   pines  › And Tuesday too.",
        ]);
    });

    it("the next user.message fixes a pending reply immediately", () => {
        vi.useFakeTimers();
        const out = new FakeStream();
        const view = createLiveView({ out, tty: false, color: false, clock: () => 0 });
        const agent = new FakeAgent("pines");
        view.attach(agent);
        agent.emit("bot.speaking", { messageId: "", text: "Hi there." }, undefined);
        agent.emit("user.message", { messageId: "", text: "hello" }, undefined);
        const lines = out.raw.split("\n").filter((l) => l.trim()).map((l) => l.trim());
        expect(lines.indexOf("t+0.0s   pines  › Hi there.")).toBeLessThan(lines.indexOf("t+0.0s   caller › hello"));
    });

    it("an unannounced session that turns out to be voice shows what was heard, not the announced text", () => {
        vi.useFakeTimers();
        const out = new FakeStream();
        const view = createLiveView({ out, tty: true, color: false, clock: () => 0 });
        const agent = new FakeAgent("pines");
        view.attach(agent);
        const c = { id: "call_unknown", transport: "unknown" };
        agent.emit("bot.speaking", { messageId: "m1", text: "Hello there, how can I help?" }, c);
        vi.advanceTimersByTime(100);
        for (const w of ["Hello", "there,"]) agent.emit("bot.word", { messageId: "m1", word: w }, c);
        vi.advanceTimersByTime(1000); // settle must NOT fire once words arrived
        expect(screen(out.raw).at(-1)).toMatch(/pines {2}› Hello there, · ● speaking/);
        agent.emit("bot.interrupted", { messageId: "m1" }, c);
        const frame = screen(out.raw);
        expect(frame.filter((l) => l.includes("pines  ›"))).toHaveLength(1);
        expect(frame.find((l) => l.includes("pines  ›"))).toContain("Hello there, ⏏");
        expect(frame.some((l) => l.includes("how can I help"))).toBe(false);
    });

    it("does not print a re-sent or cumulative reply twice (agentic tool loop)", () => {
        vi.useFakeTimers();
        const out = new FakeStream();
        const view = createLiveView({ out, tty: false, color: false, clock: () => 0 });
        const agent = new FakeAgent("pines");
        view.attach(agent);
        const c = call("chat-9", "chat", { from: "chat" });
        agent.emit("chat.started", c);
        agent.emit("user.message", { text: "book it" }, c);
        agent.emit("bot.speaking", { messageId: "", text: "Checking the slot." }, c);
        vi.advanceTimersByTime(400); // tool round trip — the first reply settles
        agent.emit("bot.speaking", { messageId: "", text: "Checking the slot.\nBooked for 10:00." }, c);
        vi.advanceTimersByTime(400);
        agent.emit("bot.speaking", { messageId: "", text: "Checking the slot." }, c); // re-sent
        vi.advanceTimersByTime(400);
        const lines = out.raw.split("\n").filter((l) => l.includes("pines  ›")).map((l) => l.trim());
        expect(lines).toEqual([
            "t+0.0s   pines  › Checking the slot.",
            "t+0.0s   pines  › Booked for 10:00.",
        ]);
        // a NEW turn may legitimately repeat the text
        agent.emit("user.message", { text: "again" }, c);
        agent.emit("bot.speaking", { messageId: "", text: "Checking the slot." }, c);
        vi.advanceTimersByTime(400);
        expect(out.raw.split("\n").filter((l) => l.includes("pines  › Checking the slot."))).toHaveLength(2);
    });

    it("continues a multi-line reply under the label", () => {
        vi.useFakeTimers();
        const out = new FakeStream();
        const view = createLiveView({ out, tty: true, color: false, clock: () => 0 });
        const agent = new FakeAgent("pines");
        view.attach(agent);
        agent.emit("bot.speaking", { messageId: "", text: "Line one.\nLine two." }, undefined);
        vi.advanceTimersByTime(300);
        const frame = screen(out.raw);
        const i = frame.findIndex((l) => l === "  pines  › Line one.");
        expect(i).toBeGreaterThan(-1);
        expect(frame[i + 1]).toBe("           Line two.");
    });

    it("chat.started opens the context like call.started (transport chat)", () => {
        vi.useFakeTimers();
        const out = new FakeStream();
        const view = createLiveView({ out, tty: false, color: false, clock: () => 0 });
        const agent = new FakeAgent("pines");
        view.attach(agent);
        const c = call("chat-9", "chat", { from: "chat" });
        agent.emit("chat.started", c);
        agent.emit("user.message", { text: "hola" }, c);
        agent.emit("bot.speaking", { messageId: "", text: "¡Hola!" }, c);
        vi.advanceTimersByTime(300);
        const lines = out.raw.split("\n").filter((l) => l.trim()).map((l) => l.trim());
        expect(lines).toEqual([
            "t+0.0s   ☎  incoming chat — chat · chat",
            "t+0.0s   caller › hola",
            "t+0.0s   pines  › ¡Hola!",
        ]);
        expect(lines.filter((l) => l.includes("session —"))).toHaveLength(0);
    });
});

describe("summarize", () => {
    it("drops event/callId, compacts keys, caps the length", () => {
        expect(summarize("user.message", [{ event: "user.message", callId: "c", text: "hi", turnId: 3 }, {}]))
            .toBe('{text:"hi",turnId:3}');
        const long = summarize("bot.speaking", [{ text: "x".repeat(500) }]);
        expect(long.length).toBeLessThanOrEqual(110);
        expect(long.endsWith("…")).toBe(true);
        expect(summarize("call.ended", [{ id: "c1", transport: "chat" }, "hangup"])).toContain('reason:"hangup"');
    });
});

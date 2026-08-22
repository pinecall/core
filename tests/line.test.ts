/**
 * Phone lines — `pc.line()`, the LineCall verbs, and the dispatch that feeds
 * them.
 *
 * The whole point of a line is that it needs no model and no deployed agent to
 * answer, so every test here drives the SERVER by hand over a FakeTransport:
 * what goes out on the socket, and what the promises do when the answer comes
 * back. Contract: docs/notes/phone-line-plan.md §11.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const holder = vi.hoisted(() => ({ transport: null as any }));

vi.mock("../src/transport/websocket.js", async () => {
    const { FakeTransport } = await import("../src/transport/fake.js");
    return {
        WebSocketTransport: class extends FakeTransport {
            constructor(_opts?: unknown) {
                super();
                holder.transport = this;
            }
        },
    };
});

import { Pinecall } from "../src/client.js";
import { Call } from "../src/domain/call.js";
import { LineCall } from "../src/domain/line.js";
import type { PhoneLine, ListenResult } from "../src/domain/line.js";

const NUMBER = "+12186633772";
const LINE_ID = `line:${NUMBER}`;

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A connected client whose server side we drive by hand. */
async function connectedClient() {
    const pc = new Pinecall({ apiKey: "pk_test", apiUrl: "ws://localhost:1337", autoReconnect: false });
    await flush();
    const t = holder.transport;
    t.receive({ event: "connected", org_id: "org_test" });
    await pc.ready;
    return { pc, t };
}

/** A live line with one inbound call in the handler's hands. */
async function liveCall(opts: { extension?: string | null } = {}) {
    const { pc, t } = await connectedClient();
    const line = pc.line(NUMBER, { voice: "elevenlabs/sarah" });
    t.receive({ event: "line.created", number: NUMBER });
    await line.ready;

    const calls: LineCall[] = [];
    line.on("call", (call) => { calls.push(call); });

    t.receive({
        event: "call.started",
        agent_id: LINE_ID,
        call_id: "CA_1",
        from: "+15551234567",
        to: NUMBER,
        direction: "inbound",
        transport: "phone",
        extension: opts.extension ?? null,
        owner: "line",
    });
    await flush();
    return { pc, t, line, call: calls[0] };
}

/** The last frame of a given kind that the client put on the socket. */
function lastSent(t: any, event: string): Record<string, unknown> | undefined {
    return [...t.sentMessages].reverse().find((m: any) => m.event === event);
}

beforeEach(() => {
    holder.transport = null;
});

// Fake timers and `flush()` (a real setTimeout) do not mix: a test that dies
// under fake timers used to hang every test after it.
afterEach(() => {
    vi.useRealTimers();
});

// ─── Registration ────────────────────────────────────────────────────────

describe("pc.line() — registration", () => {
    it("sends line.create with the line's own pipeline and the extension window", async () => {
        const { pc, t } = await connectedClient();
        pc.line(NUMBER, { stt: "soniox", voice: "elevenlabs/sarah", language: "en" });

        const frame = lastSent(t, "line.create") as any;
        expect(frame).toBeDefined();
        expect(frame.number).toBe(NUMBER);
        expect(frame.config).toMatchObject({
            stt: "soniox",
            voice: "elevenlabs/sarah",
            language: "en",
            extension_window_ms: 2500,
        });
        // A line has no model — nothing model-shaped may ride the wire.
        expect(frame.config.llm).toBeUndefined();
        expect(frame.config.prompt).toBeUndefined();
        expect(lastSent(t, "agent.create")).toBeUndefined();
    });

    it("honours an explicit extension window, including 0", async () => {
        const { pc, t } = await connectedClient();
        pc.line(NUMBER, { extension: { window: 0 } });
        expect((lastSent(t, "line.create") as any).config.extension_window_ms).toBe(0);
    });

    it("registers under line:<number> so existing dispatch routes to it", async () => {
        const { pc, t } = await connectedClient();
        const line = pc.line(NUMBER);
        expect(line.id).toBe(LINE_ID);
        expect(pc.lines.get(NUMBER)).toBe(line);
        // Not an agent, and not in the agent registry.
        expect(pc.agents.size).toBe(0);

        expect(line.registered).toBe(false);
        t.receive({ event: "line.created", number: NUMBER });
        await line.ready;
        expect(line.registered).toBe(true);
    });

    it("is idempotent per number", async () => {
        const { pc } = await connectedClient();
        expect(pc.line(NUMBER)).toBe(pc.line(NUMBER));
    });

    it("emits ready on line.created and error (with the code) on line.error", async () => {
        const { pc, t } = await connectedClient();
        const line = pc.line(NUMBER);

        const errors: any[] = [];
        line.on("error", (err) => errors.push(err));
        t.receive({ event: "line.error", number: NUMBER, code: "LINE_CONFLICT", error: "held elsewhere" });
        expect(errors).toHaveLength(1);
        expect(errors[0].code).toBe("LINE_CONFLICT");
        expect(errors[0].message).toBe("held elsewhere");

        let ready = false;
        line.on("ready", () => { ready = true; });
        t.receive({ event: "line.created", number: NUMBER });
        expect(ready).toBe(true);
    });

    it("refuses llm / prompt / tools / greeting synchronously", async () => {
        const { pc } = await connectedClient();
        for (const key of ["llm", "prompt", "tools", "greeting"]) {
            expect(() => pc.line(NUMBER, { [key]: "anything" } as any)).toThrow(/has no model/);
        }
    });
});

// ─── The call ────────────────────────────────────────────────────────────

describe("the call a line hands out", () => {
    it("is a LineCall (and still a Call) carrying the dialled extension", async () => {
        const { call } = await liveCall({ extension: "33" });
        expect(call).toBeInstanceOf(LineCall);
        expect(call).toBeInstanceOf(Call);
        expect(call.extension).toBe("33");
        expect(call.transport).toBe("phone");
        expect(call.from).toBe("+15551234567");
    });

    it("has a null extension when the caller dialled none", async () => {
        const { call } = await liveCall();
        expect(call.extension).toBeNull();
    });

    it("records both sides in `transcript`", async () => {
        const { t, call } = await liveCall();
        void call.say("What can I do for you?");
        t.receive({ event: "user.message", agent_id: LINE_ID, call_id: "CA_1", message_id: "m1", text: "Sales, please", turn_id: 1, confidence: 0.9 });

        expect(call.transcript.map((e) => [e.who, e.text])).toEqual([
            ["line", "What can I do for you?"],
            ["caller", "Sales, please"],
        ]);
        // The entries still read as a plain Call transcript would.
        expect(call.transcript[1]).toMatchObject({ role: "user", content: "Sales, please" });
    });
});

// ─── say ─────────────────────────────────────────────────────────────────

describe("say()", () => {
    it("resolves on bot.finished for its own message_id", async () => {
        const { t, call } = await liveCall();
        const promise = call.say("Hello.");
        const messageId = (lastSent(t, "bot.reply") as any).message_id;

        t.receive({ event: "bot.finished", agent_id: LINE_ID, call_id: "CA_1", message_id: messageId });
        expect(await promise).toEqual({ interrupted: false });
    });

    it("resolves interrupted on bot.interrupted", async () => {
        const { t, call } = await liveCall();
        const promise = call.say("A long menu nobody waits for.");
        const messageId = (lastSent(t, "bot.reply") as any).message_id;

        t.receive({ event: "bot.interrupted", agent_id: LINE_ID, call_id: "CA_1", message_id: messageId });
        expect(await promise).toEqual({ interrupted: true });
    });

    it("resolves interrupted when the call ends mid-sentence", async () => {
        const { t, call } = await liveCall();
        const promise = call.say("Hold on…");
        t.receive({ event: "call.ended", agent_id: LINE_ID, call_id: "CA_1", reason: "hangup" });
        expect(await promise).toEqual({ interrupted: true });
    });

    it("reconfigures the session before speaking when given a voice/language", async () => {
        const { t, call } = await liveCall();
        void call.say("Un momento.", { language: "es", voice: "elevenlabs/marta" });

        const frames = t.sentMessages.map((m: any) => m.event);
        expect(frames.indexOf("session.configure")).toBeLessThan(frames.lastIndexOf("bot.reply"));
        expect(lastSent(t, "session.configure")).toMatchObject({ language: "es", voice: "elevenlabs/marta" });
    });

    it("stays safe un-awaited on a plain Call — no unhandled rejection", async () => {
        const send = vi.fn();
        const call = new Call({ call_id: "CA_x", from: "", to: "", direction: "inbound" }, send);
        const rejections: unknown[] = [];
        const onRejection = (err: unknown) => rejections.push(err);
        process.on("unhandledRejection", onRejection);

        call.say("Fire and forget.");           // deliberately not awaited
        call._applyEnd("hangup");
        await flush();
        process.off("unhandledRejection", onRejection);

        expect(rejections).toEqual([]);
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ event: "bot.reply", text: "Fire and forget." }));
    });
});

// ─── listen ──────────────────────────────────────────────────────────────

describe("listen()", () => {
    const press = (t: any, digit: string, digits: string) =>
        t.receive({ event: "call.dtmf_received", agent_id: LINE_ID, call_id: "CA_1", digit, digits });

    it("resolves on the first press when digits is 1", async () => {
        const { t, call } = await liveCall();
        const promise = call.listen({ digits: 1, timeout: 5000 });
        press(t, "2", "2");
        expect(await promise).toEqual({ by: "keypad", digit: "2", digits: "2" });
    });

    it("collects until the requested count", async () => {
        const { t, call } = await liveCall();
        const promise = call.listen({ digits: 3, timeout: 5000 });
        press(t, "2", "2");
        press(t, "0", "20");
        press(t, "4", "204");
        expect(await promise).toEqual({ by: "keypad", digit: "4", digits: "204" });
    });

    it("resolves on the terminator, whatever the buffer holds", async () => {
        const { t, call } = await liveCall();
        const promise = call.listen({ terminator: "#", timeout: 5000 });
        press(t, "9", "9");
        press(t, "#", "9#");
        expect(await promise).toEqual({ by: "keypad", digit: "#", digits: "9" });
    });

    it("races speech when speech: true", async () => {
        const { t, call } = await liveCall();
        const promise = call.listen({ digits: 1, speech: true, timeout: 5000 });
        t.receive({ event: "user.message", agent_id: LINE_ID, call_id: "CA_1", message_id: "m1", text: "español", turn_id: 1, confidence: 0.93 });
        t.receive({ event: "turn.end", agent_id: LINE_ID, call_id: "CA_1", turn_id: 1, text: "español" });

        expect(await promise).toEqual({ by: "speech", text: "español", confidence: 0.93 });
    });

    it("ignores speech when it was not asked for", async () => {
        const { t, call } = await liveCall();
        vi.useFakeTimers();
        const promise = call.listen({ digits: 1, timeout: 5000 });
        t.receive({ event: "turn.end", agent_id: LINE_ID, call_id: "CA_1", turn_id: 1, text: "hello?" });
        await vi.advanceTimersByTimeAsync(5000);
        expect(await promise).toEqual({ by: "timeout" });
    });

    it("times out, and removes every listener when it resolves", async () => {
        const { call } = await liveCall();
        vi.useFakeTimers();
        const before = {
            dtmf: call.listenerCount("call.dtmf_received"),
            turn: call.listenerCount("turn.end"),
            ended: call.listenerCount("ended"),
        };
        const promise = call.listen({ digits: 1, speech: true, timeout: 3000 });
        expect(call.listenerCount("call.dtmf_received")).toBe(before.dtmf + 1);

        await vi.advanceTimersByTimeAsync(3000);
        expect(await promise).toEqual({ by: "timeout" });

        expect(call.listenerCount("call.dtmf_received")).toBe(before.dtmf);
        expect(call.listenerCount("turn.end")).toBe(before.turn);
        expect(call.listenerCount("ended")).toBe(before.ended);
    });
});

// ─── ask ─────────────────────────────────────────────────────────────────

describe("ask()", () => {
    it("counts a press made DURING the say — barge-in on a menu is the normal case", async () => {
        const { t, call } = await liveCall();
        const promise = call.ask("Press one for sales.", { digits: 1, timeout: 5000 });
        await flush();
        const messageId = (lastSent(t, "bot.reply") as any).message_id;

        // The caller knows the menu and presses over it.
        t.receive({ event: "call.dtmf_received", agent_id: LINE_ID, call_id: "CA_1", digit: "1", digits: "1" });
        t.receive({ event: "bot.interrupted", agent_id: LINE_ID, call_id: "CA_1", message_id: messageId });

        expect(await promise).toEqual({ by: "keypad", digit: "1", digits: "1" });
    });

    it("starts the timeout only once the line stopped speaking", async () => {
        const { t, call } = await liveCall();
        vi.useFakeTimers();
        const promise = call.ask("A very long menu.", { digits: 1, timeout: 2000 });
        let settled: ListenResult | null = null;
        void promise.then((r) => { settled = r; });
        await vi.advanceTimersByTimeAsync(0);
        const messageId = (lastSent(t, "bot.reply") as any).message_id;

        // Still speaking well past the listen budget — nothing times out.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(settled).toBeNull();

        t.receive({ event: "bot.finished", agent_id: LINE_ID, call_id: "CA_1", message_id: messageId });
        await vi.advanceTimersByTimeAsync(2000);
        expect(await promise).toEqual({ by: "timeout" });
    });
});

// ─── routeTo ─────────────────────────────────────────────────────────────

describe("routeTo()", () => {
    it("sends call.route and resolves ok on call.routed", async () => {
        const { t, line, call } = await liveCall();
        const ended: Array<[string, string]> = [];
        line.on("call.ended", (c, reason) => ended.push([c.id, reason]));

        const promise = call.routeTo("pres-hoteles", { language: "es", voice: "elevenlabs/marta" });
        expect(lastSent(t, "call.route")).toMatchObject({
            call_id: "CA_1",
            agent: "pres-hoteles",
            language: "es",
            voice: "elevenlabs/marta",
            history: true,
        });

        t.receive({ event: "call.routed", agent_id: LINE_ID, call_id: "CA_1", agent: "pres-hoteles" });
        expect(await promise).toEqual({ ok: true });
        expect(call.routed).toBe(true);
        expect(call.status).toBe("ended");

        // One call.ended on the line, when the server's arrives.
        expect(ended).toEqual([]);
        t.receive({ event: "call.ended", agent_id: LINE_ID, call_id: "CA_1", reason: "routed" });
        expect(ended).toEqual([["CA_1", "routed"]]);
    });

    it("resolves the failure and leaves the line owning the call", async () => {
        const { t, call } = await liveCall();
        const promise = call.routeTo("pres-hoteles");
        t.receive({ event: "call.route_failed", agent_id: LINE_ID, call_id: "CA_1", agent: "pres-hoteles", reason: "offline" });

        expect(await promise).toEqual({ ok: false, reason: "offline" });
        expect(call.routed).toBe(false);
        expect(call.status).toBe("active");
    });

    it("sends history: false when the app opts out", async () => {
        const { t, call } = await liveCall();
        void call.routeTo("ventas", { history: false, context: { reason: "billing" } });
        expect(lastSent(t, "call.route")).toMatchObject({ history: false, context: { reason: "billing" } });
    });
});

// ─── extensions() ────────────────────────────────────────────────────────

describe("extensions()", () => {
    async function lineWithTable(table: Record<string, any>, extension: string | null) {
        const { pc, t } = await connectedClient();
        const line = pc.line(NUMBER);
        t.receive({ event: "line.created", number: NUMBER });
        await line.ready;
        line.extensions(table);

        const fellThrough: LineCall[] = [];
        line.on("call", (c) => fellThrough.push(c));

        t.receive({
            event: "call.started", agent_id: LINE_ID, call_id: "CA_1",
            from: "+1555", to: NUMBER, direction: "inbound", transport: "phone",
            extension, owner: "line",
        });
        await flush();
        return { t, line, fellThrough };
    }

    it("routes a string entry straight to that agent", async () => {
        const { t, fellThrough } = await lineWithTable({ "11": "pres-hoteles" }, "11");
        expect(lastSent(t, "call.route")).toMatchObject({ agent: "pres-hoteles" });
        expect(fellThrough).toHaveLength(0);
    });

    it("runs a function entry with the call", async () => {
        const seen: LineCall[] = [];
        const { fellThrough } = await lineWithTable({ "20": async (call: LineCall) => { seen.push(call); } }, "20");
        expect(seen).toHaveLength(1);
        expect(seen[0].extension).toBe("20");
        expect(fellThrough).toHaveLength(0);
    });

    it('"*" catches the no-extension and unmatched cases', async () => {
        const hits: string[] = [];
        const star = async (call: LineCall) => { hits.push(String(call.extension)); };
        await lineWithTable({ "10": "a", "*": star }, null);
        await lineWithTable({ "10": "a", "*": star }, "99");
        expect(hits).toEqual(["null", "99"]);
    });

    it("falls through to on(\"call\") with no match and no \"*\"", async () => {
        const { t, fellThrough } = await lineWithTable({ "10": "a" }, "99");
        expect(fellThrough).toHaveLength(1);
        expect(lastSent(t, "call.route")).toBeUndefined();
    });
});

// ─── The agent on the other side ─────────────────────────────────────────

describe("the agent a line routed to", () => {
    it("reads routedFrom, extension and lineTranscript off its Call", async () => {
        const { pc, t } = await connectedClient();
        const agent = pc.agent("pres-hoteles", {});
        t.receive({ event: "agent.created", agent_id: "pres-hoteles" });
        await agent.ready;

        const calls: Call[] = [];
        agent.on("call.started", (call) => calls.push(call));
        t.receive({
            event: "call.started", agent_id: "pres-hoteles", call_id: "CA_1",
            from: "+1555", to: NUMBER, direction: "inbound", transport: "phone",
            extension: "11", owner: "agent", routed_from: LINE_ID,
            line_transcript: [
                { who: "line", text: "Press one for sales.", at: 1 },
                { who: "caller", text: "one", at: 2 },
            ],
        });

        const call = calls[0];
        expect(call.routedFrom).toBe(LINE_ID);
        expect(call.extension).toBe("11");
        expect(call.lineTranscript).toEqual([
            { who: "line", text: "Press one for sales.", at: 1, role: "assistant", content: "Press one for sales." },
            { who: "caller", text: "one", at: 2, role: "user", content: "one" },
        ]);
    });

    it("has an empty lineTranscript and null routedFrom on a normal call", async () => {
        const { pc, t } = await connectedClient();
        const agent = pc.agent("solo", {});
        t.receive({ event: "agent.created", agent_id: "solo" });
        await agent.ready;

        const calls: Call[] = [];
        agent.on("call.started", (call) => calls.push(call));
        t.receive({ event: "call.started", agent_id: "solo", call_id: "CA_2", from: "+1555", to: NUMBER, direction: "inbound", transport: "phone" });

        expect(calls[0].routedFrom).toBeNull();
        expect(calls[0].extension).toBeNull();
        expect(calls[0].lineTranscript).toEqual([]);
    });
});

// ─── Reconnect ───────────────────────────────────────────────────────────

describe("reconnect", () => {
    it("re-sends line.create so the number is not stranded", async () => {
        const { pc, t } = await connectedClient();
        const line: PhoneLine = pc.line(NUMBER);
        t.receive({ event: "line.created", number: NUMBER });
        await line.ready;
        expect(line.registered).toBe(true);

        t.simulateClose("network");
        expect(line.registered).toBe(false);

        // The reconnect re-runs the same path a cold start does.
        await t.open();
        t.receive({ event: "connected", org_id: "org_test" });
        expect(t.sentMessages.filter((m: any) => m.event === "line.create")).toHaveLength(2);
    });
});

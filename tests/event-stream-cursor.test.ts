/**
 * EventStream cursor resume (CALL_LOG_SPEC.md §5, §10.3).
 *
 * "reconnect = same URL with the last seen seq" and "zero lost, zero
 * duplicated". The public API stays backward compatible: a stream that never
 * sees a `seq` behaves exactly as it did before, and the FIRST connect URL is
 * unchanged so a server that knows nothing about cursors is unaffected.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEventStream, type EventStreamStatus } from "../src/stream/event-stream.js";

// ── A deterministic fake socket ──────────────────────────────────────────

class FakeSocket {
    static readonly OPEN = 1;
    static instances: FakeSocket[] = [];

    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    sent: string[] = [];

    constructor(public url: string) {
        FakeSocket.instances.push(this);
    }
    send(data: string): void { this.sent.push(data); }
    close(): void { this.readyState = 3; }

    open(): void { this.readyState = 1; this.onopen?.(); }
    deliver(msg: unknown): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
    drop(): void { this.readyState = 3; this.onclose?.(); }
}

function entry(seq: number, type = "user.message"): Record<string, unknown> {
    return {
        seq, ts: 1786312200 + seq, call: "CA_x", agent: "lucia",
        type, ephemeral: false, data: { id: `m${seq}`, text: `t${seq}`, final: true },
    };
}

/** Let the constructor's async resolveURL() settle. */
const settle = () => Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());

beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

async function connected(opts: Parameters<typeof createEventStream>[0]) {
    const stream = createEventStream(opts);
    await settle();
    FakeSocket.instances[0]!.open();
    return stream;
}

/** Drop the live socket and let the backoff timer fire the reconnect. */
async function reconnect(): Promise<FakeSocket> {
    const n = FakeSocket.instances.length;
    FakeSocket.instances[n - 1]!.drop();
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    const sock = FakeSocket.instances[n]!;
    sock.open();
    return sock;
}

describe("EventStream — first connect is unchanged", () => {
    it("sends no after= on the initial connect (direct URL mode)", async () => {
        await connected({ url: "ws://localhost:3000/ws/events" });
        expect(FakeSocket.instances[0]!.url).toBe("ws://localhost:3000/ws/events");
    });

    it("sends no after= on the initial connect (token mode)", async () => {
        await connected({
            agent: "lucia",
            sessionId: "s1",
            tokenProvider: async () => ({ token: "tk", server: "https://voice.pinecall.io" }),
        });
        expect(FakeSocket.instances[0]!.url).toBe(
            "wss://voice.pinecall.io/ws/stream?token=tk&agent=lucia&session=s1",
        );
    });

    it("honors an explicitly persisted cursor on the first connect", async () => {
        await connected({ url: "ws://localhost:3000/ws/events", after: 42 });
        expect(FakeSocket.instances[0]!.url).toBe("ws://localhost:3000/ws/events?after=42");
    });
});

describe("EventStream — resume on RECONNECT", () => {
    it("requests after=lastSeq and delivers no duplicates", async () => {
        const seen: number[] = [];
        const stream = await connected({ url: "ws://host/ws?x=1" });
        stream.on("*", (m) => seen.push(m.seq as number));

        const a = FakeSocket.instances[0]!;
        for (const s of [1, 2, 3, 4, 5]) a.deliver(entry(s));
        expect(stream.lastSeq).toBe(5);

        const b = await reconnect();
        expect(b.url).toBe("ws://host/ws?x=1&after=5");

        // The server replays with the customary overlap; the gate drops it.
        for (const s of [3, 4, 5, 6, 7]) b.deliver(entry(s));

        expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(stream.lastSeq).toBe(7);
    });

    it("picks the right separator when the URL has no query", async () => {
        const stream = await connected({ url: "ws://host/ws" });
        FakeSocket.instances[0]!.deliver(entry(9));
        const b = await reconnect();
        expect(b.url).toBe("ws://host/ws?after=9");
        void stream;
    });

    it("noResume:true keeps the legacy behavior exactly", async () => {
        const seen: number[] = [];
        const stream = await connected({ url: "ws://host/ws", noResume: true });
        stream.on("*", (m) => seen.push(m.seq as number));
        const a = FakeSocket.instances[0]!;
        a.deliver(entry(1)); a.deliver(entry(2));
        const b = await reconnect();
        expect(b.url).toBe("ws://host/ws");
        b.deliver(entry(1));                       // duplicate is NOT filtered
        expect(seen).toEqual([1, 2, 1]);
        expect(stream.lastSeq).toBe(0);
    });
});

describe("EventStream — backward compatibility", () => {
    it("legacy frames without seq flow through untouched", async () => {
        const got: Record<string, unknown>[] = [];
        const stream = await connected({ url: "ws://host/ws" });
        stream.on("bot.word", (m) => got.push(m));
        const a = FakeSocket.instances[0]!;
        a.deliver({ event: "bot.word", word: "hi" });
        a.deliver({ event: "bot.word", word: "there" });
        expect(got).toHaveLength(2);
        expect(stream.lastSeq).toBe(0);
        // and a seq-less stream still does not ask for a cursor
        const b = await reconnect();
        expect(b.url).toBe("ws://host/ws");
    });

    it("dispatches Call Log envelopes by `type` as well as legacy `event`", async () => {
        const got: string[] = [];
        const stream = await connected({ url: "ws://host/ws" });
        stream.on("user.message", () => got.push("log"));
        stream.on("bot.word", () => got.push("legacy"));
        const a = FakeSocket.instances[0]!;
        a.deliver(entry(1));
        a.deliver({ event: "bot.word", word: "x" });
        expect(got).toEqual(["log", "legacy"]);
    });
});

describe("EventStream — log.caught_up and log.gap are first-class", () => {
    it("surfaces both as statuses and as events", async () => {
        const statuses: EventStreamStatus[] = [];
        const events: string[] = [];
        const stream = await connected({ url: "ws://host/ws" });
        stream.onStatus((s) => statuses.push(s));
        stream.on("log.caught_up", () => events.push("caught_up"));
        stream.on("log.gap", () => events.push("gap"));

        const a = FakeSocket.instances[0]!;
        a.deliver({ ...entry(1), type: "log.caught_up", data: { seq: 1 } });
        a.deliver({ ...entry(2), type: "log.gap", data: { from: 2, resume_from: 840 } });

        expect(statuses).toEqual(["caught_up", "connected", "gap", "connected"]);
        expect(events).toEqual(["caught_up", "gap"]);
    });
});

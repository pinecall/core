/**
 * `pc.observe()` — the Node reader of the Call Log.
 *
 * Everything here runs against a FAKE fetch that yields SSE bytes, so the
 * transport is exercised for real (decoder, cursor, watchdog, backoff,
 * terminators) with no server in the loop.
 *
 * The load-bearing assertion is the golden one: bytes on the wire →
 * `observe()` → `state` must equal `new CallLogView().applyAll(entries).state`,
 * the exact equality the browser twin asserts against the same fixture.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { observe, sseDecoder, observeBackoffDelay } from "../src/observe.js";
import type { ObserveFetch, ObserveResponseLike } from "../src/observe.js";
import { CallLogView } from "../src/log/index.js";
import type { AnyLogEntry } from "../src/log/index.js";

const GOLDEN = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/call-log-golden.json", import.meta.url)), "utf8"),
) as { call: string; agent: string; entries: AnyLogEntry[] };

const entries = GOLDEN.entries;

const TOKEN = "tok_observe";

// ── SSE plumbing for the fake server ─────────────────────────────────────

const enc = new TextEncoder();

/** The server's frame shape: `id:` = seq, `event:` = type, `data:` = envelope. */
function frame(e: AnyLogEntry): string {
    return `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
}

function bodyOf(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(c) {
            c.enqueue(enc.encode(text));
            c.close();
        },
    });
}

/** A body the test drives by hand. */
function pushable() {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
        start(c) {
            ctrl = c;
        },
    });
    return {
        stream,
        push(text: string) {
            ctrl.enqueue(enc.encode(text));
        },
        end() {
            try {
                ctrl.close();
            } catch {
                /* already closed */
            }
        },
    };
}

function ok(body: ReadableStream<Uint8Array>): ObserveResponseLike {
    return { ok: true, status: 200, text: async () => "", body };
}

/** A fetch that records every URL it was called with. */
function recordingFetch(
    respond: (n: number, url: string) => ObserveResponseLike | Promise<ObserveResponseLike>,
) {
    const urls: string[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const impl: ObserveFetch = async (url, init) => {
        urls.push(url);
        signals.push(init?.signal);
        return respond(urls.length - 1, url);
    };
    return { impl, urls, signals };
}

const wholeCall = entries.map(frame).join("");

/** What the reducer alone makes of the fixture — the thing to match. */
function goldenState() {
    const v = new CallLogView();
    v.applyAll(entries);
    return v.state;
}

// ── The decoder ──────────────────────────────────────────────────────────

describe("sseDecoder", () => {
    it("splits on \\n, \\r\\n and a lone \\r, and joins multi-line data", () => {
        const events: { id?: string; event: string; data: string }[] = [];
        const d = sseDecoder({ onEvent: (e) => events.push(e) });
        d.push(enc.encode("event: a\ndata: one\ndata: two\n\n"));
        d.push(enc.encode("event: b\r\ndata: x\r\n\r\n"));
        d.push(enc.encode("event: c\rdata: y\r\r"));
        d.end(); // a lone trailing \r is held back until the body ends
        expect(events).toEqual([
            { id: undefined, event: "a", data: "one\ntwo" },
            { id: undefined, event: "b", data: "x" },
            { id: undefined, event: "c", data: "y" },
        ]);
    });

    it("keeps `id:` sticky across events and drops comments to onComment", () => {
        const events: { id?: string }[] = [];
        const comments: string[] = [];
        const d = sseDecoder({
            onEvent: (e) => events.push(e),
            onComment: (t) => comments.push(t),
        });
        d.push(enc.encode(": ping 1\nid: 7\ndata: {}\n\ndata: {}\n\n"));
        expect(comments).toEqual(["ping 1"]);
        expect(events.map((e) => e.id)).toEqual(["7", "7"]);
        expect(d.lastId).toBe("7");
    });

    it("survives a \\r\\n split across two chunks", () => {
        const events: { data: string }[] = [];
        const d = sseDecoder({ onEvent: (e) => events.push(e) });
        d.push(enc.encode("data: hi\r"));
        d.push(enc.encode("\n\r\n"));
        expect(events).toEqual([{ id: undefined, event: "", data: "hi" }]);
    });

    it("flushes a trailing event that never got its blank line", () => {
        const events: { data: string }[] = [];
        const d = sseDecoder({ onEvent: (e) => events.push(e) });
        d.push(enc.encode("data: last\n"));
        d.end();
        expect(events).toEqual([{ id: undefined, event: "", data: "last" }]);
    });
});

describe("backoff", () => {
    it("is min(1000·2^n, 15000) + rand(0, 1000) — the browser twin's curve", () => {
        for (const [n, lo] of [[0, 1000], [1, 2000], [4, 15000], [40, 15000]] as const) {
            const d = observeBackoffDelay(n);
            expect(d).toBeGreaterThanOrEqual(lo);
            expect(d).toBeLessThan(lo + 1000);
        }
    });
});

// ── Iteration + the golden equality ──────────────────────────────────────

describe("observe() — iteration and state", () => {
    it("iterates every entry and reduces to the golden state", async () => {
        const f = recordingFetch(() => ok(bodyOf(wholeCall)));
        const obs = observe({ call: GOLDEN.call, token: TOKEN, fetchImpl: f.impl });

        const got: AnyLogEntry[] = [];
        for await (const e of obs) got.push(e);

        expect(got.map((e) => e.seq)).toEqual(entries.map((e) => e.seq));
        expect(obs.state).toEqual(goldenState());
        expect(obs.lastSeq).toBe(50);
        expect(obs.dropped).toBe(0);
        await expect(obs.done).resolves.toEqual({ reason: "summary", lastSeq: 50 });
        expect(obs.active).toBe(false);
    });

    it("reaches the same state entry-by-entry as byte-chunk-by-byte-chunk", async () => {
        // One byte at a time: the decoder must be indifferent to framing.
        const bytes = enc.encode(wholeCall);
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                for (const b of bytes) c.enqueue(new Uint8Array([b]));
                c.close();
            },
        });
        const f = recordingFetch(() => ok(body));
        const obs = observe({ call: GOLDEN.call, token: TOKEN, fetchImpl: f.impl });
        await obs.done;
        expect(obs.state).toEqual(goldenState());
    });

    it("fires on(\"entry\") in seq order and on(\"custom\") for custom entries", async () => {
        const f = recordingFetch(() => ok(bodyOf(wholeCall)));
        const obs = observe({ call: GOLDEN.call, token: TOKEN, fetchImpl: f.impl });
        const seqs: number[] = [];
        const customs: [string, unknown][] = [];
        obs.on("entry", (e) => seqs.push(e.seq));
        obs.on("custom", (name, value) => customs.push([name, value]));
        await obs.done;
        expect(seqs).toEqual(entries.map((e) => e.seq));
        expect(customs.map((c) => c[0])).toEqual(
            entries.filter((e) => e.type === "custom").map((e) => (e.data as { name: string }).name),
        );
    });

    it("fires on(\"finish\") once, and still fires for a listener attached late", async () => {
        const f = recordingFetch(() => ok(bodyOf(wholeCall)));
        const obs = observe({ call: GOLDEN.call, token: TOKEN, fetchImpl: f.impl });
        const early = vi.fn();
        obs.on("finish", early);
        await obs.done;
        const late = vi.fn();
        obs.on("finish", late);
        await new Promise((r) => setTimeout(r, 0));
        expect(early).toHaveBeenCalledTimes(1);
        expect(early.mock.calls[0]![0]).toMatchObject({ reason: "summary", lastSeq: 50 });
        expect(late).toHaveBeenCalledTimes(1);
    });

    it("unsubscribes a listener when its returned function is called", async () => {
        const f = recordingFetch(() => ok(bodyOf(wholeCall)));
        const obs = observe({ call: GOLDEN.call, token: TOKEN, fetchImpl: f.impl });
        const fn = vi.fn();
        const off = obs.on("entry", fn);
        off();
        await obs.done;
        expect(fn).not.toHaveBeenCalled();
    });
});

// ── The URL: target, cursor, filters ─────────────────────────────────────

describe("observe() — the request", () => {
    it("targets the call cursor and carries token, after and filters", async () => {
        const f = recordingFetch(() => ok(bodyOf(wholeCall)));
        const obs = observe({
            call: "CA one/two",
            token: TOKEN,
            after: 12,
            types: ["custom", "call.ended"],
            durable: true,
            fetchImpl: f.impl,
        });
        await obs.done;
        expect(f.urls[0]).toBe(
            "https://voice.pinecall.io/v1/calls/CA%20one%2Ftwo/events" +
            `?token=${TOKEN}&after=12&types=custom%2Ccall.ended&durable=1`,
        );
    });

    it("targets the agent log and honours `server`", async () => {
        const f = recordingFetch(() => ok(bodyOf("")));
        const obs = observe({
            agent: "lucia",
            token: TOKEN,
            server: "http://localhost:8080/",
            reconnect: false,
            fetchImpl: f.impl,
        });
        await obs.done;
        expect(f.urls[0]).toBe(`http://localhost:8080/v1/agents/lucia/calls?token=${TOKEN}&after=0`);
    });

    it("sends Accept: text/event-stream and a Bearer token", async () => {
        const headers: Record<string, string>[] = [];
        const impl: ObserveFetch = async (_url, init) => {
            headers.push(init?.headers ?? {});
            return ok(bodyOf(wholeCall));
        };
        const obs = observe({ call: GOLDEN.call, token: TOKEN, fetchImpl: impl });
        await obs.done;
        expect(headers[0]).toEqual({
            Accept: "text/event-stream",
            Authorization: `Bearer ${TOKEN}`,
        });
    });
});

// ── Terminators ──────────────────────────────────────────────────────────

describe("observe() — how it ends", () => {
    it("204 on a sealed cursor finishes with \"summary\" and never retries", async () => {
        const f = recordingFetch(() => ({ ok: false, status: 204, text: async () => "", body: null }));
        const obs = observe({ agent: "lucia", token: TOKEN, fetchImpl: f.impl });
        await expect(obs.done).resolves.toEqual({ reason: "summary", lastSeq: 0 });
        expect(f.urls).toHaveLength(1);
    });

    it("401/403/404 finish with \"error\" and never retry", async () => {
        for (const status of [401, 403, 404]) {
            const f = recordingFetch(() => ({
                ok: false,
                status,
                text: async () => "nope",
                body: null,
            }));
            const errs: Error[] = [];
            const obs = observe({
                agent: "lucia",
                token: TOKEN,
                fetchImpl: f.impl,
                onError: (e) => errs.push(e),
            });
            const info = await obs.done;
            expect(info.reason).toBe("error");
            expect(f.urls).toHaveLength(1);
            expect(errs[0]!.message).toContain(String(status));
        }
    });

    it("a body that ends after call.summary finishes with \"summary\"", async () => {
        const f = recordingFetch(() => ok(bodyOf(wholeCall)));
        const obs = observe({ call: GOLDEN.call, token: TOKEN, fetchImpl: f.impl });
        await expect(obs.done).resolves.toEqual({ reason: "summary", lastSeq: 50 });
        expect(f.urls).toHaveLength(1); // no reconnect after the clean end
    });

    it("reconnect:false turns a dropped body into \"error\"", async () => {
        // Agent log: it never ends on its own, so a closed body is a drop.
        const f = recordingFetch(() => ok(bodyOf(frame(entries[0]!))));
        const obs = observe({ agent: "lucia", token: TOKEN, reconnect: false, fetchImpl: f.impl });
        const info = await obs.done;
        expect(info.reason).toBe("error");
        expect(f.urls).toHaveLength(1);
    });

    it("close() mid-stream ends the iteration and resolves done as \"closed\"", async () => {
        const p = pushable();
        const f = recordingFetch(() => ok(p.stream));
        const obs = observe({ agent: "lucia", token: TOKEN, fetchImpl: f.impl });
        const seen: number[] = [];
        const loop = (async () => {
            for await (const e of obs) {
                seen.push(e.seq);
                if (seen.length === 2) obs.close();
            }
        })();
        p.push(frame(entries[0]!));
        p.push(frame(entries[1]!));
        p.push(frame(entries[2]!));
        await loop;
        expect(seen).toEqual([1, 2]);
        expect(obs.active).toBe(false);
        await expect(obs.done).resolves.toMatchObject({ reason: "closed" });
        p.end();
    });

    it("an AbortSignal is exactly close()", async () => {
        const p = pushable();
        const f = recordingFetch(() => ok(p.stream));
        const ac = new AbortController();
        const obs = observe({ agent: "lucia", token: TOKEN, signal: ac.signal, fetchImpl: f.impl });
        p.push(frame(entries[0]!));
        await new Promise((r) => setTimeout(r, 10));
        ac.abort();
        await expect(obs.done).resolves.toMatchObject({ reason: "closed" });
        expect(f.signals[0]!.aborted).toBe(true);
        p.end();
    });

    it("a signal already aborted opens nothing", async () => {
        const f = recordingFetch(() => ok(bodyOf(wholeCall)));
        const obs = observe({
            agent: "lucia",
            token: TOKEN,
            signal: AbortSignal.abort(),
            fetchImpl: f.impl,
        });
        await expect(obs.done).resolves.toMatchObject({ reason: "closed" });
        expect(f.urls).toHaveLength(0);
    });

    it("breaking out of `for await` closes the observation", async () => {
        const p = pushable();
        const f = recordingFetch(() => ok(p.stream));
        const obs = observe({ agent: "lucia", token: TOKEN, fetchImpl: f.impl });
        p.push(frame(entries[0]!));
        for await (const _e of obs) break;
        expect(obs.active).toBe(false);
        p.end();
    });
});

// ── Resume ───────────────────────────────────────────────────────────────

describe("observe() — cursor resume", () => {
    it("reopens with after=<lastSeq> after a dropped body", async () => {
        let second!: () => void;
        const reconnected = new Promise<void>((r) => {
            second = r;
        });
        const f = recordingFetch((n) => {
            if (n === 0) return ok(bodyOf(entries.slice(0, 10).map(frame).join("")));
            second();
            return ok(bodyOf(""));
        });
        const obs = observe({ agent: "lucia", token: TOKEN, fetchImpl: f.impl });
        await reconnected;
        expect(f.urls[0]).toContain("&after=0");
        expect(f.urls[1]).toContain("&after=10");
        obs.close();
    }, 10_000);

    it("survives a replay overlap without duplicating an entry", async () => {
        let second!: () => void;
        const reconnected = new Promise<void>((r) => {
            second = r;
        });
        const f = recordingFetch((n) => {
            if (n === 0) return ok(bodyOf(entries.slice(0, 20).map(frame).join("")));
            second();
            // The server replays with the customary overlap.
            return ok(bodyOf(entries.slice(17).map(frame).join("")));
        });
        const seen: number[] = [];
        const obs = observe({
            call: GOLDEN.call,
            token: TOKEN,
            fetchImpl: f.impl,
            onError: () => {},
        });
        obs.on("entry", (e) => seen.push(e.seq));
        await reconnected;
        await obs.done;
        expect(seen).toEqual(entries.map((e) => e.seq));
        expect(obs.state).toEqual(goldenState());
    }, 10_000);
});

// ── The idle watchdog ────────────────────────────────────────────────────

describe("observe() — the idle watchdog", () => {
    it("aborts a silent stream once the fixed window elapses", async () => {
        const p = pushable();
        const f = recordingFetch(() => ok(p.stream));
        const obs = observe({
            agent: "lucia",
            token: TOKEN,
            idleReconnect: 30,
            fetchImpl: f.impl,
        });
        p.push(frame(entries[0]!));
        await new Promise((r) => setTimeout(r, 300));
        expect(f.signals[0]!.aborted).toBe(true);
        obs.close();
        p.end();
    });

    it("a `: ping` comment keeps a silent stream alive", async () => {
        const p = pushable();
        const f = recordingFetch(() => ok(p.stream));
        const obs = observe({
            agent: "lucia",
            token: TOKEN,
            idleReconnect: 120,
            fetchImpl: f.impl,
        });
        for (let i = 0; i < 6; i++) {
            p.push(": ping\n\n");
            await new Promise((r) => setTimeout(r, 40));
        }
        expect(f.signals[0]!.aborted).toBe(false);
        obs.close();
        p.end();
    });

    it("idleReconnect: 0 never trips", async () => {
        const p = pushable();
        const f = recordingFetch(() => ok(p.stream));
        const obs = observe({
            agent: "lucia",
            token: TOKEN,
            idleReconnect: 0,
            fetchImpl: f.impl,
        });
        p.push(frame(entries[0]!));
        await new Promise((r) => setTimeout(r, 150));
        expect(f.signals[0]!.aborted).toBe(false);
        obs.close();
        p.end();
    });
});

// ── Backpressure ─────────────────────────────────────────────────────────

describe("observe() — a slow consumer", () => {
    it("buffers up to queueLimit, then drops the OLDEST and counts it", async () => {
        const f = recordingFetch(() => ok(bodyOf(wholeCall)));
        const obs = observe({
            call: GOLDEN.call,
            token: TOKEN,
            queueLimit: 5,
            fetchImpl: f.impl,
        });
        // Let the whole call land before touching the iterator.
        await obs.done;
        const got: number[] = [];
        for await (const e of obs) got.push(e.seq);
        // The reduced state is COMPLETE — the queue is the only lossy surface.
        expect(obs.state).toEqual(goldenState());
        expect(obs.lastSeq).toBe(50);
        expect(got).toEqual(entries.slice(-5).map((e) => e.seq));
        expect(obs.dropped).toBe(45);
    });

    it("loses nothing when the consumer keeps up", async () => {
        const p = pushable();
        const f = recordingFetch(() => ok(p.stream));
        const obs = observe({ call: GOLDEN.call, token: TOKEN, queueLimit: 5, fetchImpl: f.impl });
        const got: number[] = [];
        const loop = (async () => {
            for await (const e of obs) got.push(e.seq);
        })();
        for (const e of entries) {
            p.push(frame(e));
            await new Promise((r) => setTimeout(r, 0));
        }
        p.end();
        await loop;
        // A consumer parked in `next()` is handed the entry directly and the
        // queue is never touched — 5 slots are plenty for a reader that reads.
        expect(obs.dropped).toBe(0);
        expect(got).toEqual(entries.map((e) => e.seq));
    });
});

// ── Refusals ─────────────────────────────────────────────────────────────

describe("observe() — what it refuses", () => {
    it("needs exactly one of { call, agent }", () => {
        expect(() => observe({ token: TOKEN } as never)).toThrow(/exactly one/);
        expect(() => observe({ call: "CA1", agent: "lucia", token: TOKEN })).toThrow(/exactly one/);
    });

    it("needs a token or an API key to mint one", () => {
        expect(() => observe({ agent: "lucia" })).toThrow(/token/);
    });

    it("refuses { call } with no token: minting a stream token needs an agent", () => {
        expect(() => observe({ call: "CA1", apiKey: "pk_x" })).toThrow(/needs an agent/);
    });
});

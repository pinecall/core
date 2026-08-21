/**
 * Audio API — `speech()` against a mocked `POST /v1/audio/speech`.
 *
 * What is worth pinning: the call resolves on HEADERS (playback can start on
 * the first chunk), the body streams rather than buffers, SSE frames route to
 * the right place (audio → `audio`, word → `words`, done → `done`), an error
 * frame rejects everything, pre-stream refusals arrive as a typed
 * `AudioApiError` with status + code, and `cancel()` reaches the fetch's
 * AbortSignal. No network anywhere.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { speech, fetchAudioVoices, AudioApiError } from "../src/api/audio.js";
import { Pinecall } from "../src/client.js";
import { createSSEParser } from "../src/sse/parse.js";

const enc = new TextEncoder();
const opts = { apiKey: "pk_test", apiUrl: "https://voice.test", input: "hola mundo", voice: "elevenlabs/sarah" };

/** A body that hands out `chunks` one read at a time. */
function chunkedBody(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < chunks.length) controller.enqueue(chunks[i++]);
            else controller.close();
        },
    });
}

function response(
    body: ReadableStream<Uint8Array> | string | null,
    init: { status?: number; headers?: Record<string, string> } = {},
): Response {
    const status = init.status ?? 200;
    const headers = new Headers(init.headers ?? {});
    const stream = typeof body === "string" ? chunkedBody([enc.encode(body)]) : body;
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: "",
        headers,
        body: stream,
        text: async () => (typeof body === "string" ? body : ""),
        json: async () => JSON.parse(typeof body === "string" ? body : "{}"),
    } as unknown as Response;
}

function sseFrames(frames: Array<Record<string, unknown> | "[DONE]">): string {
    return frames.map((f) => `data: ${f === "[DONE]" ? "[DONE]" : JSON.stringify(f)}\n\n`).join("");
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
    const out: Uint8Array[] = [];
    const r = stream.getReader();
    for (;;) {
        const { done, value } = await r.read();
        if (done) return out;
        out.push(value);
    }
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const x of it) out.push(x);
    return out;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// ── Request shape ────────────────────────────────────────────────────────

describe("speech() request", () => {
    it("POSTs the frozen wire body with Bearer auth to /v1/audio/speech", async () => {
        fetchMock.mockResolvedValue(response(chunkedBody([]), {
            headers: { "content-type": "audio/pcm", "x-pinecall-request-id": "req_1" },
        }));

        await speech({
            ...opts, model: "elevenlabs/auto", language: "es", format: "wav",
            sampleRate: 24000, speed: 1.1, timestamps: false,
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://voice.test/v1/audio/speech");
        expect(init.method).toBe("POST");
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer pk_test");
        expect(headers["Content-Type"]).toBe("application/json");
        expect(JSON.parse(init.body as string)).toEqual({
            input: "hola mundo", voice: "elevenlabs/sarah", model: "elevenlabs/auto",
            language: "es", response_format: "wav", sample_rate: 24000, speed: 1.1, timestamps: false,
        });
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("omits optional fields that were not given", async () => {
        fetchMock.mockResolvedValue(response(chunkedBody([]), { headers: { "content-type": "audio/pcm" } }));
        await speech(opts);
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(JSON.parse(init.body as string)).toEqual({ input: "hola mundo", voice: "elevenlabs/sarah" });
    });

    it("defaults apiUrl to voice.pinecall.io", async () => {
        fetchMock.mockResolvedValue(response(chunkedBody([]), { headers: { "content-type": "audio/pcm" } }));
        await speech({ ...opts, apiUrl: undefined });
        expect(fetchMock.mock.calls[0][0]).toBe("https://voice.pinecall.io/v1/audio/speech");
    });
});

// ── Binary mode ──────────────────────────────────────────────────────────

describe("speech() binary mode", () => {
    it("parses headers and resolves before the body has produced a single byte", async () => {
        // The body never yields until we say so — speech() must not wait for it.
        let release!: () => void;
        const gate = new Promise<void>((res) => { release = res; });
        const body = new ReadableStream<Uint8Array>({
            async pull(controller) { await gate; controller.enqueue(new Uint8Array([1, 2])); controller.close(); },
        });
        fetchMock.mockResolvedValue(response(body, {
            headers: {
                "content-type": "audio/pcm",
                "x-sample-rate": "24000",
                "x-channels": "1",
                "x-bit-depth": "16",
                "x-pinecall-request-id": "req_bin",
            },
        }));

        const r = await speech({ ...opts, sampleRate: 24000 });
        expect(r.requestId).toBe("req_bin");
        expect(r.format).toBe("pcm");
        expect(r.sampleRate).toBe(24000);
        expect(r.channels).toBe(1);
        expect(r.bitDepth).toBe(16);
        expect((await collect(r.words))).toEqual([]);
        release();
        expect((await drain(r.audio)).length).toBe(1);
    });

    it("streams chunks through `audio` in order and resolves `done` byte-derived", async () => {
        // 32000 bytes of s16le mono @ 16 kHz = 1000 ms
        const a = new Uint8Array(12000), b = new Uint8Array(20000);
        a.fill(1); b.fill(2);
        fetchMock.mockResolvedValue(response(chunkedBody([a, b]), {
            headers: { "content-type": "audio/pcm", "x-sample-rate": "16000" },
        }));

        const r = await speech(opts);
        const chunks = await drain(r.audio);
        expect(chunks.map((c) => c.byteLength)).toEqual([12000, 20000]);
        expect(chunks[0][0]).toBe(1);
        expect(chunks[1][0]).toBe(2);
        await expect(r.done).resolves.toEqual({ characters: "hola mundo".length, audioMs: 1000 });
    });

    it("takes characters from X-Pinecall-Characters when present", async () => {
        fetchMock.mockResolvedValue(response(chunkedBody([new Uint8Array(320)]), {
            headers: { "content-type": "audio/pcm", "x-pinecall-characters": "42" },
        }));
        const r = await speech(opts);
        await drain(r.audio);
        await expect(r.done).resolves.toEqual({ characters: 42, audioMs: 10 });
    });

    it("reads format from Content-Type (wav / mp3)", async () => {
        fetchMock.mockResolvedValueOnce(response(chunkedBody([]), { headers: { "content-type": "audio/wav" } }));
        expect((await speech(opts)).format).toBe("wav");
        fetchMock.mockResolvedValueOnce(response(chunkedBody([]), { headers: { "content-type": "audio/mpeg" } }));
        expect((await speech({ ...opts, format: "mp3" })).format).toBe("mp3");
    });

    it("arrayBuffer() concatenates the whole body", async () => {
        fetchMock.mockResolvedValue(response(chunkedBody([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]), {
            headers: { "content-type": "audio/pcm" },
        }));
        const r = await speech(opts);
        const buf = await r.arrayBuffer();
        expect(Array.from(new Uint8Array(buf))).toEqual([1, 2, 3, 4, 5]);
    });
});

// ── SSE mode ─────────────────────────────────────────────────────────────

describe("speech() SSE mode (timestamps)", () => {
    const pcm = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const b64a = Buffer.from(pcm.subarray(0, 4)).toString("base64");
    const b64b = Buffer.from(pcm.subarray(4)).toString("base64");

    it("decodes audio frames into `audio`, words into `words`, done into `done`; [DONE] closes both", async () => {
        const text = sseFrames([
            { type: "start", request_id: "req_sse", format: "pcm", sample_rate: 24000 },
            { type: "audio", data: b64a },
            { type: "word", word: "hola", start: 0, end: 0.4 },
            { type: "audio", data: b64b },
            { type: "word", word: "mundo", start: 0.45, end: 0.9 },
            { type: "done", characters: 10, audio_ms: 900 },
            "[DONE]",
        ]);
        // Split mid-frame to prove incremental parsing.
        const bytes = enc.encode(text);
        const cut = Math.floor(bytes.length / 3);
        fetchMock.mockResolvedValue(response(
            chunkedBody([bytes.subarray(0, cut), bytes.subarray(cut, cut * 2), bytes.subarray(cut * 2)]),
            { headers: { "content-type": "text/event-stream", "x-pinecall-request-id": "req_hdr" } },
        ));

        const r = await speech({ ...opts, timestamps: true });
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(JSON.parse(init.body as string).timestamps).toBe(true);

        const [chunks, words, done] = await Promise.all([drain(r.audio), collect(r.words), r.done]);
        expect(Array.from(chunks.flatMap((c) => Array.from(c)))).toEqual(Array.from(pcm));
        expect(words).toEqual([
            { word: "hola", start: 0, end: 0.4 },
            { word: "mundo", start: 0.45, end: 0.9 },
        ]);
        expect(done).toEqual({ characters: 10, audioMs: 900 });
        expect(r.requestId).toBe("req_sse");
        expect(r.sampleRate).toBe(24000);
    });

    it("words flow even when audio is never read", async () => {
        fetchMock.mockResolvedValue(response(sseFrames([
            { type: "audio", data: b64a },
            { type: "word", word: "hola", start: 0, end: 0.4 },
            { type: "done", characters: 4, audio_ms: 400 },
            "[DONE]",
        ]), { headers: { "content-type": "text/event-stream" } }));

        const r = await speech({ ...opts, timestamps: true });
        expect(await collect(r.words)).toEqual([{ word: "hola", start: 0, end: 0.4 }]);
        await expect(r.done).resolves.toEqual({ characters: 4, audioMs: 400 });
    });

    it("an error frame mid-stream rejects done, words and audio with AudioApiError", async () => {
        fetchMock.mockResolvedValue(response(sseFrames([
            { type: "audio", data: b64a },
            { type: "error", code: "UPSTREAM_ERROR", error: "provider hung up" },
        ]), { headers: { "content-type": "text/event-stream" } }));

        const r = await speech({ ...opts, timestamps: true });
        const err = await r.done.catch((e) => e);
        expect(err).toBeInstanceOf(AudioApiError);
        expect(err.code).toBe("UPSTREAM_ERROR");
        expect(err.message).toBe("provider hung up");
        await expect(collect(r.words)).rejects.toBe(err);
        await expect(drain(r.audio)).rejects.toBe(err);
    });

    it("ignores keepalive comments and tolerates CRLF", async () => {
        const text = `:ping\r\n\r\ndata: ${JSON.stringify({ type: "word", word: "x", start: 0, end: 1 })}\r\n\r\ndata: [DONE]\r\n\r\n`;
        fetchMock.mockResolvedValue(response(text, { headers: { "content-type": "text/event-stream" } }));
        const r = await speech({ ...opts, timestamps: true });
        expect(await collect(r.words)).toEqual([{ word: "x", start: 0, end: 1 }]);
        await expect(r.done).resolves.toMatchObject({ characters: "hola mundo".length });
    });
});

// ── Errors before streaming ──────────────────────────────────────────────

describe("speech() refusals", () => {
    it("402 → AudioApiError with status and code", async () => {
        fetchMock.mockResolvedValue(response(
            JSON.stringify({ error: "Not enough credits", code: "INSUFFICIENT_CREDITS" }),
            { status: 402, headers: { "content-type": "application/json" } },
        ));
        const err = await speech(opts).catch((e) => e);
        expect(err).toBeInstanceOf(AudioApiError);
        expect(err.status).toBe(402);
        expect(err.code).toBe("INSUFFICIENT_CREDITS");
        expect(err.message).toBe("Not enough credits");
    });

    it("401 → AudioApiError INVALID_KEY", async () => {
        fetchMock.mockResolvedValue(response(
            JSON.stringify({ error: "bad key", code: "INVALID_KEY" }),
            { status: 401 },
        ));
        const err = await speech(opts).catch((e) => e);
        expect(err).toBeInstanceOf(AudioApiError);
        expect(err.status).toBe(401);
        expect(err.code).toBe("INVALID_KEY");
    });

    it("non-JSON error body still yields a typed error", async () => {
        fetchMock.mockResolvedValue(response("Bad Gateway", { status: 502 }));
        const err = await speech(opts).catch((e) => e);
        expect(err).toBeInstanceOf(AudioApiError);
        expect(err.status).toBe(502);
        expect(err.code).toBe("HTTP_502");
    });

    it("network failure → AudioApiError NETWORK_ERROR status 0", async () => {
        fetchMock.mockRejectedValue(new TypeError("fetch failed"));
        const err = await speech(opts).catch((e) => e);
        expect(err).toBeInstanceOf(AudioApiError);
        expect(err.status).toBe(0);
        expect(err.code).toBe("NETWORK_ERROR");
    });

    it("missing apiKey is refused locally", async () => {
        const err = await speech({ ...opts, apiKey: "" }).catch((e) => e);
        expect(err).toBeInstanceOf(AudioApiError);
        expect(err.code).toBe("MISSING_KEY");
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

// ── Cancel ───────────────────────────────────────────────────────────────

describe("speech() cancel", () => {
    it("cancel() aborts the fetch signal and rejects done (binary)", async () => {
        let signal: AbortSignal | undefined;
        fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
            signal = init.signal as AbortSignal;
            // A body that never ends on its own but fails once the signal aborts.
            const body = new ReadableStream<Uint8Array>({
                pull(controller) {
                    return new Promise<void>((_, reject) => {
                        const s = init.signal as AbortSignal;
                        if (s.aborted) { controller.error(abortErr()); reject(abortErr()); return; }
                        s.addEventListener("abort", () => { controller.error(abortErr()); reject(abortErr()); }, { once: true });
                    });
                },
            });
            return response(body, { headers: { "content-type": "audio/pcm" } });
        });

        const r = await speech(opts);
        expect(signal?.aborted).toBe(false);
        const reading = drain(r.audio);
        r.cancel();
        expect(signal?.aborted).toBe(true);
        await expect(reading).rejects.toMatchObject({ name: "AbortError" });
        await expect(r.done).rejects.toMatchObject({ name: "AbortError" });
    });

    it("cancel() aborts the fetch signal and rejects done (SSE)", async () => {
        let signal: AbortSignal | undefined;
        fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
            signal = init.signal as AbortSignal;
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(enc.encode(sseFrames([{ type: "word", word: "a", start: 0, end: 1 }])));
                    (init.signal as AbortSignal).addEventListener("abort", () => controller.error(abortErr()), { once: true });
                },
            });
            return response(body, { headers: { "content-type": "text/event-stream" } });
        });

        const r = await speech({ ...opts, timestamps: true });
        const it = r.words[Symbol.asyncIterator]();
        expect((await it.next()).value).toEqual({ word: "a", start: 0, end: 1 });
        r.cancel();
        expect(signal?.aborted).toBe(true);
        await expect(r.done).rejects.toMatchObject({ name: "AbortError" });
        await expect(it.next()).rejects.toMatchObject({ name: "AbortError" });
    });

    it("honours a caller-supplied signal", async () => {
        let signal: AbortSignal | undefined;
        fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
            signal = init.signal as AbortSignal;
            return response(chunkedBody([]), { headers: { "content-type": "audio/pcm" } });
        });
        const ac = new AbortController();
        await speech({ ...opts, signal: ac.signal });
        expect(signal?.aborted).toBe(false);
        ac.abort();
        expect(signal?.aborted).toBe(true);
    });
});

function abortErr(): Error {
    const e = new Error("aborted");
    e.name = "AbortError";
    return e;
}

// ── pc.audio namespace ───────────────────────────────────────────────────

describe("pc.audio", () => {
    it("speech() uses the client's key and HTTP url derived from the ws url", async () => {
        fetchMock.mockResolvedValue(response(chunkedBody([]), { headers: { "content-type": "audio/pcm" } }));
        const pc = new Pinecall({ apiKey: "pk_client", apiUrl: "wss://voice.test", autoReconnect: false });
        const r = await pc.audio.speech({ input: "hi", voice: "elevenlabs/sarah" });
        expect(r.format).toBe("pcm");
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://voice.test/v1/audio/speech");
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer pk_client");
    });

    it("voices() hits /v1/audio/voices with the client's key and maps rows", async () => {
        fetchMock.mockResolvedValue(response(JSON.stringify({
            success: true,
            total: 1,
            voices: [{ id: "v1", name: "Sarah", alias: "sarah", provider: "elevenlabs", languages: ["es"] }],
        }), { headers: { "content-type": "application/json" } }));
        const pc = new Pinecall({ apiKey: "pk_client", apiUrl: "wss://voice.test", autoReconnect: false });
        const voices = await pc.audio.voices({ provider: "elevenlabs", language: "es" });
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://voice.test/v1/audio/voices?provider=elevenlabs&language=es");
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer pk_client");
        expect(voices).toEqual([expect.objectContaining({ id: "v1", alias: "sarah", provider: "elevenlabs" })]);
        expect(voices[0].languages).toEqual([{ code: "es", name: "es" }]);
    });
});

describe("fetchAudioVoices()", () => {
    it("maps a refusal to AudioApiError", async () => {
        fetchMock.mockResolvedValue(response(JSON.stringify({ error: "no", code: "INVALID_KEY" }), { status: 401 }));
        const err = await fetchAudioVoices({ apiKey: "x", apiUrl: "https://voice.test" }).catch((e) => e);
        expect(err).toBeInstanceOf(AudioApiError);
        expect(err.status).toBe(401);
        expect(err.code).toBe("INVALID_KEY");
    });
});

// ── SSE parser ───────────────────────────────────────────────────────────

describe("createSSEParser", () => {
    it("joins multi-line data, reads event/id, and dispatches across chunk boundaries", () => {
        const seen: unknown[] = [];
        const p = createSSEParser((e) => seen.push(e));
        p.feed("event: word\nid: 7\ndata: {\"a\":");
        p.feed("1}\ndata: more\n");
        expect(seen).toEqual([]);
        p.feed("\n");
        expect(seen).toEqual([{ event: "word", id: "7", data: "{\"a\":1}\nmore" }]);
        p.feed("data: tail");
        p.end();
        expect(seen[1]).toEqual({ event: undefined, id: undefined, data: "tail" });
    });
});

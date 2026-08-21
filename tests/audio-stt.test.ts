/**
 * Audio API — `transcribe()` against a mocked `POST /v1/audio/transcriptions`
 * and `transcribeStream()` against a local `ws` server standing in for
 * `WS /v1/audio/transcriptions/stream`.
 *
 * What is worth pinning: the multipart fields go out under the names the
 * server reads, the three response formats map to one `Transcription` (with
 * speakers), a path input is read from disk, refusals arrive as a typed
 * `AudioApiError`, the abort signal reaches fetch; on the socket the key
 * travels in the Authorization header (never the URL), audio written before
 * `ready` is buffered and arrives in order, frames become events and iterator
 * items, `end()` resolves on `done`, and an error frame or a dirty close
 * rejects everything. No network anywhere.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { transcribe, transcribeStream, AudioApiError } from "../src/api/audio.js";
import { Pinecall } from "../src/client.js";

const enc = new TextEncoder();
const base = { apiKey: "pk_test", apiUrl: "https://voice.test" };
const wavBytes = enc.encode("RIFF....WAVEfmt fake");

function response(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
    const status = init.status ?? 200;
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: "",
        headers: new Headers(init.headers ?? {}),
        text: async () => body,
        json: async () => JSON.parse(body),
    } as unknown as Response;
}

function jsonResponse(obj: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
    return response(JSON.stringify(obj), {
        ...init,
        headers: { "content-type": "application/json", "x-pinecall-request-id": "req_1", ...(init.headers ?? {}) },
    });
}

function lastRequest(): { url: string; init: RequestInit; form: FormData } {
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return { url, init, form: init.body as FormData };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// ── transcribe() ─────────────────────────────────────────────────────────

describe("transcribe()", () => {
    it("POSTs multipart to /v1/audio/transcriptions with every field under its wire name", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ text: "hola", language: "es", duration: 1.5 }));
        const r = await transcribe(wavBytes, {
            ...base,
            model: "deepgram/nova-3",
            language: "es",
            diarize: true,
            format: "json",
            filename: "a.wav",
        });
        const { url, init, form } = lastRequest();
        expect(url).toBe("https://voice.test/v1/audio/transcriptions");
        expect(init.method).toBe("POST");
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer pk_test");
        expect(headers["Content-Type"]).toBeUndefined(); // fetch sets the multipart boundary itself
        expect(form).toBeInstanceOf(FormData);
        expect(form.get("model")).toBe("deepgram/nova-3");
        expect(form.get("language")).toBe("es");
        expect(form.get("diarize")).toBe("true");
        expect(form.get("response_format")).toBe("json");
        const file = form.get("file") as File;
        expect(file).toBeInstanceOf(Blob);
        expect(file.name).toBe("a.wav");
        expect(file.type).toBe("audio/wav");
        expect(new Uint8Array(await file.arrayBuffer())).toEqual(wavBytes);
        expect(r).toEqual({ requestId: "req_1", text: "hola", language: "es", duration: 1.5 });
    });

    it("omits the optional fields it was not given and defaults the part to audio.wav", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ text: "x", language: "en", duration: 0.2 }));
        await transcribe(wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength), base);
        const { form } = lastRequest();
        expect(form.get("model")).toBeNull();
        expect(form.get("language")).toBeNull();
        expect(form.get("diarize")).toBeNull();
        expect(form.get("response_format")).toBeNull();
        const file = form.get("file") as File;
        expect(file.name).toBe("audio.wav");
        expect(file.type).toBe("audio/wav");
    });

    it("infers filename from contentType and contentType from filename", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ text: "x", language: "en", duration: 0.2 }));
        await transcribe(wavBytes, { ...base, contentType: "audio/mpeg" });
        let file = lastRequest().form.get("file") as File;
        expect(file.name).toBe("audio.mp3");
        expect(file.type).toBe("audio/mpeg");

        fetchMock.mockClear();
        await transcribe(wavBytes, { ...base, filename: "clip.webm" });
        file = lastRequest().form.get("file") as File;
        expect(file.name).toBe("clip.webm");
        expect(file.type).toBe("audio/webm");
    });

    it("maps verbose_json — words and segments keep their speakers", async () => {
        fetchMock.mockResolvedValue(jsonResponse({
            text: "hola qué tal",
            language: "es",
            duration: 2.25,
            model: "elevenlabs/scribe_v1",
            words: [
                { word: "hola", start: 0, end: 0.4, speaker: "0" },
                { word: "qué", start: 0.5, end: 0.7, speaker: 1 },
                { word: "tal", start: 0.7, end: 0.9 },
            ],
            segments: [
                { id: 0, start: 0, end: 0.4, text: "hola", speaker: "0" },
                { id: 1, start: 0.5, end: 0.9, text: "qué tal", speaker: "1" },
            ],
        }));
        const r = await transcribe(wavBytes, { ...base, format: "verbose_json", diarize: true });
        expect(lastRequest().form.get("response_format")).toBe("verbose_json");
        expect(r.requestId).toBe("req_1");
        expect(r.model).toBe("elevenlabs/scribe_v1");
        expect(r.words).toEqual([
            { word: "hola", start: 0, end: 0.4, speaker: "0" },
            { word: "qué", start: 0.5, end: 0.7, speaker: "1" },
            { word: "tal", start: 0.7, end: 0.9 },
        ]);
        expect(r.segments).toEqual([
            { id: 0, start: 0, end: 0.4, text: "hola", speaker: "0" },
            { id: 1, start: 0.5, end: 0.9, text: "qué tal", speaker: "1" },
        ]);
    });

    it("maps text — plain body, text only", async () => {
        fetchMock.mockResolvedValue(response("hola mundo\n", {
            headers: { "content-type": "text/plain; charset=utf-8", "x-pinecall-request-id": "req_t" },
        }));
        const r = await transcribe(wavBytes, { ...base, format: "text" });
        expect(lastRequest().form.get("response_format")).toBe("text");
        expect((lastRequest().init.headers as Record<string, string>).Accept).toBe("text/plain");
        expect(r).toEqual({ requestId: "req_t", text: "hola mundo\n", language: "", duration: 0 });
    });

    it("reads a path from disk and names the part after the file", async () => {
        const dir = mkdtempSync(join(tmpdir(), "pc-stt-"));
        const path = join(dir, "meeting.mp3");
        writeFileSync(path, wavBytes);
        try {
            fetchMock.mockResolvedValue(jsonResponse({ text: "x", language: "en", duration: 1 }));
            await transcribe(path, base);
            const file = lastRequest().form.get("file") as File;
            expect(file.name).toBe("meeting.mp3");
            expect(file.type).toBe("audio/mpeg");
            expect(new Uint8Array(await file.arrayBuffer())).toEqual(wavBytes);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("accepts a Blob/File and keeps its name and type", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ text: "x", language: "en", duration: 1 }));
        await transcribe(new File([wavBytes], "voice.ogg", { type: "audio/ogg" }), base);
        const file = lastRequest().form.get("file") as File;
        expect(file.name).toBe("voice.ogg");
        expect(file.type).toBe("audio/ogg");
    });

    it("402 / 413 → AudioApiError with the server's code and the HTTP status", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ error: "No credits", code: "INSUFFICIENT_CREDITS" }, { status: 402 }));
        let err = await transcribe(wavBytes, base).catch((e) => e);
        expect(err).toBeInstanceOf(AudioApiError);
        expect(err.status).toBe(402);
        expect(err.code).toBe("INSUFFICIENT_CREDITS");
        expect(err.message).toBe("No credits");

        fetchMock.mockResolvedValue(jsonResponse({ error: "Too big", code: "FILE_TOO_LARGE" }, { status: 413 }));
        err = await transcribe(wavBytes, base).catch((e) => e);
        expect(err).toBeInstanceOf(AudioApiError);
        expect(err.status).toBe(413);
        expect(err.code).toBe("FILE_TOO_LARGE");
    });

    it("network failure → AudioApiError status 0 NETWORK_ERROR; missing key refused up front", async () => {
        fetchMock.mockRejectedValue(new TypeError("fetch failed"));
        const err = await transcribe(wavBytes, base).catch((e) => e);
        expect(err).toBeInstanceOf(AudioApiError);
        expect(err.status).toBe(0);
        expect(err.code).toBe("NETWORK_ERROR");

        const noKey = await transcribe(wavBytes, { ...base, apiKey: "" }).catch((e) => e);
        expect(noKey.code).toBe("MISSING_KEY");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("passes the abort signal to fetch and rethrows the AbortError", async () => {
        const ac = new AbortController();
        fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_, reject) => {
            init.signal?.addEventListener("abort", () => {
                const e = new Error("aborted");
                e.name = "AbortError";
                reject(e);
            });
        }));
        const p = transcribe(wavBytes, { ...base, signal: ac.signal });
        await new Promise((r) => setTimeout(r, 0));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(ac.signal);
        ac.abort();
        await expect(p).rejects.toMatchObject({ name: "AbortError" });

        // Already aborted → never reaches the network.
        fetchMock.mockClear();
        const pre = new AbortController();
        pre.abort();
        await expect(transcribe(wavBytes, { ...base, signal: pre.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

// ── transcribeStream() ───────────────────────────────────────────────────

interface Conn {
    ws: WebSocket;
    req: IncomingMessage;
    /** Every frame the server received, in order. */
    frames: Array<{ binary: boolean; data: Buffer }>;
    /** Resolves when the server has `n` frames. */
    waitFrames(n: number): Promise<void>;
    send(frame: Record<string, unknown>): void;
}

let wss: WebSocketServer;
let wsUrl: string;
let httpUrl: string;
let nextConn: ((c: Conn) => void) | null = null;
let connQueue: Conn[] = [];

function rawToBuffer(data: RawData): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data)) return Buffer.concat(data);
    return Buffer.from(data as ArrayBuffer);
}

/** Start a server once for the suite; each test takes the next connection. */
async function startServer(): Promise<void> {
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const { port } = wss.address() as AddressInfo;
    wsUrl = `ws://127.0.0.1:${port}`;
    httpUrl = `http://127.0.0.1:${port}`;
    wss.on("connection", (ws, req) => {
        // The Pinecall client also dials its agent socket at construction — not ours.
        if (!req.url?.startsWith("/v1/audio/transcriptions/stream")) { ws.close(1000); return; }
        const frames: Conn["frames"] = [];
        const waiters: Array<{ n: number; resolve: () => void }> = [];
        ws.on("message", (data, isBinary) => {
            frames.push({ binary: isBinary, data: rawToBuffer(data) });
            for (const w of waiters.splice(0)) {
                if (frames.length >= w.n) w.resolve();
                else waiters.push(w);
            }
        });
        const conn: Conn = {
            ws,
            req,
            frames,
            waitFrames: (n) => frames.length >= n
                ? Promise.resolve()
                : new Promise((resolve) => waiters.push({ n, resolve })),
            send: (frame) => ws.send(JSON.stringify(frame)),
        };
        if (nextConn) { const f = nextConn; nextConn = null; f(conn); }
        else connQueue.push(conn);
    });
}

function connection(): Promise<Conn> {
    const queued = connQueue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => { nextConn = resolve; });
}

function closed(ws: WebSocket): Promise<number> {
    if (ws.readyState === ws.CLOSED) return Promise.resolve(1005);
    return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
}

function once<T>(s: { once(ev: any, fn: any): unknown }, ev: string): Promise<T> {
    return new Promise((resolve) => s.once(ev, (v: T) => resolve(v)));
}

// One server for the whole file — `pc.audio` below uses it too.
beforeAll(startServer);
afterAll(async () => {
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
});

describe("transcribeStream()", () => {
    beforeEach(() => {
        connQueue = [];
        nextConn = null;
    });

    it("connects with the key in the Authorization header (never the URL) and the options as query", async () => {
        const stream = transcribeStream({
            apiKey: "pk_ws",
            apiUrl: httpUrl,
            model: "soniox/stt-rt-v5",
            language: "es",
            sampleRate: 8000,
            encoding: "mulaw",
            diarize: true,
        });
        const conn = await connection();
        expect(conn.req.headers.authorization).toBe("Bearer pk_ws");
        const url = new URL(conn.req.url!, "http://x");
        expect(url.pathname).toBe("/v1/audio/transcriptions/stream");
        expect(url.searchParams.get("model")).toBe("soniox/stt-rt-v5");
        expect(url.searchParams.get("language")).toBe("es");
        expect(url.searchParams.get("sample_rate")).toBe("8000");
        expect(url.searchParams.get("encoding")).toBe("mulaw");
        expect(url.searchParams.get("diarize")).toBe("true");
        expect(url.searchParams.has("api_key")).toBe(false);
        expect(conn.req.url).not.toContain("pk_ws");
        stream.close();
        await closed(conn.ws);
    });

    it("derives ws:// from an http apiUrl and wss:// from https; sends only the options it was given", async () => {
        const stream = transcribeStream({ apiKey: "pk_ws", apiUrl: wsUrl });
        const conn = await connection();
        const url = new URL(conn.req.url!, "http://x");
        expect([...url.searchParams.keys()]).toEqual([]);
        stream.close();
        await closed(conn.ws);
    });

    it("buffers writes until ready, then sends them in order as binary frames; finalize/stop are text frames", async () => {
        const stream = transcribeStream({ apiKey: "pk_ws", apiUrl: httpUrl });
        stream.write(new Uint8Array([1, 2, 3]));
        stream.write(new Uint8Array([4, 5]).buffer);
        const conn = await connection();
        // Socket is open, no `ready` yet → nothing must have been sent.
        await new Promise((r) => setTimeout(r, 20));
        expect(conn.frames).toHaveLength(0);
        expect(stream.requestId).toBe("");

        const readyEv = once<{ requestId: string; model: string; sampleRate: number }>(stream, "ready");
        conn.send({ type: "ready", request_id: "req_ws", model: "deepgram/nova-3", sample_rate: 16000, encoding: "linear16", diarize: false });
        await stream.ready;
        expect(await readyEv).toEqual({ requestId: "req_ws", model: "deepgram/nova-3", sampleRate: 16000 });
        expect(stream.requestId).toBe("req_ws");

        stream.write(new Uint8Array([6]));
        stream.finalize();
        await conn.waitFrames(4);
        expect(conn.frames.map((f) => f.binary)).toEqual([true, true, true, false]);
        expect([...conn.frames[0].data]).toEqual([1, 2, 3]);
        expect([...conn.frames[1].data]).toEqual([4, 5]);
        expect([...conn.frames[2].data]).toEqual([6]);
        expect(JSON.parse(conn.frames[3].data.toString())).toEqual({ type: "finalize" });

        const endP = stream.end();
        await conn.waitFrames(5);
        expect(JSON.parse(conn.frames[4].data.toString())).toEqual({ type: "stop" });
        conn.send({ type: "done", request_id: "req_ws", audio_seconds: 1.5, billed_minutes: 1 });
        conn.ws.close(1000);
        expect(await endP).toEqual({ audioSeconds: 1.5, billedMinutes: 1 });
        // Calling end() again after done returns the same result.
        expect(await stream.end()).toEqual({ audioSeconds: 1.5, billedMinutes: 1 });
    });

    it("emits partial/final/done/close as events and yields partial/final through the async iterator", async () => {
        const stream = transcribeStream({ apiKey: "pk_ws", apiUrl: httpUrl, diarize: true });
        const partials: string[] = [];
        const finals: unknown[] = [];
        const dones: unknown[] = [];
        const closes: number[] = [];
        stream.on("partial", (t) => partials.push(t));
        stream.on("final", (s) => finals.push(s));
        stream.on("done", (d) => dones.push(d));
        stream.on("close", (c) => closes.push(c));

        const items: unknown[] = [];
        const iterated = (async () => { for await (const it of stream) items.push(it); })();

        const conn = await connection();
        conn.send({ type: "ready", request_id: "r1", model: "soniox/stt-rt-v5", sample_rate: 16000 });
        await stream.ready;
        conn.send({ type: "partial", text: "ho" });
        conn.send({ type: "partial", text: "hola" });
        conn.send({
            type: "final", text: "hola", start: 0, end: 0.5, language: "es", speaker: 0,
            words: [{ word: "hola", start: 0, end: 0.5, speaker: 0 }],
        });
        conn.send({ type: "partial", text: "qué" });
        conn.send({ type: "final", text: "qué tal" });
        conn.send({ type: "done", request_id: "r1", audio_seconds: 2, billed_minutes: 1 });
        conn.ws.close(1000);

        await iterated;
        expect(items).toEqual([
            { type: "partial", text: "ho" },
            { type: "partial", text: "hola" },
            { type: "final", segment: { text: "hola", start: 0, end: 0.5, language: "es", speaker: "0", words: [{ word: "hola", start: 0, end: 0.5, speaker: "0" }] } },
            { type: "partial", text: "qué" },
            { type: "final", segment: { text: "qué tal" } },
        ]);
        expect(partials).toEqual(["ho", "hola", "qué"]);
        expect(finals).toHaveLength(2);
        expect((finals[0] as { speaker: string }).speaker).toBe("0");
        expect(dones).toEqual([{ audioSeconds: 2, billedMinutes: 1 }]);
        await once(stream, "close").catch(() => {});
        // `close` may have fired already; either way exactly one, with 1000.
        await new Promise((r) => setTimeout(r, 10));
        expect(closes).toEqual([1000]);
    });

    it("an error frame → error event, ready/end reject, the iterator throws, then close", async () => {
        const stream = transcribeStream({ apiKey: "bad", apiUrl: httpUrl });
        const errEv = once<AudioApiError>(stream, "error");
        const closeEv = once<number>(stream, "close");
        const iterated = (async () => { for await (const _ of stream) { /* nothing */ } })();
        const endP = stream.end();
        const conn = await connection();
        conn.send({ type: "error", code: "INVALID_KEY", error: "Invalid API key" });
        conn.ws.close(1008, "auth");

        const err = await errEv;
        expect(err).toBeInstanceOf(AudioApiError);
        expect(err.code).toBe("INVALID_KEY");
        expect(err.message).toBe("Invalid API key");
        await expect(stream.ready).rejects.toBe(err);
        await expect(endP).rejects.toBe(err);
        await expect(iterated).rejects.toBe(err);
        expect(await closeEv).toBe(1008);
    });

    it("a dirty close (1011, no frame) → AudioApiError status 0 NETWORK_ERROR; close carries the code", async () => {
        const stream = transcribeStream({ apiKey: "pk_ws", apiUrl: httpUrl });
        const errors: AudioApiError[] = [];
        stream.on("error", (e) => errors.push(e));
        const closeEv = once<number>(stream, "close");
        const iterated = (async () => { for await (const _ of stream) { /* nothing */ } })();
        const conn = await connection();
        conn.send({ type: "ready", request_id: "r2", model: "deepgram/nova-3", sample_rate: 16000 });
        await stream.ready;
        const endP = stream.end();
        conn.ws.close(1011, "upstream");

        expect(await closeEv).toBe(1011);
        expect(errors).toHaveLength(1);
        expect(errors[0].status).toBe(0);
        expect(errors[0].code).toBe("NETWORK_ERROR");
        expect(errors[0].message).toContain("1011");
        await expect(iterated).rejects.toBe(errors[0]);
        await expect(endP).rejects.toBe(errors[0]);
    });

    it("close() hangs up with 1000 without waiting for done; writes after it are dropped", async () => {
        const stream = transcribeStream({ apiKey: "pk_ws", apiUrl: httpUrl });
        const closeEv = once<number>(stream, "close");
        const items: unknown[] = [];
        const iterated = (async () => { for await (const it of stream) items.push(it); })();
        const conn = await connection();
        conn.send({ type: "ready", request_id: "r3", model: "deepgram/nova-3", sample_rate: 16000 });
        await stream.ready;
        conn.send({ type: "partial", text: "a" });
        await new Promise((r) => setTimeout(r, 10));
        stream.close();
        stream.write(new Uint8Array([9]));
        expect(await closed(conn.ws)).toBe(1000);
        expect(await closeEv).toBe(1000);
        await iterated; // ends cleanly — no done, no error
        expect(items).toEqual([{ type: "partial", text: "a" }]);
        expect(conn.frames).toHaveLength(0);
        // end() after a user close cannot resolve — it rejects with CLOSED.
        await expect(stream.end()).rejects.toMatchObject({ code: "CLOSED" });
    });

    it("close() before the socket is open still ends with one close event and no error", async () => {
        const stream = transcribeStream({ apiKey: "pk_ws", apiUrl: httpUrl });
        const errors: unknown[] = [];
        stream.on("error", (e) => errors.push(e));
        const closeEv = once<number>(stream, "close");
        stream.write(new Uint8Array([1]));
        stream.close();
        expect(await closeEv).toBe(1000);
        expect(errors).toEqual([]);
        await expect(stream.ready).rejects.toMatchObject({ code: "CLOSED" });
    });

    it("a refused handshake (HTTP 401 before upgrade) → AudioApiError with the status", async () => {
        // A plain HTTP server that never upgrades.
        const { createServer } = await import("node:http");
        const srv = createServer((_req, res) => { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":"bad key","code":"INVALID_KEY"}'); });
        await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
        const { port } = srv.address() as AddressInfo;
        try {
            const stream = transcribeStream({ apiKey: "bad", apiUrl: `http://127.0.0.1:${port}` });
            const err = await once<AudioApiError>(stream, "error");
            expect(err).toBeInstanceOf(AudioApiError);
            expect(err.status).toBe(401);
            expect(err.code).toBe("INVALID_KEY");
            await expect(stream.ready).rejects.toBe(err);
        } finally {
            await new Promise<void>((resolve) => srv.close(() => resolve()));
        }
    });

    it("refuses up front without an apiKey", () => {
        expect(() => transcribeStream({ apiKey: "", apiUrl: httpUrl })).toThrow(AudioApiError);
    });
});

// ── pc.audio ─────────────────────────────────────────────────────────────

describe("pc.audio", () => {
    it("transcribe() uses the client's key and HTTP url derived from the ws url", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ text: "hi", language: "en", duration: 0.5 }));
        const pc = new Pinecall({ apiKey: "pk_client", apiUrl: "wss://voice.test", autoReconnect: false });
        const r = await pc.audio.transcribe(wavBytes, { language: "en" });
        expect(r.text).toBe("hi");
        const { url, init, form } = lastRequest();
        expect(url).toBe("https://voice.test/v1/audio/transcriptions");
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer pk_client");
        expect(form.get("language")).toBe("en");
    });

    it("transcribeStream() opens the socket against the client's server with the client's key", async () => {
        const pc = new Pinecall({ apiKey: "pk_client", apiUrl: wsUrl, autoReconnect: false });
        const stream = pc.audio.transcribeStream({ model: "deepgram/nova-3" });
        const conn = await connection();
        expect(conn.req.headers.authorization).toBe("Bearer pk_client");
        expect(new URL(conn.req.url!, "http://x").searchParams.get("model")).toBe("deepgram/nova-3");
        stream.close();
        await closed(conn.ws);
    });
});

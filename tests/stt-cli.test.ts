/**
 * CLI — `pinecall stt`.
 *
 * The network is mocked (globalThis.fetch for file mode, a local `ws`
 * server for --stream) and so is every process surface the command touches
 * (stdout/stderr/stdin/SIGINT/exit), so what is pinned here is the promise
 * the user sees: the transcript lands on stdout or in `-o` in the asked
 * format (text / json / verbose_json / srt / vtt, `[speaker N]` lines with
 * --diarize), the multipart request matches the flags, stdin PCM reaches
 * the socket and finals come back as lines while partials only ever touch a
 * TTY stderr, EOF / Ctrl-C end the stream and the billing is reported, and
 * a refusal becomes code + fix.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import {
    sttCommand, parseSttArgs, wireFormat, render, cuesOf, toSrt, toVtt, explainSttError, type SttIO,
} from "../src/cli/commands/stt.js";
import { AudioApiError, type Transcription } from "../src/api/audio.js";
import type { CliConfig } from "../src/cli/config.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const config: CliConfig = { apiKey: "pk_test", server: "https://voice.test", playground: "https://pg.test", json: false };

// ── Fixtures ─────────────────────────────────────────────────────────────

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
        headers: { "content-type": "application/json", "x-pinecall-request-id": "req_stt", ...(init.headers ?? {}) },
    });
}

class ExitSignal extends Error {
    constructor(public code: number) { super(`exit ${code}`); }
}

interface FakeIO extends SttIO {
    out: string[];
    err: string[];
    files: Map<string, string>;
    interrupt: () => void;
    outText(): string;
    errText(): string;
}

function fakeIO(opts: { stderrTTY?: boolean; stdin?: Uint8Array[] | AsyncIterable<Uint8Array>; stdinTTY?: boolean } = {}): FakeIO {
    const out: string[] = [];
    const err: string[] = [];
    const files = new Map<string, string>();
    let handler: (() => void) | null = null;
    let stdinClosed = false;
    const chunks = opts.stdin;
    return {
        out,
        err,
        files,
        stdout: { write(s: string) { out.push(s); return true; } },
        stderr: { isTTY: opts.stderrTTY ?? false, write(s: string) { err.push(s); return true; } },
        stdinIsTTY: opts.stdinTTY ?? chunks === undefined,
        stdin: () => {
            if (!chunks) return (async function* () { /* empty */ })();
            if (Array.isArray(chunks)) {
                return (async function* () {
                    for (const ch of chunks) {
                        if (stdinClosed) return;
                        yield ch;
                    }
                })();
            }
            return chunks;
        },
        closeStdin: () => { stdinClosed = true; },
        onInterrupt: (fn) => { handler = fn; return () => { if (handler === fn) handler = null; }; },
        interrupt: () => { handler?.(); },
        writeFile: async (path, data) => { files.set(path, data); writeFileSync(path, data); },
        exit: (code: number) => { throw new ExitSignal(code); },
        outText: () => out.join(""),
        errText: () => strip(err.join("")),
    };
}

/** An async iterable fed by hand — stdin that stays open until `end()`. */
function manualStdin(): { iter: AsyncIterable<Uint8Array>; push(b: Uint8Array): void; end(): void } {
    const queue: Uint8Array[] = [];
    let waiter: (() => void) | null = null;
    let ended = false;
    const wake = () => { const w = waiter; waiter = null; w?.(); };
    return {
        push: (b) => { queue.push(b); wake(); },
        end: () => { ended = true; wake(); },
        iter: {
            [Symbol.asyncIterator]() {
                return {
                    async next(): Promise<IteratorResult<Uint8Array>> {
                        for (;;) {
                            const b = queue.shift();
                            if (b) return { value: b, done: false };
                            if (ended) return { value: undefined, done: true };
                            await new Promise<void>((resolve) => { waiter = resolve; });
                        }
                    },
                };
            },
        },
    };
}

let fetchMock: ReturnType<typeof vi.fn>;
let dir: string;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    dir = mkdtempSync(join(tmpdir(), "pinecall-stt-cli-"));
});

afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
});

function lastForm(): { url: string; init: RequestInit; form: FormData } {
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return { url, init, form: init.body as FormData };
}

function wavFile(name = "a.wav"): string {
    const p = join(dir, name);
    writeFileSync(p, "RIFF....WAVEfmt fake");
    return p;
}

const verbose: Record<string, unknown> = {
    text: "Hola qué tal. Muy bien gracias.",
    language: "es",
    duration: 3.2,
    model: "elevenlabs/scribe_v1",
    words: [
        { word: "Hola", start: 0.0, end: 0.4, speaker: 0 },
        { word: "qué", start: 0.45, end: 0.6, speaker: 0 },
        { word: "tal.", start: 0.65, end: 0.9, speaker: 0 },
        { word: "Muy", start: 1.8, end: 2.0, speaker: 1 },
        { word: "bien", start: 2.05, end: 2.3, speaker: 1 },
        { word: "gracias.", start: 2.35, end: 2.9, speaker: 1 },
    ],
    segments: [
        { id: 0, start: 0.0, end: 0.9, text: "Hola qué tal.", speaker: 0 },
        { id: 1, start: 1.8, end: 2.9, text: "Muy bien gracias.", speaker: 1 },
    ],
};

// ── Flag parsing ─────────────────────────────────────────────────────────

describe("parseSttArgs", () => {
    it("reads the file, every flag and both spellings", () => {
        const a = parseSttArgs(["stt", "a.wav", "--model", "deepgram/nova-3", "--lang=es", "--diarize",
            "--format", "SRT", "-o", "a.srt"]);
        expect(a.file).toBe("a.wav");
        expect(a.stream).toBe(false);
        expect(a.model).toBe("deepgram/nova-3");
        expect(a.language).toBe("es");
        expect(a.diarize).toBe(true);
        expect(a.format).toBe("srt");
        expect(a.out).toBe("a.srt");
    });

    it("defaults to text, no diarize, ignores global flags, and reads --stream --rate", () => {
        const a = parseSttArgs(["stt", "--api-key=pk_x", "--server=https://x", "--stream", "--rate", "48000"]);
        expect(a.format).toBe("text");
        expect(a.diarize).toBe(false);
        expect(a.stream).toBe(true);
        expect(a.sampleRate).toBe(48000);
        expect(a.file).toBeUndefined();
    });

    it("refuses a bad --format / --rate, an unknown flag, and two files", () => {
        expect(() => parseSttArgs(["stt", "a.wav", "--format", "xml"])).toThrow(/--format/);
        expect(() => parseSttArgs(["stt", "--stream", "--rate", "44100"])).toThrow(/--rate/);
        expect(() => parseSttArgs(["stt", "a.wav", "--loud"])).toThrow(/Unknown flag/);
        expect(() => parseSttArgs(["stt", "a.wav", "b.wav"])).toThrow(/One file/);
    });
});

describe("wireFormat", () => {
    it("asks the wire for what the rendering needs", () => {
        expect(wireFormat("text", false)).toBe("text");
        expect(wireFormat("text", true)).toBe("verbose_json");
        expect(wireFormat("json", true)).toBe("json");
        expect(wireFormat("verbose_json", false)).toBe("verbose_json");
        expect(wireFormat("srt", false)).toBe("verbose_json");
        expect(wireFormat("vtt", false)).toBe("verbose_json");
    });
});

// ── Subtitles ────────────────────────────────────────────────────────────

describe("cues / srt / vtt", () => {
    const base: Transcription = { requestId: "r", text: "one two three four five six seven eight nine ten", language: "en", duration: 5 };

    it("uses segments when present", () => {
        const t: Transcription = { ...base, segments: [{ id: 0, start: 0, end: 1.5, text: " hi " }, { id: 1, start: 2, end: 3, text: "there", speaker: "1" }] };
        expect(cuesOf(t)).toEqual([{ start: 0, end: 1.5, text: "hi" }, { start: 2, end: 3, text: "there", speaker: "1" }]);
    });

    it("cuts words into 8-word cues when segments are absent", () => {
        const words = base.text.split(" ").map((w, i) => ({ word: w, start: i, end: i + 0.5 }));
        const cues = cuesOf({ ...base, words });
        expect(cues).toHaveLength(2);
        expect(cues[0]).toEqual({ start: 0, end: 7.5, text: "one two three four five six seven eight" });
        expect(cues[1]).toEqual({ start: 8, end: 9.5, text: "nine ten" });
    });

    it("falls back to one cue over the whole duration", () => {
        expect(cuesOf(base)).toEqual([{ start: 0, end: 5, text: base.text }]);
        expect(cuesOf({ ...base, text: "  " })).toEqual([]);
    });

    it("renders SRT with comma millis and VTT with a header and dot millis", () => {
        const t: Transcription = {
            ...base,
            segments: [{ id: 0, start: 0, end: 1.5, text: "Hi" }, { id: 1, start: 61.25, end: 3661.004, text: "Bye", speaker: "1" }],
        };
        expect(toSrt(t)).toBe(
            "1\n00:00:00,000 --> 00:00:01,500\nHi\n\n" +
            "2\n00:01:01,250 --> 01:01:01,004\n[speaker 1] Bye\n",
        );
        expect(toVtt(t)).toBe(
            "WEBVTT\n\n" +
            "00:00:00.000 --> 00:00:01.500\nHi\n\n" +
            "00:01:01.250 --> 01:01:01.004\n[speaker 1] Bye\n",
        );
    });

    it("render: json drops requestId, text keeps the transcript, diarized text is one line per segment", () => {
        const t: Transcription = { requestId: "r", text: "a b", language: "en", duration: 1, segments: [{ id: 0, start: 0, end: 1, text: "a b", speaker: "0" }] };
        expect(JSON.parse(render(t, "json", false))).toEqual({ text: "a b", language: "en", duration: 1, segments: t.segments });
        expect(render(t, "text", false)).toBe("a b\n");
        expect(render(t, "text", true)).toBe("[speaker 0] a b\n");
    });
});

// ── File mode ────────────────────────────────────────────────────────────

describe("pinecall stt <file>", () => {
    it("POSTs the file as multipart and prints the plain text on stdout", async () => {
        fetchMock.mockResolvedValue(response("hola mundo\n", { headers: { "content-type": "text/plain", "x-pinecall-request-id": "req_txt" } }));
        const io = fakeIO();
        const file = wavFile();

        await sttCommand(config, ["stt", file], io);

        const { url, init, form } = lastForm();
        expect(url).toBe("https://voice.test/v1/audio/transcriptions");
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer pk_test");
        const part = form.get("file") as File;
        expect(part).toBeInstanceOf(Blob);
        expect(part.name).toBe("a.wav");
        expect(await part.text()).toBe("RIFF....WAVEfmt fake");
        expect(form.get("response_format")).toBe("text");
        expect(form.get("diarize")).toBeNull();
        expect(form.get("model")).toBeNull();
        expect(io.outText()).toBe("hola mundo\n");
        const err = io.errText();
        expect(err).toContain("✓");
        expect(err).toContain("req_txt");
    });

    it("passes model/lang/diarize through and prints [speaker N] lines with --diarize (text needs verbose_json)", async () => {
        fetchMock.mockResolvedValue(jsonResponse(verbose));
        const io = fakeIO();

        await sttCommand(config, ["stt", wavFile(), "--diarize", "--model", "soniox/stt-async-preview", "--lang", "es"], io);

        const { form } = lastForm();
        expect(form.get("model")).toBe("soniox/stt-async-preview");
        expect(form.get("language")).toBe("es");
        expect(form.get("diarize")).toBe("true");
        expect(form.get("response_format")).toBe("verbose_json");
        expect(io.outText()).toBe("[speaker 0] Hola qué tal.\n[speaker 1] Muy bien gracias.\n");
        const err = io.errText();
        expect(err).toContain("3.2 s audio");
        expect(err).toContain("elevenlabs/scribe_v1");
        expect(err).toContain("diarized");
    });

    it("--format json prints the wire object; verbose_json adds words and segments", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ text: "hola", language: "es", duration: 1.5 }));
        const io = fakeIO();
        await sttCommand(config, ["stt", wavFile(), "--format", "json"], io);
        expect(lastForm().form.get("response_format")).toBe("json");
        expect(JSON.parse(io.outText())).toEqual({ text: "hola", language: "es", duration: 1.5 });

        fetchMock.mockReset();
        fetchMock.mockResolvedValue(jsonResponse(verbose));
        const io2 = fakeIO();
        await sttCommand(config, ["stt", wavFile(), "--format", "verbose_json"], io2);
        expect(lastForm().form.get("response_format")).toBe("verbose_json");
        const body = JSON.parse(io2.outText());
        expect(body.words).toHaveLength(6);
        expect(body.words[0]).toEqual({ word: "Hola", start: 0, end: 0.4, speaker: "0" });
        expect(body.segments[1].speaker).toBe("1");
        expect(body.requestId).toBeUndefined();
    });

    it("--format srt -o writes the subtitle file and nothing on stdout", async () => {
        fetchMock.mockResolvedValue(jsonResponse(verbose));
        const io = fakeIO();
        const out = join(dir, "a.srt");

        await sttCommand(config, ["stt", wavFile(), "--format", "srt", "-o", out], io);

        expect(lastForm().form.get("response_format")).toBe("verbose_json");
        expect(io.out).toHaveLength(0);
        expect(readFileSync(out, "utf8")).toBe(
            "1\n00:00:00,000 --> 00:00:00,900\n[speaker 0] Hola qué tal.\n\n" +
            "2\n00:00:01,800 --> 00:00:02,900\n[speaker 1] Muy bien gracias.\n",
        );
        expect(io.errText()).toContain("a.srt");
    });

    it("--format vtt builds word cues (cut on speaker change) when the provider has words but no segments", async () => {
        const { segments: _s, ...noSegments } = verbose;
        fetchMock.mockResolvedValue(jsonResponse(noSegments));
        const io = fakeIO();

        await sttCommand(config, ["stt", wavFile(), "--format", "vtt"], io);

        expect(io.outText()).toBe(
            "WEBVTT\n\n" +
            "00:00:00.000 --> 00:00:00.900\n[speaker 0] Hola qué tal.\n\n" +
            "00:00:01.800 --> 00:00:02.900\n[speaker 1] Muy bien gracias.\n",
        );
    });

    it("with no file and no --stream prints usage and exits 1", async () => {
        const io = fakeIO();
        await expect(sttCommand(config, ["stt"], io)).rejects.toBeInstanceOf(ExitSignal);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(io.errText()).toContain("Nothing to transcribe");
    });

    it("a missing file fails before any request", async () => {
        const io = fakeIO();
        await expect(sttCommand(config, ["stt", join(dir, "nope.wav")], io)).rejects.toMatchObject({ code: 1 });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(io.errText()).toContain("ENOENT");
    });

    it("a 413 becomes FILE_TOO_LARGE plus the fix; a 402 points at the credits page", async () => {
        fetchMock.mockResolvedValue(response(JSON.stringify({ error: "Too big", code: "FILE_TOO_LARGE" }), { status: 413 }));
        const io = fakeIO();
        await expect(sttCommand(config, ["stt", wavFile()], io)).rejects.toMatchObject({ code: 1 });
        expect(io.errText()).toContain("FILE_TOO_LARGE");
        expect(io.errText()).toContain("HTTP 413");
        expect(io.errText()).toContain("25 MB");
        expect(io.out).toHaveLength(0);

        fetchMock.mockReset();
        fetchMock.mockResolvedValue(response(JSON.stringify({ error: "Not enough credits", code: "INSUFFICIENT_CREDITS" }), { status: 402 }));
        const io2 = fakeIO();
        await expect(sttCommand(config, ["stt", wavFile()], io2)).rejects.toBeInstanceOf(ExitSignal);
        expect(io2.errText()).toContain("platform.pinecall.io");
    });

    it("DIARIZE_UNSUPPORTED tells the user to drop the flag or change the model", async () => {
        fetchMock.mockResolvedValue(response(JSON.stringify({ error: "no speakers", code: "DIARIZE_UNSUPPORTED" }), { status: 400 }));
        const io = fakeIO();
        await expect(sttCommand(config, ["stt", wavFile(), "--diarize"], io)).rejects.toBeInstanceOf(ExitSignal);
        expect(io.errText()).toContain("DIARIZE_UNSUPPORTED");
        expect(io.errText()).toContain("--diarize");
    });
});

// ── Stream mode — a local ws server stands in for the voice server ───────

interface Conn {
    ws: WebSocket;
    req: IncomingMessage;
    frames: Array<{ binary: boolean; data: Buffer }>;
    waitFrames(n: number): Promise<void>;
    send(frame: Record<string, unknown>): void;
}

let wss: WebSocketServer;
let httpUrl: string;
let nextConn: ((c: Conn) => void) | null = null;
let connQueue: Conn[] = [];

function rawToBuffer(data: RawData): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data)) return Buffer.concat(data);
    return Buffer.from(data as ArrayBuffer);
}

beforeAll(async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const { port } = wss.address() as AddressInfo;
    httpUrl = `http://127.0.0.1:${port}`;
    wss.on("connection", (ws, req) => {
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
            waitFrames: (n) => frames.length >= n ? Promise.resolve() : new Promise((resolve) => waiters.push({ n, resolve })),
            send: (frame) => ws.send(JSON.stringify(frame)),
        };
        if (nextConn) { const f = nextConn; nextConn = null; f(conn); }
        else connQueue.push(conn);
    });
});

afterAll(async () => {
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
});

function connection(): Promise<Conn> {
    const queued = connQueue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => { nextConn = resolve; });
}

const streamConfig: CliConfig = { ...config, server: "" };

describe("pinecall stt --stream", () => {
    beforeEach(() => {
        connQueue = [];
        nextConn = null;
        streamConfig.server = httpUrl;
    });

    it("refuses when stdin is a terminal and points at the sox line", async () => {
        const io = fakeIO({ stdinTTY: true });
        await expect(sttCommand(streamConfig, ["stt", "--stream"], io)).rejects.toBeInstanceOf(ExitSignal);
        expect(io.errText()).toContain("sox -d -r 16000 -c 1 -b 16 -e signed -t raw - | pinecall stt --stream");
    });

    it("sends stdin PCM as binary frames, prints finals on stdout, partials only on a TTY stderr, and the billing at EOF", async () => {
        const pcm1 = new Uint8Array([1, 2, 3, 4]);
        const pcm2 = new Uint8Array([5, 6]);
        const io = fakeIO({ stderrTTY: true, stdin: [pcm1, pcm2] });

        const run = sttCommand(streamConfig, ["stt", "--stream", "--model", "soniox/stt-rt-v5", "--lang", "es", "--rate", "16000", "--diarize"], io);
        const conn = await connection();

        expect(conn.req.headers.authorization).toBe("Bearer pk_test");
        const url = new URL(conn.req.url!, "http://x");
        expect(url.pathname).toBe("/v1/audio/transcriptions/stream");
        expect(url.searchParams.get("model")).toBe("soniox/stt-rt-v5");
        expect(url.searchParams.get("language")).toBe("es");
        expect(url.searchParams.get("sample_rate")).toBe("16000");
        expect(url.searchParams.get("diarize")).toBe("true");
        expect(url.searchParams.has("api_key")).toBe(false);

        conn.send({ type: "ready", request_id: "req_live", model: "soniox/stt-rt-v5", sample_rate: 16000 });
        // Two binary frames, then the stop frame after stdin EOF.
        await conn.waitFrames(3);
        expect(conn.frames[0]).toEqual({ binary: true, data: Buffer.from(pcm1) });
        expect(conn.frames[1]).toEqual({ binary: true, data: Buffer.from(pcm2) });
        expect(conn.frames[2]!.binary).toBe(false);
        expect(JSON.parse(conn.frames[2]!.data.toString())).toEqual({ type: "stop" });

        conn.send({ type: "partial", text: "hola qu" });
        conn.send({ type: "final", text: "Hola qué tal.", speaker: 0, start: 0, end: 0.9 });
        conn.send({ type: "final", text: "Muy bien.", speaker: "1" });
        conn.send({ type: "done", request_id: "req_live", audio_seconds: 12.4, billed_minutes: 1 });
        conn.ws.close(1000);

        await run;

        expect(io.outText()).toBe("[speaker 0] Hola qué tal.\n[speaker 1] Muy bien.\n");
        const err = io.errText();
        expect(err).toContain("listening");
        expect(err).toContain("soniox/stt-rt-v5");
        expect(err).toContain("hola qu");          // the partial, on the TTY
        expect(err).toContain("12.4 s audio");
        expect(err).toContain("1 min billed");
        expect(err).toContain("req_live");
    });

    it("on a non-TTY stderr partials are dropped and finals are plain lines without --diarize", async () => {
        const io = fakeIO({ stderrTTY: false, stdin: [new Uint8Array([9])] });
        const run = sttCommand(streamConfig, ["stt", "--stream"], io);
        const conn = await connection();
        expect(new URL(conn.req.url!, "http://x").searchParams.has("model")).toBe(false);

        conn.send({ type: "ready", request_id: "r", model: "deepgram/nova-3", sample_rate: 16000 });
        await conn.waitFrames(2);
        conn.send({ type: "partial", text: "secret partial" });
        conn.send({ type: "final", text: "Hello there.", speaker: "0" });
        conn.send({ type: "done", request_id: "r", audio_seconds: 1, billed_minutes: 1 });
        conn.ws.close(1000);
        await run;

        expect(io.outText()).toBe("Hello there.\n");
        expect(io.errText()).not.toContain("secret partial");
    });

    it("Ctrl-C sends stop, stops reading stdin, and still reports the billing", async () => {
        const stdin = manualStdin();
        const io = fakeIO({ stdin: stdin.iter });
        const run = sttCommand(streamConfig, ["stt", "--stream"], io);
        const conn = await connection();
        conn.send({ type: "ready", request_id: "r", model: "deepgram/nova-3", sample_rate: 16000 });

        stdin.push(new Uint8Array([1, 1]));
        await conn.waitFrames(1);
        io.interrupt();
        await conn.waitFrames(2);
        expect(JSON.parse(conn.frames[1]!.data.toString())).toEqual({ type: "stop" });

        // Audio arriving after Ctrl-C is not sent.
        stdin.push(new Uint8Array([2, 2]));
        await new Promise((r) => setTimeout(r, 20));
        expect(conn.frames).toHaveLength(2);

        conn.send({ type: "final", text: "bye" });
        conn.send({ type: "done", request_id: "r", audio_seconds: 0.5, billed_minutes: 1 });
        conn.ws.close(1000);
        await run;
        stdin.end();

        expect(io.outText()).toBe("bye\n");
        expect(io.errText()).toContain("finishing");
        expect(io.errText()).toContain("0.5 s audio");
    });

    it("an error frame fails the command with its code and the fix", async () => {
        const stdin = manualStdin();
        const io = fakeIO({ stdin: stdin.iter });
        const run = sttCommand(streamConfig, ["stt", "--stream", "--diarize"], io);
        const conn = await connection();
        conn.send({ type: "error", code: "DIARIZE_UNSUPPORTED", error: "no speakers on this model" });
        conn.ws.close(1008);

        await expect(run).rejects.toMatchObject({ code: 1 });
        stdin.end();
        expect(io.errText()).toContain("DIARIZE_UNSUPPORTED");
        expect(io.errText()).toContain("no speakers on this model");
        expect(io.errText()).toContain("--diarize");
        expect(io.out).toHaveLength(0);
    });

    it("a server that drops the socket before done is a NETWORK_ERROR", async () => {
        const io = fakeIO({ stdin: manualStdin().iter });
        const run = sttCommand(streamConfig, ["stt", "--stream"], io);
        const conn = await connection();
        conn.send({ type: "ready", request_id: "r", model: "deepgram/nova-3", sample_rate: 16000 });
        conn.ws.close(1011);

        await expect(run).rejects.toBeInstanceOf(ExitSignal);
        expect(io.errText()).toContain("NETWORK_ERROR");
    });

    it("-o is refused in stream mode", async () => {
        const io = fakeIO({ stdin: [] });
        await expect(sttCommand(streamConfig, ["stt", "--stream", "-o", "x.txt"], io)).rejects.toBeInstanceOf(ExitSignal);
        expect(io.errText()).toContain("-o is file mode only");
    });
});

describe("explainSttError", () => {
    it("falls back to the credits fix for any 402 code", () => {
        const s = strip(explainSttError(new AudioApiError("nope", 402, "SOMETHING_ELSE")));
        expect(s).toContain("SOMETHING_ELSE");
        expect(s).toContain("platform.pinecall.io");
    });
    it("has no fix line for an unknown code", () => {
        const s = strip(explainSttError(new AudioApiError("nope", 500, "WEIRD")));
        expect(s).toContain("WEIRD");
        expect(s).not.toContain("→");
    });
});

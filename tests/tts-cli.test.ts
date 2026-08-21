/**
 * CLI — `pinecall tts`.
 *
 * The network is mocked (globalThis.fetch) and so is every process surface
 * the command touches (stdout/stderr/stdin/exit), so what is pinned here is
 * the promise the user sees: bytes land in the file or in a non-TTY stdout
 * and never in a terminal, `--words` prints `start\tend\tword` to stderr,
 * the request body matches the flags, and a refusal becomes code + fix.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ttsCommand, parseTtsArgs, inferFormat, explainAudioError, type TtsIO } from "../src/cli/commands/tts.js";
import { AudioApiError } from "../src/api/audio.js";
import type { CliConfig } from "../src/cli/config.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const enc = new TextEncoder();
const config: CliConfig = { apiKey: "pk_test", server: "https://voice.test", playground: "https://pg.test", json: false };

// ── Fixtures ─────────────────────────────────────────────────────────────

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
    const stream = typeof body === "string" ? chunkedBody([enc.encode(body)]) : body;
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: "",
        headers: new Headers(init.headers ?? {}),
        body: stream,
        text: async () => (typeof body === "string" ? body : ""),
        json: async () => JSON.parse(typeof body === "string" ? body : "{}"),
    } as unknown as Response;
}

function sse(frames: Array<Record<string, unknown> | "[DONE]">): string {
    return frames.map((f) => `data: ${f === "[DONE]" ? "[DONE]" : JSON.stringify(f)}\n\n`).join("");
}

class ExitSignal extends Error {
    constructor(public code: number) { super(`exit ${code}`); }
}

interface FakeIO extends TtsIO {
    out: Uint8Array[];
    err: string[];
    errText(): string;
    outBytes(): Uint8Array;
}

function fakeIO(opts: { stdoutTTY?: boolean; stdin?: string } = {}): FakeIO {
    const out: Uint8Array[] = [];
    const err: string[] = [];
    return {
        out,
        err,
        stdout: {
            isTTY: opts.stdoutTTY ?? false,
            write(chunk: Uint8Array | string) {
                out.push(typeof chunk === "string" ? enc.encode(chunk) : chunk);
                return true;
            },
        },
        stderr: { write(s: string) { err.push(s); return true; } },
        stdinIsTTY: opts.stdin === undefined,
        readStdin: async () => opts.stdin ?? "",
        exit: (code: number) => { throw new ExitSignal(code); },
        errText: () => strip(err.join("")),
        outBytes: () => {
            const total = out.reduce((n, c) => n + c.byteLength, 0);
            const buf = new Uint8Array(total);
            let off = 0;
            for (const c of out) { buf.set(c, off); off += c.byteLength; }
            return buf;
        },
    };
}

let fetchMock: ReturnType<typeof vi.fn>;
let dir: string;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    dir = mkdtempSync(join(tmpdir(), "pinecall-tts-"));
});

afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
});

function requestBody(): Record<string, unknown> {
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    return JSON.parse(init.body as string);
}

// ── Flag parsing ─────────────────────────────────────────────────────────

describe("parseTtsArgs", () => {
    it("reads the text, both flag spellings, and -o", () => {
        const a = parseTtsArgs(["tts", "hola", "mundo", "--voice", "cartesia/ana", "--lang=es", "--model", "elevenlabs/auto",
            "--format", "mp3", "--rate=24000", "-o", "x.mp3", "--words"]);
        expect(a.text).toBe("hola mundo");
        expect(a.voice).toBe("cartesia/ana");
        expect(a.language).toBe("es");
        expect(a.model).toBe("elevenlabs/auto");
        expect(a.format).toBe("mp3");
        expect(a.sampleRate).toBe(24000);
        expect(a.out).toBe("x.mp3");
        expect(a.words).toBe(true);
    });

    it("defaults the voice to elevenlabs/sarah and ignores global flags", () => {
        const a = parseTtsArgs(["tts", "--api-key=pk_x", "--server=https://x", "hola"]);
        expect(a.voice).toBe("elevenlabs/sarah");
        expect(a.text).toBe("hola");
    });

    it("refuses a bad --format or --rate and an unknown flag", () => {
        expect(() => parseTtsArgs(["tts", "hi", "--format", "ogg"])).toThrow(/--format/);
        expect(() => parseTtsArgs(["tts", "hi", "--rate", "8000"])).toThrow(/--rate/);
        expect(() => parseTtsArgs(["tts", "hi", "--loud"])).toThrow(/Unknown flag/);
    });
});

describe("inferFormat", () => {
    it("follows the -o extension unless --format says otherwise", () => {
        expect(inferFormat("a.wav", undefined)).toBe("wav");
        expect(inferFormat("A.MP3", undefined)).toBe("mp3");
        expect(inferFormat("a.raw", undefined)).toBe("pcm");
        expect(inferFormat(undefined, undefined)).toBe("pcm");
        expect(inferFormat("a.wav", "mp3")).toBe("mp3");
    });
});

// ── The command ──────────────────────────────────────────────────────────

describe("pinecall tts", () => {
    it("writes a wav file with -o and sends response_format=wav", async () => {
        const bytes = [enc.encode("RIFF....WAVE"), new Uint8Array([1, 2, 3, 4])];
        fetchMock.mockResolvedValue(response(chunkedBody(bytes), {
            headers: { "content-type": "audio/wav", "x-pinecall-request-id": "req_1", "x-pinecall-characters": "4" },
        }));
        const io = fakeIO({ stdoutTTY: true });
        const file = join(dir, "hola.wav");

        await ttsCommand(config, ["tts", "hola", "-o", file], io);

        expect(readFileSync(file)).toEqual(Buffer.concat(bytes.map((b) => Buffer.from(b))));
        expect(io.out).toHaveLength(0); // nothing on stdout
        const body = requestBody();
        expect(body).toMatchObject({ input: "hola", voice: "elevenlabs/sarah", response_format: "wav" });
        expect(body.timestamps).toBeUndefined();
        const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
        expect(url).toBe("https://voice.test/v1/audio/speech");
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer pk_test");
        const err = io.errText();
        expect(err).toContain("✓");
        expect(err).toContain("4 chars");
        expect(err).toContain("req_1");
    });

    it("infers mp3 from -o *.mp3 and passes voice/model/lang/rate through", async () => {
        fetchMock.mockResolvedValue(response(chunkedBody([new Uint8Array([0xff, 0xfb])]), {
            headers: { "content-type": "audio/mpeg" },
        }));
        const io = fakeIO({ stdoutTTY: true });
        const file = join(dir, "x.mp3");

        await ttsCommand(config, ["tts", "hola", "--voice", "cartesia/ana", "--model", "cartesia/sonic", "--lang", "es", "--rate", "24000", "-o", file], io);

        expect(requestBody()).toMatchObject({
            input: "hola", voice: "cartesia/ana", model: "cartesia/sonic", language: "es", response_format: "mp3", sample_rate: 24000,
        });
        expect(readFileSync(file)).toEqual(Buffer.from([0xff, 0xfb]));
    });

    it("streams raw bytes to a non-TTY stdout when -o is absent", async () => {
        const bytes = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])];
        fetchMock.mockResolvedValue(response(chunkedBody(bytes), {
            headers: { "content-type": "audio/pcm", "x-sample-rate": "16000" },
        }));
        const io = fakeIO({ stdoutTTY: false });

        await ttsCommand(config, ["tts", "hola"], io);

        expect([...io.outBytes()]).toEqual([1, 2, 3, 4, 5]);
        expect(requestBody().response_format).toBe("pcm");
        expect(io.errText()).toContain("stdout");
    });

    it("refuses to dump audio onto a TTY without -o", async () => {
        const io = fakeIO({ stdoutTTY: true });
        await expect(ttsCommand(config, ["tts", "hola"], io)).rejects.toBeInstanceOf(ExitSignal);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(io.out).toHaveLength(0);
        expect(io.errText()).toContain("-o out.wav");
    });

    it("reads the text from stdin when no argument is given", async () => {
        fetchMock.mockResolvedValue(response(chunkedBody([new Uint8Array([9])]), { headers: { "content-type": "audio/wav" } }));
        const io = fakeIO({ stdoutTTY: true, stdin: "hola desde stdin\n" });
        const file = join(dir, "stdin.wav");

        await ttsCommand(config, ["tts", "-o", file], io);

        expect(requestBody().input).toBe("hola desde stdin");
        expect(readFileSync(file)).toEqual(Buffer.from([9]));
    });

    it("with no text anywhere prints usage and exits 1", async () => {
        const io = fakeIO({ stdoutTTY: true, stdin: "   " });
        await expect(ttsCommand(config, ["tts", "-o", "x.wav"], io)).rejects.toBeInstanceOf(ExitSignal);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(io.errText()).toContain("Nothing to say");
    });

    it("--words requests timestamps and prints start\\tend\\tword lines to stderr", async () => {
        const audio = Buffer.from([1, 2, 3, 4]).toString("base64");
        fetchMock.mockResolvedValue(response(sse([
            { type: "start", request_id: "req_sse", format: "pcm", sample_rate: 16000 },
            { type: "audio", data: audio },
            { type: "word", word: "hola", start: 0, end: 0.4 },
            { type: "word", word: "mundo", start: 0.45, end: 0.9 },
            { type: "done", characters: 10, audio_ms: 900 },
            "[DONE]",
        ]), { headers: { "content-type": "text/event-stream" } }));
        const io = fakeIO({ stdoutTTY: true });
        const file = join(dir, "w.pcm");

        await ttsCommand(config, ["tts", "hola mundo", "--words", "-o", file], io);

        expect(requestBody().timestamps).toBe(true);
        const init = fetchMock.mock.calls[0]![1] as RequestInit;
        expect((init.headers as Record<string, string>).Accept).toBe("text/event-stream");
        expect(readFileSync(file)).toEqual(Buffer.from([1, 2, 3, 4]));
        const lines = io.errText().split("\n");
        expect(lines).toContain("0.000\t0.400\thola");
        expect(lines).toContain("0.450\t0.900\tmundo");
        const summary = io.errText();
        expect(summary).toContain("10 chars");
        expect(summary).toContain("900 ms audio");
        expect(summary).toContain("2 words");
        expect(summary).toContain("req_sse");
    });

    it("a 402 before streaming becomes the code plus the credits fix", async () => {
        fetchMock.mockResolvedValue(response(JSON.stringify({ error: "Not enough credits", code: "INSUFFICIENT_CREDITS" }), { status: 402 }));
        const io = fakeIO({ stdoutTTY: true });

        await expect(ttsCommand(config, ["tts", "hola", "-o", join(dir, "no.wav")], io)).rejects.toMatchObject({ code: 1 });
        const err = io.errText();
        expect(err).toContain("INSUFFICIENT_CREDITS");
        expect(err).toContain("HTTP 402");
        expect(err).toContain("platform.pinecall.io");
    });

    it("a BAD_VOICE refusal points at pinecall voices", async () => {
        fetchMock.mockResolvedValue(response(JSON.stringify({ error: "Unknown voice", code: "BAD_VOICE" }), { status: 400 }));
        const io = fakeIO({ stdoutTTY: false });

        await expect(ttsCommand(config, ["tts", "hola"], io)).rejects.toBeInstanceOf(ExitSignal);
        expect(io.errText()).toContain("BAD_VOICE");
        expect(io.errText()).toContain("pinecall voices");
        expect(io.out).toHaveLength(0);
    });

    it("a mid-stream error frame fails the command with its code", async () => {
        fetchMock.mockResolvedValue(response(sse([
            { type: "start", request_id: "r", format: "pcm", sample_rate: 16000 },
            { type: "error", code: "UPSTREAM_ERROR", error: "provider died" },
        ]), { headers: { "content-type": "text/event-stream" } }));
        const io = fakeIO({ stdoutTTY: true });

        await expect(ttsCommand(config, ["tts", "hola", "--words", "-o", join(dir, "e.pcm")], io)).rejects.toBeInstanceOf(ExitSignal);
        expect(io.errText()).toContain("UPSTREAM_ERROR");
        expect(io.errText()).toContain("provider died");
    });
});

describe("explainAudioError", () => {
    it("falls back to the credits fix for any 402 code", () => {
        const s = strip(explainAudioError(new AudioApiError("nope", 402, "SOMETHING_ELSE")));
        expect(s).toContain("SOMETHING_ELSE");
        expect(s).toContain("platform.pinecall.io");
    });
    it("has no fix line for an unknown code", () => {
        const s = strip(explainAudioError(new AudioApiError("nope", 500, "WEIRD")));
        expect(s).toContain("WEIRD");
        expect(s).not.toContain("→");
    });
});

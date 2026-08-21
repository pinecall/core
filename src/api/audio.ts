/**
 * Audio API — standalone text-to-speech, no agent and no call.
 *
 * `POST {apiUrl}/v1/audio/speech` synthesises one utterance and streams the
 * bytes back as they are produced. This client resolves as soon as the
 * response headers arrive, so a desktop app can start playback on the first
 * chunk; the body is never buffered unless the caller asks for it
 * (`arrayBuffer()` / `toFile()`).
 *
 * Two wire modes, one result shape:
 *   - `timestamps: false` (default) → a chunked binary body (`audio/pcm`,
 *     `audio/wav` or `audio/mpeg`) that flows straight into `result.audio`.
 *   - `timestamps: true` → `text/event-stream`; audio frames (base64) are
 *     decoded into `result.audio`, word frames reach `result.words`, the done
 *     frame resolves `result.done`, and an error frame rejects everything.
 *
 * Runs on Node ≥ 18 and in Electron main; `toFile` is the only Node-specific
 * bit and loads `node:fs` lazily so browser bundles are untouched.
 */

import { PinecallError } from "../kernel/errors.js";
import { createSSEParser } from "../sse/parse.js";
import { apiFetch } from "./http.js";
import { mapVoice, type Voice } from "./voices.js";

// ── Types ────────────────────────────────────────────────────────────────

export type SpeechFormat = "pcm" | "wav" | "mp3";

export interface SpeechOptions {
    /** Text to speak — 1..5000 characters. */
    input: string;
    /** `"provider/alias"` (e.g. `"elevenlabs/sarah"`) or a raw provider voice id. */
    voice: string;
    /** `"provider/model"`, `"provider/auto"`, or omitted (auto by language). */
    model?: string;
    /** ISO-639-1 language code, e.g. `"es"`. */
    language?: string;
    /** `"pcm"` (default) | `"wav"` | `"mp3"`. pcm/wav are s16le mono. */
    format?: SpeechFormat;
    /** 16000 (default) | 24000 — pcm/wav sample rate. */
    sampleRate?: 16000 | 24000;
    speed?: number;
    /** Request word timestamps (switches the wire to SSE). */
    timestamps?: boolean;
    /** Abort the request — and the synthesis behind it — from outside. */
    signal?: AbortSignal;
}

export interface SpeechWord {
    word: string;
    /** Seconds from the start of the audio. */
    start: number;
    end: number;
}

export interface SpeechDone {
    /** Characters billed for this request. */
    characters: number;
    /** Audio duration in milliseconds. */
    audioMs: number;
}

export interface SpeechResult {
    requestId: string;
    format: SpeechFormat;
    sampleRate: number;
    channels: 1;
    bitDepth: 16;
    /** Raw audio bytes as they arrive (base64-decoded in SSE mode). Never buffered. */
    audio: ReadableStream<Uint8Array>;
    /** Word timestamps — empty when `timestamps` is off or the provider has none. */
    words: AsyncIterable<SpeechWord>;
    /** Resolves when synthesis finishes; rejects on a mid-stream error or cancel. */
    done: Promise<SpeechDone>;
    /** Abort the request; the server cancels synthesis. */
    cancel(): void;
    /** Drain `audio` into one buffer. */
    arrayBuffer(): Promise<ArrayBuffer>;
    /** Drain `audio` into a file. Node only — `node:fs` is imported lazily. */
    toFile(path: string): Promise<void>;
}

export interface SpeechApiOptions {
    apiKey: string;
    /** Voice server base, e.g. https://voice.pinecall.io (the default). */
    apiUrl?: string;
}

export interface FetchAudioVoicesOptions {
    provider?: string;
    language?: string;
    apiKey?: string;
    apiUrl?: string;
}

// ── Errors ───────────────────────────────────────────────────────────────

/**
 * A refusal from the audio endpoint — before streaming (HTTP status + the
 * server's `code`: BAD_VOICE, INSUFFICIENT_CREDITS, RATE_LIMITED, …) or
 * mid-stream (status 200, the `code` of the error frame). `status` is 0 when
 * the server could not be reached at all.
 */
export class AudioApiError extends PinecallError {
    declare code: string;
    constructor(message: string, public status: number, code: string) {
        super(message, code);
        this.name = "AudioApiError";
    }
}

// ── Wire frames (SSE mode) ───────────────────────────────────────────────

type SpeechFrame =
    | { type: "start"; request_id?: string; format?: string; sample_rate?: number }
    | { type: "audio"; data: string }
    | { type: "word"; word: string; start: number; end: number }
    | { type: "done"; characters?: number; audio_ms?: number }
    | { type: "error"; code?: string; error?: string };

// ── Helpers ──────────────────────────────────────────────────────────────

/** Minimal async queue: push from the network side, iterate from the consumer side. */
class AsyncQueue<T> implements AsyncIterable<T> {
    #items: T[] = [];
    #waiters: Array<{ resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }> = [];
    #closed = false;
    #error: unknown = undefined;

    push(item: T): void {
        if (this.#closed) return;
        const w = this.#waiters.shift();
        if (w) w.resolve({ value: item, done: false });
        else this.#items.push(item);
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const w of this.#waiters.splice(0)) w.resolve({ value: undefined as T, done: true });
    }

    fail(err: unknown): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#error = err;
        for (const w of this.#waiters.splice(0)) w.reject(err);
    }

    [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
            next: () => {
                if (this.#items.length > 0) {
                    return Promise.resolve({ value: this.#items.shift() as T, done: false });
                }
                if (this.#closed) {
                    return this.#error !== undefined
                        ? Promise.reject(this.#error)
                        : Promise.resolve({ value: undefined as T, done: true });
                }
                return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
            },
            return: () => {
                this.#closed = true;
                this.#items = [];
                return Promise.resolve({ value: undefined as T, done: true });
            },
        };
    }
}

function decodeBase64(b64: string): Uint8Array {
    if (typeof Buffer !== "undefined") {
        const buf = Buffer.from(b64, "base64");
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function headerInt(res: Response, name: string): number | undefined {
    const raw = res.headers.get(name);
    if (raw === null || raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
}

function formatFromContentType(ct: string | null, requested: SpeechFormat): SpeechFormat {
    const t = (ct ?? "").toLowerCase();
    if (t.includes("audio/wav") || t.includes("audio/x-wav") || t.includes("audio/wave")) return "wav";
    if (t.includes("audio/mpeg") || t.includes("audio/mp3")) return "mp3";
    if (t.includes("audio/pcm") || t.includes("audio/l16")) return "pcm";
    return requested;
}

/** Byte count → milliseconds for s16le audio; unknown (mp3) → 0. */
function bytesToMs(bytes: number, format: SpeechFormat, sampleRate: number, channels: number, bitDepth: number): number {
    if (format === "mp3") return 0;
    const payload = format === "wav" ? Math.max(0, bytes - 44) : bytes;
    const bytesPerSec = sampleRate * channels * (bitDepth / 8);
    return bytesPerSec > 0 ? Math.round((payload / bytesPerSec) * 1000) : 0;
}

function abortError(): Error {
    const err = new Error("The speech request was aborted");
    err.name = "AbortError";
    return err;
}

async function readError(res: Response): Promise<AudioApiError> {
    let message = `audio/speech: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
    let code = `HTTP_${res.status}`;
    const text = await res.text().catch(() => "");
    if (text) {
        try {
            const body = JSON.parse(text) as { error?: string; code?: string; message?: string };
            if (typeof body.code === "string" && body.code) code = body.code;
            const msg = body.error ?? body.message;
            if (typeof msg === "string" && msg) message = msg;
        } catch {
            message = `${message}: ${text.slice(0, 200)}`;
        }
    }
    return new AudioApiError(message, res.status, code);
}

// ── speech() ─────────────────────────────────────────────────────────────

export async function speech(opts: SpeechOptions & SpeechApiOptions): Promise<SpeechResult> {
    if (!opts.apiKey) {
        throw new AudioApiError("speech() needs an apiKey", 0, "MISSING_KEY");
    }

    // One controller for cancel() and the caller's own signal.
    const ac = new AbortController();
    if (opts.signal) {
        if (opts.signal.aborted) ac.abort(opts.signal.reason);
        else opts.signal.addEventListener("abort", () => ac.abort(opts.signal?.reason), { once: true });
    }

    const requested: SpeechFormat = opts.format ?? "pcm";
    const body: Record<string, unknown> = { input: opts.input, voice: opts.voice };
    if (opts.model !== undefined) body.model = opts.model;
    if (opts.language !== undefined) body.language = opts.language;
    if (opts.format !== undefined) body.response_format = opts.format;
    if (opts.sampleRate !== undefined) body.sample_rate = opts.sampleRate;
    if (opts.speed !== undefined) body.speed = opts.speed;
    if (opts.timestamps !== undefined) body.timestamps = opts.timestamps;

    let res: Response;
    try {
        res = await apiFetch("/v1/audio/speech", {
            apiKey: opts.apiKey,
            apiUrl: opts.apiUrl,
            body,
            signal: ac.signal,
            headers: { Accept: opts.timestamps ? "text/event-stream" : "audio/*" },
        });
    } catch (err) {
        if ((err as Error)?.name === "AbortError") throw err;
        throw new AudioApiError(
            `Cannot reach the voice server: ${(err as Error)?.message ?? err}`,
            0,
            "NETWORK_ERROR",
        );
    }

    if (!res.ok) throw await readError(res);
    if (!res.body) {
        throw new AudioApiError("audio/speech: the response has no body to stream", 0, "NO_BODY");
    }

    const contentType = res.headers.get("content-type");
    const isSSE = (contentType ?? "").toLowerCase().includes("text/event-stream");

    const meta = {
        requestId: res.headers.get("x-pinecall-request-id") ?? "",
        format: formatFromContentType(contentType, requested),
        sampleRate: headerInt(res, "x-sample-rate") ?? opts.sampleRate ?? 16000,
        channels: 1 as const,
        bitDepth: 16 as const,
    };
    const headerChars = headerInt(res, "x-pinecall-characters");
    const headerAudioMs = headerInt(res, "x-pinecall-audio-ms");

    let resolveDone!: (d: SpeechDone) => void;
    let rejectDone!: (e: unknown) => void;
    const done = new Promise<SpeechDone>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
    });
    // A consumer who never awaits `done` must not crash the process on cancel.
    done.catch(() => {});

    const words = new AsyncQueue<SpeechWord>();
    const reader = res.body.getReader();
    let audio: ReadableStream<Uint8Array>;

    if (!isSSE) {
        // ── Binary mode: pull-through, so backpressure reaches the socket ──
        words.close();
        let bytes = 0;
        audio = new ReadableStream<Uint8Array>({
            async pull(controller) {
                let r: ReadableStreamReadResult<Uint8Array>;
                try {
                    r = await reader.read();
                } catch (err) {
                    const e = ac.signal.aborted ? abortError() : err;
                    rejectDone(e);
                    controller.error(e);
                    return;
                }
                if (r.done) {
                    controller.close();
                    resolveDone({
                        characters: headerChars ?? opts.input.length,
                        audioMs: headerAudioMs ?? bytesToMs(bytes, meta.format, meta.sampleRate, meta.channels, meta.bitDepth),
                    });
                    return;
                }
                bytes += r.value.byteLength;
                controller.enqueue(r.value);
            },
            cancel() {
                ac.abort();
                rejectDone(abortError());
            },
        });
    } else {
        // ── SSE mode: pump eagerly — words must flow even if audio is unread ──
        let audioCtrl!: ReadableStreamDefaultController<Uint8Array>;
        audio = new ReadableStream<Uint8Array>({
            start(controller) { audioCtrl = controller; },
            cancel() { ac.abort(); },
        });
        let audioClosed = false;
        let bytes = 0;
        let finished = false;
        let doneFrame: SpeechDone | undefined;

        const closeAudio = () => {
            if (audioClosed) return;
            audioClosed = true;
            try { audioCtrl.close(); } catch { /* already closed */ }
        };
        const failAll = (err: unknown) => {
            if (finished) return;
            finished = true;
            rejectDone(err);
            words.fail(err);
            if (!audioClosed) {
                audioClosed = true;
                try { audioCtrl.error(err); } catch { /* already closed */ }
            }
        };
        const finishAll = () => {
            if (finished) return;
            finished = true;
            closeAudio();
            words.close();
            resolveDone(doneFrame ?? {
                characters: headerChars ?? opts.input.length,
                audioMs: headerAudioMs ?? bytesToMs(bytes, meta.format, meta.sampleRate, meta.channels, meta.bitDepth),
            });
        };

        const parser = createSSEParser(({ data }) => {
            if (finished) return;
            if (data.trim() === "[DONE]") { finishAll(); return; }
            let frame: SpeechFrame;
            try {
                frame = JSON.parse(data) as SpeechFrame;
            } catch {
                return; // not ours — ignore
            }
            switch (frame.type) {
                case "start":
                    if (frame.request_id) meta.requestId = frame.request_id;
                    if (frame.format === "pcm" || frame.format === "wav" || frame.format === "mp3") meta.format = frame.format;
                    if (typeof frame.sample_rate === "number") meta.sampleRate = frame.sample_rate;
                    break;
                case "audio": {
                    if (audioClosed) break;
                    const chunk = decodeBase64(frame.data ?? "");
                    bytes += chunk.byteLength;
                    audioCtrl.enqueue(chunk);
                    break;
                }
                case "word":
                    words.push({ word: frame.word, start: frame.start, end: frame.end });
                    break;
                case "done":
                    doneFrame = {
                        characters: frame.characters ?? headerChars ?? opts.input.length,
                        audioMs: frame.audio_ms ?? bytesToMs(bytes, meta.format, meta.sampleRate, meta.channels, meta.bitDepth),
                    };
                    resolveDone(doneFrame);
                    break;
                case "error":
                    failAll(new AudioApiError(
                        frame.error ?? "audio/speech: synthesis failed",
                        200,
                        frame.code ?? "UPSTREAM_ERROR",
                    ));
                    break;
                default:
                    break;
            }
        });

        void (async () => {
            try {
                for (;;) {
                    const r = await reader.read();
                    if (r.done) break;
                    parser.feed(r.value);
                }
                parser.end();
                // Stream ended without [DONE]: treat a seen done frame as the end,
                // otherwise close what we have.
                finishAll();
            } catch (err) {
                failAll(ac.signal.aborted ? abortError() : err);
            }
        })();
    }

    const result: SpeechResult = {
        get requestId() { return meta.requestId; },
        get format() { return meta.format; },
        get sampleRate() { return meta.sampleRate; },
        channels: 1,
        bitDepth: 16,
        audio,
        words,
        done,
        cancel() {
            ac.abort();
        },
        async arrayBuffer() {
            const chunks: Uint8Array[] = [];
            let total = 0;
            const r = audio.getReader();
            for (;;) {
                const { done: d, value } = await r.read();
                if (d) break;
                chunks.push(value);
                total += value.byteLength;
            }
            const out = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) { out.set(c, off); off += c.byteLength; }
            return out.buffer;
        },
        async toFile(path: string) {
            // Variable specifier: browser bundlers leave it alone.
            const fsSpecifier = "node:fs/promises";
            const fs = (await import(/* @vite-ignore */ fsSpecifier)) as typeof import("node:fs/promises");
            const handle = await fs.open(path, "w");
            const r = audio.getReader();
            try {
                for (;;) {
                    const { done: d, value } = await r.read();
                    if (d) break;
                    await handle.write(value);
                }
            } finally {
                await handle.close();
            }
        },
    };
    return result;
}

// ── voices ───────────────────────────────────────────────────────────────

/** `GET /v1/audio/voices` — the voices `speech()` accepts, optionally filtered. */
export async function fetchAudioVoices(opts: FetchAudioVoicesOptions = {}): Promise<Voice[]> {
    const query: Record<string, string> = {};
    if (opts.provider) query.provider = opts.provider;
    if (opts.language) query.language = opts.language;

    let res: Response;
    try {
        res = await apiFetch("/v1/audio/voices", { apiKey: opts.apiKey, apiUrl: opts.apiUrl, query });
    } catch (err) {
        throw new AudioApiError(
            `Cannot reach the voice server: ${(err as Error)?.message ?? err}`,
            0,
            "NETWORK_ERROR",
        );
    }
    if (!res.ok) throw await readError(res);

    const data = (await res.json().catch(() => ({}))) as { success?: boolean; voices?: unknown[] };
    if (!data.success || !Array.isArray(data.voices)) return [];
    return (data.voices as Record<string, unknown>[]).map(mapVoice(opts.provider ?? "elevenlabs"));
}

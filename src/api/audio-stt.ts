/**
 * Audio API — standalone speech-to-text, no agent and no call.
 *
 * Two endpoints, the batch one and the live one:
 *   - `POST {apiUrl}/v1/audio/transcriptions` — one audio file in (multipart,
 *     OpenAI shape), one transcript out: `json` (text + language + duration),
 *     `verbose_json` (adds words and segments, with speaker labels when
 *     `diarize` is on) or `text` (plain body). `transcribe()`.
 *   - `WS {wsUrl}/v1/audio/transcriptions/stream` — raw PCM frames in,
 *     `partial` / `final` frames out as the speech is recognised, one `done`
 *     frame with the billing at the end. `transcribeStream()`.
 *
 * Auth is the `Authorization: Bearer` header on both — the socket too (Node's
 * `ws` sends headers; the `?api_key=` fallback the server accepts is never used
 * here, a key in a URL ends up in logs). Runs on Node ≥ 18 and in Electron
 * main; `ws` and `node:fs/promises` are imported lazily so a browser bundle
 * that only uses `transcribe()` with bytes never pays for them.
 */

import { TypedEventBus, type EventMap } from "../kernel/event-bus.js";
import { DEFAULT_API_URL } from "./http.js";
import { AudioApiError, AsyncQueue, readError } from "./audio.js";

// ── Types — batch ────────────────────────────────────────────────────────

export type TranscriptionModel =
    | "elevenlabs/scribe_v1"
    | "deepgram/nova-3"
    | "deepgram/nova-2"
    | "soniox/stt-async-preview"
    | (string & {});

export interface TranscribeOptions {
    /** `"provider/model"` or `"provider"`; omitted → `elevenlabs/scribe_v1`. */
    model?: TranscriptionModel;
    /** ISO-639-1 language code; omitted → auto-detect. */
    language?: string;
    /** Label speakers (`words[].speaker`, `segments[].speaker`). Default false. */
    diarize?: boolean;
    /** `"json"` (default) | `"verbose_json"` (words + segments) | `"text"`. */
    format?: "json" | "verbose_json" | "text";
    /** Name sent with the file part — the server infers the container from it. */
    filename?: string;
    /** MIME type of the file part; inferred from `filename` / the path when omitted. */
    contentType?: string;
    /** Abort the request from outside. */
    signal?: AbortSignal;
}

export interface TranscriptWord {
    word: string;
    /** Seconds from the start of the audio. */
    start: number;
    end: number;
    /** Speaker label (`"0"`, `"1"`, …) when diarization is on. */
    speaker?: string;
}

export interface TranscriptSegment {
    id: number;
    start: number;
    end: number;
    text: string;
    speaker?: string;
}

export interface Transcription {
    requestId: string;
    text: string;
    /** Detected or requested language; `""` when the wire had none (`format: "text"`). */
    language: string;
    /** Audio duration in seconds; 0 when the wire had none (`format: "text"`). */
    duration: number;
    /** Only with `format: "verbose_json"`. */
    model?: string;
    words?: TranscriptWord[];
    segments?: TranscriptSegment[];
}

/** Bytes, a `Blob`/`File`, or — Node only — a path to read. */
export type TranscribeInput = Uint8Array | ArrayBuffer | Blob | string;

// ── Types — streaming ────────────────────────────────────────────────────

export type StreamModel =
    | "deepgram/nova-3"
    | "elevenlabs/scribe_v2_realtime"
    | "soniox/stt-rt-v5"
    | (string & {});

export interface TranscribeStreamOptions {
    /** Omitted → `deepgram/nova-3`. */
    model?: StreamModel;
    /** ISO-639-1 language code; omitted → auto-detect. */
    language?: string;
    /** Sample rate of the PCM you write. Default 16000. */
    sampleRate?: 8000 | 16000 | 24000 | 48000;
    /** `"linear16"` (default, s16le mono) | `"mulaw"`. */
    encoding?: "linear16" | "mulaw";
    /** Speaker labels on `final` segments (soniox / deepgram). */
    diarize?: boolean;
}

export interface StreamFinal {
    text: string;
    start?: number;
    end?: number;
    language?: string;
    speaker?: string;
    words?: TranscriptWord[];
}

export interface StreamReady {
    requestId: string;
    model: string;
    sampleRate: number;
}

export interface StreamDone {
    audioSeconds: number;
    billedMinutes: number;
}

export interface TranscribeStreamEvents {
    /** The server accepted the socket and is listening for audio. */
    ready: (info: StreamReady) => void;
    /** Interim hypothesis for the current utterance — replaced by the next one. */
    partial: (text: string) => void;
    /** A committed segment. */
    final: (seg: StreamFinal) => void;
    /** The server finished after `end()` — billing for the session. */
    done: (info: StreamDone) => void;
    /** A refusal (auth, args, upstream) or a socket failure. The stream is over. */
    error: (err: AudioApiError) => void;
    /** The socket closed, with its close code. Always last. */
    close: (code: number) => void;
}

export type TranscribeStreamItem =
    | { type: "partial"; text: string }
    | { type: "final"; segment: StreamFinal };

export interface TranscribeStream {
    /** Set by the `ready` frame; `""` before. */
    readonly requestId: string;
    /** Resolves on `ready`; rejects if the server refuses before that. */
    readonly ready: Promise<void>;
    /** Queue audio bytes. Buffered until `ready`, then sent in order as binary frames. */
    write(chunk: Uint8Array | ArrayBuffer): void;
    /** Ask the server to commit what it has heard so far (a `final` follows). */
    finalize(): void;
    /** No more audio: the server flushes, sends `done` and closes. Resolves on `done`. */
    end(): Promise<StreamDone>;
    /** Drop the socket now (close 1000) without waiting for `done`. */
    close(): void;
    on<K extends keyof TranscribeStreamEvents>(ev: K, fn: TranscribeStreamEvents[K]): this;
    off<K extends keyof TranscribeStreamEvents>(ev: K, fn: TranscribeStreamEvents[K]): this;
    once<K extends keyof TranscribeStreamEvents>(ev: K, fn: TranscribeStreamEvents[K]): this;
    /** `partial` and `final` frames in order; ends on `done`, throws on `error`. */
    [Symbol.asyncIterator](): AsyncIterator<TranscribeStreamItem>;
}

export interface TranscribeApiOptions {
    apiKey: string;
    /** Voice server base, e.g. https://voice.pinecall.io (the default). */
    apiUrl?: string;
}

// ── Wire frames ──────────────────────────────────────────────────────────

interface WireWord { word: string; start: number; end: number; speaker?: string | number }
interface WireSegment { id: number; start: number; end: number; text: string; speaker?: string | number }

interface WireTranscription {
    text?: string;
    language?: string;
    duration?: number;
    model?: string;
    words?: WireWord[];
    segments?: WireSegment[];
}

type StreamFrame =
    | { type: "ready"; request_id?: string; model?: string; sample_rate?: number; encoding?: string; diarize?: boolean }
    | { type: "partial"; text?: string }
    | { type: "final"; text?: string; start?: number; end?: number; language?: string; speaker?: string | number; words?: WireWord[] }
    | { type: "done"; request_id?: string; audio_seconds?: number; billed_minutes?: number }
    | { type: "error"; code?: string; error?: string };

// ── Helpers ──────────────────────────────────────────────────────────────

const MIME_BY_EXT: Record<string, string> = {
    wav: "audio/wav",
    wave: "audio/wav",
    mp3: "audio/mpeg",
    mpga: "audio/mpeg",
    m4a: "audio/mp4",
    mp4: "audio/mp4",
    aac: "audio/aac",
    webm: "audio/webm",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    opus: "audio/ogg",
    flac: "audio/flac",
    pcm: "audio/pcm",
    raw: "audio/pcm",
    mulaw: "audio/basic",
    ulaw: "audio/basic",
};

const EXT_BY_MIME: Record<string, string> = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "audio/flac": "flac",
    "audio/x-flac": "flac",
    "audio/pcm": "pcm",
    "audio/l16": "pcm",
    "audio/basic": "ulaw",
};

function extOf(name: string): string {
    const base = name.split(/[\\/]/).pop() ?? name;
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function basename(path: string): string {
    return path.split(/[\\/]/).pop() || path;
}

function speakerLabel(s: string | number | undefined): string | undefined {
    if (s === undefined || s === null) return undefined;
    return typeof s === "string" ? s : String(s);
}

function mapWord(w: WireWord): TranscriptWord {
    const out: TranscriptWord = { word: w.word, start: w.start, end: w.end };
    const sp = speakerLabel(w.speaker);
    if (sp !== undefined) out.speaker = sp;
    return out;
}

function mapSegment(s: WireSegment): TranscriptSegment {
    const out: TranscriptSegment = { id: s.id, start: s.start, end: s.end, text: s.text };
    const sp = speakerLabel(s.speaker);
    if (sp !== undefined) out.speaker = sp;
    return out;
}

function abortError(): Error {
    const err = new Error("The transcription request was aborted");
    err.name = "AbortError";
    return err;
}

/** Resolve `input` to a Blob plus the filename/content type to send it under. */
async function toFilePart(
    input: TranscribeInput,
    opts: TranscribeOptions,
): Promise<{ blob: Blob; filename: string }> {
    let bytes: Uint8Array | ArrayBuffer | Blob;
    let filename = opts.filename;
    let contentType = opts.contentType;

    if (typeof input === "string") {
        // Variable specifier: browser bundlers leave it alone (same trick as toFile).
        const fsSpecifier = "node:fs/promises";
        const fs = (await import(/* @vite-ignore */ fsSpecifier)) as typeof import("node:fs/promises");
        const buf = await fs.readFile(input);
        bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        filename ??= basename(input);
    } else {
        bytes = input;
        if (!filename && typeof Blob !== "undefined" && input instanceof Blob) {
            const name = (input as { name?: unknown }).name;
            if (typeof name === "string" && name) filename = name;
            if (!contentType && input.type) contentType = input.type;
        }
    }

    // Fill the gaps from each other; `audio.wav` is the last resort.
    if (!contentType && filename) contentType = MIME_BY_EXT[extOf(filename)];
    if (!filename) filename = `audio.${(contentType && EXT_BY_MIME[contentType.split(";")[0].trim().toLowerCase()]) || "wav"}`;
    if (!contentType) contentType = MIME_BY_EXT[extOf(filename)] ?? "audio/wav";

    const blob = bytes instanceof Blob && bytes.type === contentType
        ? bytes
        : new Blob([bytes as BlobPart], { type: contentType });
    return { blob, filename };
}

function mapTranscription(requestId: string, w: WireTranscription): Transcription {
    const out: Transcription = {
        requestId,
        text: typeof w.text === "string" ? w.text : "",
        language: typeof w.language === "string" ? w.language : "",
        duration: typeof w.duration === "number" ? w.duration : 0,
    };
    if (typeof w.model === "string") out.model = w.model;
    if (Array.isArray(w.words)) out.words = w.words.map(mapWord);
    if (Array.isArray(w.segments)) out.segments = w.segments.map(mapSegment);
    return out;
}

// ── transcribe() ─────────────────────────────────────────────────────────

/**
 * `POST /v1/audio/transcriptions` — transcribe one file.
 *
 * `input` is the audio: bytes, a `Blob`/`File`, or (Node only) a path, read
 * lazily through `node:fs/promises`. The content type comes from
 * `contentType`, else the filename / path extension, else `audio/wav`.
 */
export async function transcribe(
    input: TranscribeInput,
    opts: TranscribeOptions & TranscribeApiOptions,
): Promise<Transcription> {
    if (!opts.apiKey) {
        throw new AudioApiError("transcribe() needs an apiKey", 0, "MISSING_KEY");
    }
    if (opts.signal?.aborted) throw abortError();

    const { blob, filename } = await toFilePart(input, opts);
    if (opts.signal?.aborted) throw abortError();

    const form = new FormData();
    form.append("file", blob, filename);
    if (opts.model !== undefined) form.append("model", opts.model);
    if (opts.language !== undefined) form.append("language", opts.language);
    if (opts.diarize !== undefined) form.append("diarize", opts.diarize ? "true" : "false");
    if (opts.format !== undefined) form.append("response_format", opts.format);

    const url = new URL("/v1/audio/transcriptions", opts.apiUrl ?? DEFAULT_API_URL);
    let res: Response;
    try {
        res = await fetch(url.toString(), {
            method: "POST",
            headers: {
                Authorization: `Bearer ${opts.apiKey}`,
                Accept: opts.format === "text" ? "text/plain" : "application/json",
            },
            body: form,
            ...(opts.signal ? { signal: opts.signal } : {}),
        });
    } catch (err) {
        if ((err as Error)?.name === "AbortError") throw err;
        throw new AudioApiError(
            `Cannot reach the voice server: ${(err as Error)?.message ?? err}`,
            0,
            "NETWORK_ERROR",
        );
    }

    if (!res.ok) throw await readError(res, "audio/transcriptions");

    const requestId = res.headers.get("x-pinecall-request-id") ?? "";
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();

    if (opts.format === "text" || contentType.startsWith("text/plain")) {
        const text = await res.text();
        return { requestId, text, language: "", duration: 0 };
    }

    const raw = await res.text();
    let body: WireTranscription;
    try {
        body = JSON.parse(raw) as WireTranscription;
    } catch {
        throw new AudioApiError(
            `audio/transcriptions: the server answered with something that is not JSON: ${raw.slice(0, 200)}`,
            res.status,
            "BAD_RESPONSE",
        );
    }
    return mapTranscription(requestId, body);
}

// ── transcribeStream() ───────────────────────────────────────────────────

const STREAM_PATH = "/v1/audio/transcriptions/stream";

/** Shape of the `ws` default export we need — kept local so `ws` stays a lazy import. */
interface NodeWebSocketLike {
    readyState: number;
    send(data: Uint8Array | string, cb?: (err?: Error) => void): void;
    close(code?: number, reason?: string): void;
    terminate?(): void;
    on(event: "open", fn: () => void): unknown;
    on(event: "message", fn: (data: unknown, isBinary: boolean) => void): unknown;
    on(event: "close", fn: (code: number, reason: unknown) => void): unknown;
    on(event: "error", fn: (err: Error) => void): unknown;
    on(event: "unexpected-response", fn: (req: unknown, res: { statusCode?: number; statusMessage?: string }) => void): unknown;
}

type NodeWebSocketCtor = new (url: string, opts: { headers: Record<string, string> }) => NodeWebSocketLike;

async function loadWS(): Promise<NodeWebSocketCtor> {
    try {
        const mod = await import("ws");
        return mod.default as unknown as NodeWebSocketCtor;
    } catch {
        throw new AudioApiError(
            "transcribeStream() needs the 'ws' package on Node: npm i ws",
            0,
            "NETWORK_ERROR",
        );
    }
}

function streamUrl(apiUrl: string | undefined, opts: TranscribeStreamOptions): string {
    const url = new URL(STREAM_PATH, apiUrl ?? DEFAULT_API_URL);
    url.protocol = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
    if (opts.model !== undefined) url.searchParams.set("model", opts.model);
    if (opts.language !== undefined) url.searchParams.set("language", opts.language);
    if (opts.sampleRate !== undefined) url.searchParams.set("sample_rate", String(opts.sampleRate));
    if (opts.encoding !== undefined) url.searchParams.set("encoding", opts.encoding);
    if (opts.diarize !== undefined) url.searchParams.set("diarize", opts.diarize ? "true" : "false");
    return url.toString();
}

function toBytes(chunk: Uint8Array | ArrayBuffer): Uint8Array {
    return chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
}

function frameToText(data: unknown): string | null {
    if (typeof data === "string") return data;
    if (data instanceof Uint8Array) return new TextDecoder().decode(data);
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
    if (Array.isArray(data)) return data.map((d) => frameToText(d) ?? "").join("");
    return null;
}

// The bus wants an index signature; the public event map stays exact.
type StreamEventMap = TranscribeStreamEvents & EventMap;

class TranscribeStreamImpl extends TypedEventBus<StreamEventMap> implements TranscribeStream {
    #ws: NodeWebSocketLike | null = null;
    #requestId = "";
    #isReady = false;
    #finished = false;       // done, error or close seen — nothing more goes out
    #closedByUser = false;
    #pending: Array<Uint8Array | string> = [];
    #doneInfo: StreamDone | undefined;
    #error: AudioApiError | undefined;

    readonly ready: Promise<void>;
    #resolveReady!: () => void;
    #rejectReady!: (e: unknown) => void;

    #endPromise: Promise<StreamDone> | undefined;
    #resolveEnd: ((d: StreamDone) => void) | undefined;
    #rejectEnd: ((e: unknown) => void) | undefined;

    readonly #items = new AsyncQueue<TranscribeStreamItem>();

    constructor(url: string, apiKey: string) {
        super();
        this.ready = new Promise<void>((resolve, reject) => {
            this.#resolveReady = resolve;
            this.#rejectReady = reject;
        });
        // A caller who never awaits `ready` must not crash the process on a refusal.
        this.ready.catch(() => {});
        void this.#open(url, apiKey);
    }

    get requestId(): string {
        return this.#requestId;
    }

    // ── socket ───────────────────────────────────────────────────────────

    async #open(url: string, apiKey: string): Promise<void> {
        let WS: NodeWebSocketCtor;
        try {
            WS = await loadWS();
        } catch (err) {
            this.#fail(err as AudioApiError);
            return;
        }
        if (this.#closedByUser) {
            this.#settleClose(1000);
            return;
        }
        let ws: NodeWebSocketLike;
        try {
            ws = new WS(url, { headers: { Authorization: `Bearer ${apiKey}` } });
        } catch (err) {
            this.#fail(new AudioApiError(
                `Cannot open the transcription socket: ${(err as Error)?.message ?? err}`,
                0,
                "NETWORK_ERROR",
            ));
            return;
        }
        this.#ws = ws;
        ws.on("open", () => {
            if (this.#closedByUser) ws.close(1000);
        });
        ws.on("message", (data, isBinary) => {
            if (isBinary) return; // the server never sends binary; ignore
            const text = frameToText(data);
            if (text === null) return;
            this.#onFrame(text);
        });
        ws.on("unexpected-response", (_req, res) => {
            // The handshake was refused (401/402/…) before any frame could reach us.
            const status = res?.statusCode ?? 0;
            const code = status === 401 ? "INVALID_KEY"
                : status === 402 ? "SUBSCRIPTION_REQUIRED"
                : status === 429 ? "RATE_LIMITED"
                : `HTTP_${status}`;
            this.#fail(new AudioApiError(
                `audio/transcriptions/stream: HTTP ${status}${res?.statusMessage ? ` ${res.statusMessage}` : ""}`,
                status,
                code,
            ));
            ws.terminate?.();
        });
        ws.on("error", (err) => {
            this.#fail(new AudioApiError(
                `Transcription socket failed: ${err?.message ?? err}`,
                0,
                "NETWORK_ERROR",
            ));
        });
        ws.on("close", (code) => {
            // A dirty close (1006/1011/…) with no error frame before it is a
            // failure; a clean 1000 without `done` is just an early hangup.
            if (!this.#finished && !this.#closedByUser && code !== 1000) {
                this.#fail(new AudioApiError(
                    `The transcription socket closed with code ${code}`,
                    0,
                    "NETWORK_ERROR",
                ), /* emitClose */ false);
            }
            this.#settleClose(code);
        });
    }

    #onFrame(text: string): void {
        if (this.#finished) return;
        let frame: StreamFrame;
        try {
            frame = JSON.parse(text) as StreamFrame;
        } catch {
            return; // not ours — ignore
        }
        switch (frame.type) {
            case "ready": {
                if (frame.request_id) this.#requestId = frame.request_id;
                this.#isReady = true;
                this.#flush();
                this.#resolveReady();
                this.emit("ready", {
                    requestId: this.#requestId,
                    model: frame.model ?? "",
                    sampleRate: typeof frame.sample_rate === "number" ? frame.sample_rate : 16000,
                });
                break;
            }
            case "partial": {
                const t = frame.text ?? "";
                this.#items.push({ type: "partial", text: t });
                this.emit("partial", t);
                break;
            }
            case "final": {
                const seg: StreamFinal = { text: frame.text ?? "" };
                if (typeof frame.start === "number") seg.start = frame.start;
                if (typeof frame.end === "number") seg.end = frame.end;
                if (typeof frame.language === "string") seg.language = frame.language;
                const sp = speakerLabel(frame.speaker);
                if (sp !== undefined) seg.speaker = sp;
                if (Array.isArray(frame.words)) seg.words = frame.words.map(mapWord);
                this.#items.push({ type: "final", segment: seg });
                this.emit("final", seg);
                break;
            }
            case "done": {
                if (frame.request_id && !this.#requestId) this.#requestId = frame.request_id;
                this.#finished = true;
                this.#doneInfo = {
                    audioSeconds: typeof frame.audio_seconds === "number" ? frame.audio_seconds : 0,
                    billedMinutes: typeof frame.billed_minutes === "number" ? frame.billed_minutes : 0,
                };
                this.#items.close();
                this.#resolveEnd?.(this.#doneInfo);
                this.emit("done", this.#doneInfo);
                break;
            }
            case "error": {
                this.#fail(new AudioApiError(
                    frame.error ?? "audio/transcriptions/stream: the server refused",
                    200,
                    frame.code ?? "UPSTREAM_ERROR",
                ));
                break;
            }
            default:
                break;
        }
    }

    /** One failure path: remember it, reject the waiters, emit once. */
    #fail(err: AudioApiError, emitClose = true): void {
        if (this.#finished) return;
        this.#finished = true;
        this.#error = err;
        this.#pending = [];
        this.#rejectReady(err);
        this.#rejectEnd?.(err);
        this.#items.fail(err);
        this.emit("error", err);
        // A socket that never opened emits no `close` of its own.
        if (emitClose && !this.#ws) this.#settleClose(0);
    }

    /** The last word: the iterator ends, whoever still waits on ready/end is told, `close` fires once. */
    #closeEmitted = false;
    #settleClose(code: number): void {
        if (this.#closeEmitted) return;
        this.#closeEmitted = true;
        if (!this.#finished) {
            // Closed before `done` and without an error — by us or by the server.
            this.#finished = true;
            this.#pending = [];
            this.#items.close();
            const err = new AudioApiError(
                this.#closedByUser
                    ? "The transcription stream was closed before done"
                    : "The server closed the transcription stream before done",
                0,
                "CLOSED",
            );
            this.#rejectReady(err);
            this.#rejectEnd?.(err);
        }
        this.emit("close", code);
    }

    #flush(): void {
        const ws = this.#ws;
        if (!ws || !this.#isReady) return;
        for (const item of this.#pending.splice(0)) ws.send(item);
    }

    #send(item: Uint8Array | string): void {
        if (this.#finished) return;
        this.#pending.push(item);
        this.#flush();
    }

    // ── public ───────────────────────────────────────────────────────────

    write(chunk: Uint8Array | ArrayBuffer): void {
        this.#send(toBytes(chunk));
    }

    finalize(): void {
        this.#send(JSON.stringify({ type: "finalize" }));
    }

    end(): Promise<StreamDone> {
        if (this.#endPromise) return this.#endPromise;
        this.#endPromise = new Promise<StreamDone>((resolve, reject) => {
            this.#resolveEnd = resolve;
            this.#rejectEnd = reject;
        });
        this.#endPromise.catch(() => {});
        if (this.#doneInfo) {
            this.#resolveEnd!(this.#doneInfo);
        } else if (this.#error) {
            this.#rejectEnd!(this.#error);
        } else if (this.#finished) {
            this.#rejectEnd!(new AudioApiError("The transcription stream is already closed", 0, "CLOSED"));
        } else {
            this.#send(JSON.stringify({ type: "stop" }));
        }
        return this.#endPromise;
    }

    close(): void {
        if (this.#closedByUser) return;
        this.#closedByUser = true;
        this.#pending = [];
        const ws = this.#ws;
        // CONNECTING (0): closing now would abort the handshake with an error;
        // the `open` handler closes it cleanly instead. Not created yet: #open()
        // settles it. Otherwise close 1000 and let the close handler emit.
        if (ws && ws.readyState !== 0) {
            try { ws.close(1000); } catch { /* already closing */ }
        }
    }

    [Symbol.asyncIterator](): AsyncIterator<TranscribeStreamItem> {
        return this.#items[Symbol.asyncIterator]();
    }
}

/**
 * `WS /v1/audio/transcriptions/stream` — live transcription of PCM you write.
 *
 * Opens the socket immediately; `write()` before `ready` is buffered and sent
 * in order once the server is listening. `end()` tells the server there is no
 * more audio and resolves with the billing on `done`; `close()` hangs up now.
 * Node only (needs `ws` for header auth).
 */
export function transcribeStream(opts: TranscribeStreamOptions & TranscribeApiOptions): TranscribeStream {
    if (!opts.apiKey) {
        throw new AudioApiError("transcribeStream() needs an apiKey", 0, "MISSING_KEY");
    }
    return new TranscribeStreamImpl(streamUrl(opts.apiUrl, opts), opts.apiKey);
}

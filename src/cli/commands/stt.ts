/**
 * CLI — `pinecall stt`
 *
 * Standalone speech-to-text from the terminal: one file, or a live PCM
 * stream, no agent, no call. Thin layer over `transcribe()` and
 * `transcribeStream()` in src/api/audio-stt.ts.
 *
 *   pinecall stt <file> [--model provider/model] [--lang es] [--diarize]
 *                [--format text|json|verbose_json|srt|vtt] [-o out]
 *   sox -d -r 16000 -c 1 -b 16 -e signed -t raw - | pinecall stt --stream [--model deepgram/nova-3]
 *                [--lang es] [--rate 16000] [--diarize]
 *
 * File mode: the transcript (text, JSON, or subtitles) goes to `-o` or to
 * stdout; the summary line (request id, audio seconds, model, elapsed) and
 * errors go to stderr. `srt` / `vtt` / diarized `text` are built client-side
 * from a `verbose_json` answer.
 *
 * Stream mode: raw s16le mono PCM on stdin; partials rewrite one line on
 * stderr (only when stderr is a TTY), every final is one line on stdout
 * (`[speaker N] text` when diarized). stdin EOF or SIGINT → `end()` → the
 * server's `done` (audio seconds, billed minutes) on stderr.
 */

import type { CliConfig } from "../config.js";
import { c } from "../ui.js";
import {
    transcribe,
    transcribeStream,
    AudioApiError,
    type Transcription,
    type TranscriptSegment,
    type StreamFinal,
    type StreamDone,
} from "../../api/audio.js";

// ── Options ──────────────────────────────────────────────────────────────

export type SttFormat = "text" | "json" | "verbose_json" | "srt" | "vtt";
export type SttRate = 8000 | 16000 | 24000 | 48000;

export interface SttArgs {
    /** Audio file path (file mode). */
    file?: string;
    /** `--stream`: raw PCM on stdin. */
    stream: boolean;
    model?: string;
    language?: string;
    diarize: boolean;
    format: SttFormat;
    /** Stream mode only — the sample rate of the PCM on stdin. */
    sampleRate?: SttRate;
    out?: string;
    help: boolean;
}

export const SOX_LINE = "sox -d -r 16000 -c 1 -b 16 -e signed -t raw - | pinecall stt --stream";
export const FFMPEG_LINE = "ffmpeg -f avfoundation -i :0 -ac 1 -ar 16000 -f s16le - | pinecall stt --stream";

const USAGE = `
  ${c.bold("pinecall stt")} ${c.dim("— speech-to-text, no agent, no call")}

  ${c.dim("$")} pinecall stt <file> [--model provider/model] [--lang es] [--diarize]
                 [--format text|json|verbose_json|srt|vtt] [-o out]
  ${c.dim("$")} ${SOX_LINE}
  ${c.dim("$")} ${FFMPEG_LINE}

  ${c.bold("Options")}
    --stream                   ${c.dim("Live mode: raw s16le mono PCM on stdin; finals on stdout, partials on stderr")}
    --model <provider/model>   ${c.dim("File: elevenlabs/scribe_v1 (default), deepgram/nova-3, deepgram/nova-2, soniox/stt-async-preview")}
                               ${c.dim("Stream: deepgram/nova-3 (default), elevenlabs/scribe_v2_realtime, soniox/stt-rt-v5")}
    --lang <code>              ${c.dim("ISO-639-1 language, e.g. es (default: auto-detect)")}
    --diarize                  ${c.dim("Label speakers — [speaker N] per segment / final")}
    --format <f>               ${c.dim("File mode: text (default) | json | verbose_json | srt | vtt")}
    --rate <hz>                ${c.dim("Stream mode: 8000 | 16000 (default) | 24000 | 48000")}
    -o <file>                  ${c.dim("File mode: write the transcript to a file instead of stdout")}

  ${c.dim("The transcript goes to stdout (or -o); the summary and errors go to stderr, so a pipe stays clean.")}
`;

/** `--flag value` or `--flag=value`; returns the value and how many args it consumed. */
function takeValue(argv: string[], i: number, name: string): { value: string; used: number } | null {
    const arg = argv[i]!;
    if (arg === name) {
        const next = argv[i + 1];
        if (next === undefined) return { value: "", used: 1 };
        return { value: next, used: 2 };
    }
    if (arg.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), used: 1 };
    return null;
}

const FORMATS: readonly SttFormat[] = ["text", "json", "verbose_json", "srt", "vtt"];
const RATES: readonly SttRate[] = [8000, 16000, 24000, 48000];

export function parseSttArgs(argv: string[]): SttArgs {
    const out: SttArgs = { stream: false, diarize: false, format: "text", help: false };
    const positional: string[] = [];

    for (let i = 0; i < argv.length;) {
        const arg = argv[i]!;
        let hit: { value: string; used: number } | null;

        if (arg === "--help" || arg === "-h") { out.help = true; i++; continue; }
        if (arg === "--stream") { out.stream = true; i++; continue; }
        if (arg === "--diarize") { out.diarize = true; i++; continue; }
        if ((hit = takeValue(argv, i, "--model"))) { out.model = hit.value || undefined; i += hit.used; continue; }
        if ((hit = takeValue(argv, i, "--lang")) || (hit = takeValue(argv, i, "--language"))) {
            out.language = hit.value || undefined; i += hit.used; continue;
        }
        if ((hit = takeValue(argv, i, "--format"))) {
            const f = hit.value.toLowerCase() as SttFormat;
            if (!FORMATS.includes(f)) {
                throw new Error(`--format must be ${FORMATS.join(", ")} (got "${hit.value}")`);
            }
            out.format = f; i += hit.used; continue;
        }
        if ((hit = takeValue(argv, i, "--rate"))) {
            const n = Number(hit.value) as SttRate;
            if (!RATES.includes(n)) throw new Error(`--rate must be ${RATES.join(", ")} (got "${hit.value}")`);
            out.sampleRate = n; i += hit.used; continue;
        }
        if ((hit = takeValue(argv, i, "-o")) || (hit = takeValue(argv, i, "--out")) || (hit = takeValue(argv, i, "--output"))) {
            out.out = hit.value || undefined; i += hit.used; continue;
        }
        // Global flags the CLI already consumed — skip them here.
        if (arg === "--json" || arg.startsWith("--api-key=") || arg.startsWith("--server=") || arg.startsWith("--playground=")) {
            i++; continue;
        }
        if (arg.startsWith("-") && arg !== "-") throw new Error(`Unknown flag: ${arg}`);
        positional.push(arg);
        i++;
    }

    // The command name itself arrives as the first positional.
    if (positional[0] === "stt") positional.shift();
    if (positional.length > 1) throw new Error(`One file at a time (got ${positional.length})`);
    if (positional[0]) out.file = positional[0];
    return out;
}

// ── Transcript → text / subtitles ────────────────────────────────────────

export interface Cue { start: number; end: number; text: string; speaker?: string }

/** Words per cue when the transcript has words but no segments. */
export const WORDS_PER_CUE = 8;

/** Segments when present, else words in 8-word cues (cut on speaker change too), else one cue for the whole text. */
export function cuesOf(t: Transcription): Cue[] {
    if (t.segments && t.segments.length > 0) {
        return t.segments.map((s) => cueOfSegment(s));
    }
    if (t.words && t.words.length > 0) {
        // Cut every 8 words, and always on a speaker change.
        const cues: Cue[] = [];
        let group: typeof t.words = [];
        const flush = () => {
            if (group.length === 0) return;
            const cue: Cue = {
                start: group[0]!.start,
                end: group[group.length - 1]!.end,
                text: group.map((w) => w.word).join(" ").replace(/\s+/g, " ").trim(),
            };
            if (group[0]!.speaker !== undefined) cue.speaker = group[0]!.speaker;
            cues.push(cue);
            group = [];
        };
        for (const w of t.words) {
            if (group.length >= WORDS_PER_CUE || (group.length > 0 && group[0]!.speaker !== w.speaker)) flush();
            group.push(w);
        }
        flush();
        return cues;
    }
    const text = t.text.trim();
    return text ? [{ start: 0, end: t.duration || 0, text }] : [];
}

function cueOfSegment(s: TranscriptSegment): Cue {
    const cue: Cue = { start: s.start, end: s.end, text: s.text.trim() };
    if (s.speaker !== undefined) cue.speaker = s.speaker;
    return cue;
}

function speakerPrefix(speaker: string | undefined): string {
    return speaker === undefined ? "" : `[speaker ${speaker}] `;
}

/** `HH:MM:SS` + separator + `mmm`. */
function timestamp(seconds: number, sep: "," | "."): string {
    const ms = Math.max(0, Math.round(seconds * 1000));
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    const rest = ms % 1000;
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(rest, 3)}`;
}

export function toSrt(t: Transcription): string {
    return cuesOf(t)
        .map((cue, i) => `${i + 1}\n${timestamp(cue.start, ",")} --> ${timestamp(cue.end, ",")}\n${speakerPrefix(cue.speaker)}${cue.text}\n`)
        .join("\n");
}

export function toVtt(t: Transcription): string {
    const body = cuesOf(t)
        .map((cue) => `${timestamp(cue.start, ".")} --> ${timestamp(cue.end, ".")}\n${speakerPrefix(cue.speaker)}${cue.text}\n`)
        .join("\n");
    return `WEBVTT\n\n${body}`;
}

/** Plain text; with `diarize`, one `[speaker N] …` line per segment (or per cue). */
export function toText(t: Transcription, diarize: boolean): string {
    if (!diarize) return t.text.trimEnd() + "\n";
    const cues = cuesOf(t);
    if (cues.length === 0) return "";
    return cues.map((cue) => `${speakerPrefix(cue.speaker)}${cue.text}`).join("\n") + "\n";
}

/** What the wire has to answer for `format` (+ `diarize`) to be renderable. */
export function wireFormat(format: SttFormat, diarize: boolean): "text" | "json" | "verbose_json" {
    if (format === "srt" || format === "vtt" || format === "verbose_json") return "verbose_json";
    if (format === "text") return diarize ? "verbose_json" : "text";
    return "json";
}

export function render(t: Transcription, format: SttFormat, diarize: boolean): string {
    switch (format) {
        case "text": return toText(t, diarize);
        case "srt": return toSrt(t);
        case "vtt": return toVtt(t);
        case "json":
        case "verbose_json": {
            // The wire object, without the SDK's requestId (it is on stderr).
            const { requestId: _requestId, ...body } = t;
            return JSON.stringify(body, null, 2) + "\n";
        }
    }
}

export function formatFinal(seg: StreamFinal, diarize: boolean): string {
    const text = seg.text.trim();
    return diarize ? `${speakerPrefix(seg.speaker)}${text}` : text;
}

// ── Errors → one line + one fix ──────────────────────────────────────────

const FIXES: Record<string, string> = {
    INSUFFICIENT_CREDITS: "top up credits / upgrade at platform.pinecall.io",
    SUBSCRIPTION_REQUIRED: "top up credits / upgrade at platform.pinecall.io",
    MISSING_KEY: "set PINECALL_API_KEY or pass --api-key=pk_…",
    INVALID_KEY: "check the key — pinecall account keys lists the active ones",
    BAD_MODEL: "file: elevenlabs/scribe_v1, deepgram/nova-3, deepgram/nova-2, soniox/stt-async-preview · stream: deepgram/nova-3, elevenlabs/scribe_v2_realtime, soniox/stt-rt-v5",
    DIARIZE_UNSUPPORTED: "this model has no speaker labels — drop --diarize or pick soniox / deepgram / elevenlabs (file)",
    BAD_REQUEST: "check the flags (--lang is ISO-639-1, --rate 8000|16000|24000|48000)",
    FILE_TOO_LARGE: "max 25 MB — trim or compress the file (mp3/ogg), or split it",
    UNSUPPORTED_MEDIA: "send wav, mp3, m4a, webm, ogg or flac",
    RATE_LIMITED: "wait a moment and retry",
    UPSTREAM_ERROR: "the STT provider failed — retry, or try another --model",
    UPSTREAM_TIMEOUT: "the STT provider timed out — retry, or try a shorter file / another --model",
    NETWORK_ERROR: "is the voice server reachable? (--server=URL, PINECALL_URL)",
    CLOSED: "the stream closed before the server finished — retry",
};

/** `code` + a one-line fix — the CLI is the layer that formats. */
export function explainSttError(err: AudioApiError): string {
    const fix = FIXES[err.code] ?? (err.status === 402 ? FIXES.INSUFFICIENT_CREDITS : undefined);
    const head = `${c.red(err.code)}${err.status ? c.dim(` (HTTP ${err.status})`) : ""} ${err.message}`;
    return fix ? `${head}\n  ${c.dim("→")} ${fix}` : head;
}

// ── I/O seam (tests inject; the CLI uses process.*) ──────────────────────

export interface SttIO {
    stdout: { write(chunk: string): unknown };
    stderr: { write(chunk: string): unknown; isTTY?: boolean };
    /** Raw stdin bytes — only read in stream mode. */
    stdin(): AsyncIterable<Uint8Array>;
    /** Stop reading stdin (the pipe behind it may stay open — e.g. `sox -d`). */
    closeStdin(): void;
    stdinIsTTY: boolean;
    /** Subscribe to SIGINT; returns the unsubscribe. */
    onInterrupt(fn: () => void): () => void;
    /** Write a file (file mode, `-o`). */
    writeFile(path: string, data: string): Promise<void>;
    exit(code: number): never;
}

function processIO(): SttIO {
    return {
        stdout: process.stdout,
        stderr: process.stderr,
        stdinIsTTY: process.stdin.isTTY === true,
        stdin: () => process.stdin as AsyncIterable<Uint8Array>,
        closeStdin: () => { process.stdin.destroy(); },
        onInterrupt: (fn) => {
            process.on("SIGINT", fn);
            return () => { process.off("SIGINT", fn); };
        },
        writeFile: async (path, data) => {
            const fs = await import("node:fs/promises");
            await fs.writeFile(path, data);
        },
        exit: (code) => process.exit(code),
    };
}

// ── Command ──────────────────────────────────────────────────────────────

export async function sttCommand(config: CliConfig, argv: string[], io: SttIO = processIO()): Promise<void> {
    let args: SttArgs;
    try {
        args = parseSttArgs(argv);
    } catch (err) {
        io.stderr.write(`\n  ${c.red("✗")} ${(err as Error).message}\n${USAGE}\n`);
        return io.exit(1);
    }
    if (args.help) { io.stderr.write(USAGE + "\n"); return; }

    if (args.stream) return runStream(config, args, io);

    if (!args.file) {
        io.stderr.write(
            `\n  ${c.red("✗")} Nothing to transcribe — pass an audio file, or ${c.cyan("--stream")} with PCM on stdin.\n${USAGE}\n`,
        );
        return io.exit(1);
    }
    return runFile(config, args, io);
}

async function runFile(config: CliConfig, args: SttArgs, io: SttIO): Promise<void> {
    const started = Date.now();
    let t: Transcription;
    try {
        t = await transcribe(args.file!, {
            apiKey: config.apiKey,
            apiUrl: config.server,
            model: args.model,
            language: args.language,
            diarize: args.diarize || undefined,
            format: wireFormat(args.format, args.diarize),
        });
    } catch (err) {
        return failStt(err, io);
    }

    const body = render(t, args.format, args.diarize);
    try {
        if (args.out) await io.writeFile(args.out, body);
        else io.stdout.write(body);
    } catch (err) {
        return failStt(err, io);
    }

    const elapsed = Date.now() - started;
    const where = args.out ? c.cyan(args.out) : c.dim("stdout");
    const parts = [
        args.format,
        t.duration ? `${t.duration.toFixed(1)} s audio` : undefined,
        t.model ?? args.model,
        t.language || undefined,
        args.diarize ? "diarized" : undefined,
        `${elapsed} ms`,
    ].filter((p): p is string => Boolean(p));
    io.stderr.write(
        `\n  ${c.green("✓")} ${where} ${c.dim("·")} ${parts.join(` ${c.dim("·")} `)}` +
        (t.requestId ? ` ${c.dim(`· ${t.requestId}`)}` : "") + "\n\n",
    );
}

async function runStream(config: CliConfig, args: SttArgs, io: SttIO): Promise<void> {
    if (io.stdinIsTTY) {
        io.stderr.write(
            `\n  ${c.red("✗")} --stream reads raw PCM from stdin, and stdin is a terminal.\n` +
            `  ${c.dim("→")} pipe the microphone in: ${c.cyan(SOX_LINE)}\n${USAGE}\n`,
        );
        return io.exit(1);
    }
    if (args.out) {
        io.stderr.write(`\n  ${c.red("✗")} -o is file mode only — in --stream mode redirect stdout instead.\n${USAGE}\n`);
        return io.exit(1);
    }

    const started = Date.now();
    const stream = transcribeStream({
        apiKey: config.apiKey,
        apiUrl: config.server,
        model: args.model,
        language: args.language,
        sampleRate: args.sampleRate,
        diarize: args.diarize || undefined,
    });

    // Partials rewrite one line on a TTY stderr; on a pipe they are noise.
    const live = io.stderr.isTTY === true;
    let partialShown = false;
    const clearPartial = () => {
        if (!partialShown) return;
        io.stderr.write("\r\x1b[K");
        partialShown = false;
    };

    stream.on("ready", (info) => {
        io.stderr.write(`  ${c.green("●")} listening ${c.dim("·")} ${info.model} ${c.dim("·")} ${info.sampleRate} Hz ${c.dim("· Ctrl-C to finish")}\n`);
    });
    stream.on("partial", (text) => {
        if (!live) return;
        io.stderr.write(`\r\x1b[K  ${c.dim("…")} ${text}`);
        partialShown = true;
    });
    stream.on("final", (seg) => {
        clearPartial();
        const line = formatFinal(seg, args.diarize);
        if (line) io.stdout.write(line + "\n");
    });

    const finished = new Promise<StreamDone>((resolve, reject) => {
        stream.on("done", resolve);
        stream.on("error", reject);
        stream.on("close", () => reject(new AudioApiError("The transcription stream closed before done", 0, "CLOSED")));
    });
    finished.catch(() => {});

    let stopped = false;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        io.closeStdin();
        stream.end().catch(() => {});
    };
    const offInterrupt = io.onInterrupt(() => {
        if (stopped) {
            // Second Ctrl-C: do not wait for the server.
            clearPartial();
            stream.close();
            offInterrupt();
            io.stderr.write(`\n  ${c.yellow("·")} cancelled\n\n`);
            return io.exit(130);
        }
        clearPartial();
        io.stderr.write(`  ${c.dim("… finishing")}\n`);
        stop();
    });

    // Pump stdin into the socket until EOF (or until we were told to stop).
    void (async () => {
        try {
            for await (const chunk of io.stdin()) {
                if (stopped) break;
                stream.write(chunk);
            }
        } catch {
            // stdin destroyed by stop(), or a broken pipe — either way we are done reading.
        }
        stop();
    })();

    let done: StreamDone;
    try {
        done = await finished;
    } catch (err) {
        clearPartial();
        offInterrupt();
        stopped = true;
        io.closeStdin();
        stream.close();
        return failStt(err, io);
    }
    offInterrupt();
    clearPartial();

    const elapsed = Date.now() - started;
    io.stderr.write(
        `\n  ${c.green("✓")} ${done.audioSeconds.toFixed(1)} s audio ${c.dim("·")} ${done.billedMinutes} min billed ` +
        `${c.dim("·")} ${elapsed} ms` + (stream.requestId ? ` ${c.dim(`· ${stream.requestId}`)}` : "") + "\n\n",
    );
}

function failStt(err: unknown, io: SttIO): never {
    if (err instanceof AudioApiError) {
        io.stderr.write(`\n  ${c.red("✗")} ${explainSttError(err)}\n\n`);
        return io.exit(1);
    }
    if ((err as Error)?.name === "AbortError") {
        io.stderr.write(`\n  ${c.yellow("·")} cancelled\n\n`);
        return io.exit(130);
    }
    io.stderr.write(`\n  ${c.red("✗")} ${(err as Error)?.message ?? String(err)}\n\n`);
    return io.exit(1);
}

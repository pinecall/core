/**
 * CLI — `pinecall tts`
 *
 * Standalone text-to-speech from the terminal: one utterance, no agent, no
 * call. Thin layer over `speech()` in src/api/audio.ts — the bytes stream
 * straight from the voice server into a file (`-o`) or into a non-TTY stdout
 * (so `pinecall tts hola --format wav | ffplay -` works).
 *
 *   pinecall tts "<text>" [--voice elevenlabs/sarah] [--model provider/model]
 *                [--lang es] [--format pcm|wav|mp3] [--rate 16000|24000]
 *                [-o out.wav] [--words]
 *   echo hola | pinecall tts -o hola.wav
 *
 * Audio never reaches a terminal: without `-o` on a TTY the command prints
 * usage and refuses. Everything that is not audio (word timestamps, the
 * summary line, errors) goes to stderr, so a pipe stays clean.
 */

import type { CliConfig } from "../config.js";
import { c } from "../ui.js";
import { speech, AudioApiError, type SpeechFormat, type SpeechResult } from "../../api/audio.js";

// ── Options ──────────────────────────────────────────────────────────────

export interface TtsArgs {
    text: string;
    voice: string;
    model?: string;
    language?: string;
    /** Explicit `--format`; when absent, `inferFormat()` decides from `-o`. */
    format?: SpeechFormat;
    sampleRate?: 16000 | 24000;
    out?: string;
    words: boolean;
    help: boolean;
}

export const DEFAULT_VOICE = "elevenlabs/sarah";

const USAGE = `
  ${c.bold("pinecall tts")} ${c.dim("— text-to-speech, no agent, no call")}

  ${c.dim("$")} pinecall tts "<text>" [--voice elevenlabs/sarah] [--model provider/model]
                 [--lang es] [--format pcm|wav|mp3] [--rate 16000|24000]
                 [-o out.wav] [--words]
  ${c.dim("$")} echo hola | pinecall tts -o hola.wav
  ${c.dim("$")} pinecall tts "hola" --format wav | ffplay -nodisp -autoexit -

  ${c.bold("Options")}
    --voice <provider/alias>   ${c.dim(`Voice (default: ${DEFAULT_VOICE}) — pinecall voices to browse`)}
    --model <provider/model>   ${c.dim("TTS model; provider/auto or omit to pick by language")}
    --lang <code>              ${c.dim("ISO-639-1 language, e.g. es")}
    --format pcm|wav|mp3       ${c.dim("Default: wav for -o *.wav, mp3 for *.mp3, else pcm")}
    --rate 16000|24000         ${c.dim("Sample rate for pcm/wav (default: 16000)")}
    -o <file>                  ${c.dim("Write audio to a file; without it, stream to a non-TTY stdout")}
    --words                    ${c.dim("Print word timestamps (start\\tend\\tword) to stderr")}

  ${c.dim("Text comes from the argument or from stdin. Audio is never written to a terminal.")}
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

export function parseTtsArgs(argv: string[]): TtsArgs {
    const out: TtsArgs = { text: "", voice: DEFAULT_VOICE, words: false, help: false };
    const positional: string[] = [];

    for (let i = 0; i < argv.length;) {
        const arg = argv[i]!;
        let hit: { value: string; used: number } | null;

        if (arg === "--help" || arg === "-h") { out.help = true; i++; continue; }
        if (arg === "--words") { out.words = true; i++; continue; }
        if ((hit = takeValue(argv, i, "--voice"))) { out.voice = hit.value || DEFAULT_VOICE; i += hit.used; continue; }
        if ((hit = takeValue(argv, i, "--model"))) { out.model = hit.value || undefined; i += hit.used; continue; }
        if ((hit = takeValue(argv, i, "--lang")) || (hit = takeValue(argv, i, "--language"))) {
            out.language = hit.value || undefined; i += hit.used; continue;
        }
        if ((hit = takeValue(argv, i, "--format"))) {
            const f = hit.value.toLowerCase();
            if (f !== "pcm" && f !== "wav" && f !== "mp3") {
                throw new Error(`--format must be pcm, wav or mp3 (got "${hit.value}")`);
            }
            out.format = f; i += hit.used; continue;
        }
        if ((hit = takeValue(argv, i, "--rate"))) {
            const n = Number(hit.value);
            if (n !== 16000 && n !== 24000) throw new Error(`--rate must be 16000 or 24000 (got "${hit.value}")`);
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
    if (positional[0] === "tts") positional.shift();
    out.text = positional.join(" ").trim();
    return out;
}

/** wav for `*.wav`, mp3 for `*.mp3`, raw pcm for anything else (and for stdout). */
export function inferFormat(out: string | undefined, explicit: SpeechFormat | undefined): SpeechFormat {
    if (explicit) return explicit;
    const lower = (out ?? "").toLowerCase();
    if (lower.endsWith(".wav")) return "wav";
    if (lower.endsWith(".mp3")) return "mp3";
    return "pcm";
}

// ── Errors → one line + one fix ──────────────────────────────────────────

const FIXES: Record<string, string> = {
    INSUFFICIENT_CREDITS: "top up credits / upgrade at platform.pinecall.io",
    SUBSCRIPTION_REQUIRED: "top up credits / upgrade at platform.pinecall.io",
    MISSING_KEY: "set PINECALL_API_KEY or pass --api-key=pk_…",
    INVALID_KEY: "check the key — pinecall account keys lists the active ones",
    BAD_VOICE: "pick one from `pinecall voices --provider=<p>` (e.g. --voice elevenlabs/sarah)",
    BAD_MODEL: "use provider/model, provider/auto, or drop --model to pick by language",
    FORMAT_UNSUPPORTED: "use --format pcm, wav or mp3",
    BAD_REQUEST: "check the text (1..5000 chars) and the flags",
    INPUT_TOO_LONG: "max 5000 characters — split the text",
    RATE_LIMITED: "wait a moment and retry",
    UPSTREAM_ERROR: "the TTS provider failed — retry, or try another voice/model",
    NETWORK_ERROR: "is the voice server reachable? (--server=URL, PINECALL_URL)",
};

/** `code` + a one-line fix — the CLI is the layer that formats. */
export function explainAudioError(err: AudioApiError): string {
    const fix = FIXES[err.code] ?? (err.status === 402 ? FIXES.INSUFFICIENT_CREDITS : undefined);
    const head = `${c.red(err.code)}${err.status ? c.dim(` (HTTP ${err.status})`) : ""} ${err.message}`;
    return fix ? `${head}\n  ${c.dim("→")} ${fix}` : head;
}

// ── I/O seam (tests inject; the CLI uses process.*) ──────────────────────

export interface TtsIO {
    stdout: { write(chunk: Uint8Array | string): unknown; isTTY?: boolean };
    stderr: { write(chunk: string): unknown };
    /** Whole stdin as text — only read when no text argument was given. */
    readStdin(): Promise<string>;
    stdinIsTTY: boolean;
    exit(code: number): never;
}

function processIO(): TtsIO {
    return {
        stdout: process.stdout,
        stderr: process.stderr,
        stdinIsTTY: process.stdin.isTTY === true,
        async readStdin() {
            const chunks: Buffer[] = [];
            for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            return Buffer.concat(chunks).toString("utf8");
        },
        exit: (code) => process.exit(code),
    };
}

// ── Streaming sinks ──────────────────────────────────────────────────────

/** Pipe `audio` into a writable, respecting backpressure when it is a real stream. */
async function pipeToWritable(audio: ReadableStream<Uint8Array>, sink: TtsIO["stdout"]): Promise<void> {
    const reader = audio.getReader();
    const w = sink as { write(chunk: Uint8Array): boolean; once?(ev: "drain", fn: () => void): unknown };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        const ok = w.write(value);
        if (ok === false && typeof w.once === "function") {
            await new Promise<void>((resolve) => w.once!("drain", resolve));
        }
    }
}

async function printWords(result: SpeechResult, io: TtsIO): Promise<number> {
    let n = 0;
    for await (const w of result.words) {
        io.stderr.write(`${w.start.toFixed(3)}\t${w.end.toFixed(3)}\t${w.word}\n`);
        n++;
    }
    return n;
}

// ── Command ──────────────────────────────────────────────────────────────

export async function ttsCommand(config: CliConfig, argv: string[], io: TtsIO = processIO()): Promise<void> {
    let args: TtsArgs;
    try {
        args = parseTtsArgs(argv);
    } catch (err) {
        io.stderr.write(`\n  ${c.red("✗")} ${(err as Error).message}\n${USAGE}\n`);
        return io.exit(1);
    }
    if (args.help) { io.stderr.write(USAGE + "\n"); return; }

    let text = args.text;
    if (!text && !io.stdinIsTTY) text = (await io.readStdin()).trim();
    if (!text) {
        io.stderr.write(`\n  ${c.red("✗")} Nothing to say — pass the text as an argument or pipe it on stdin.\n${USAGE}\n`);
        return io.exit(1);
    }

    // Audio never lands on a terminal.
    if (!args.out && io.stdout.isTTY) {
        io.stderr.write(
            `\n  ${c.red("✗")} stdout is a terminal — audio would be garbage here.\n` +
            `  ${c.dim("→")} write a file with ${c.cyan("-o out.wav")}, or pipe: ${c.cyan("pinecall tts \"…\" --format wav | ffplay -")}\n${USAGE}\n`,
        );
        return io.exit(1);
    }

    const format = inferFormat(args.out, args.format);
    const started = Date.now();

    let result: SpeechResult;
    try {
        result = await speech({
            apiKey: config.apiKey,
            apiUrl: config.server,
            input: text,
            voice: args.voice,
            model: args.model,
            language: args.language,
            format,
            sampleRate: args.sampleRate,
            timestamps: args.words || undefined,
        });
    } catch (err) {
        return failTts(err, io);
    }

    let sink: Promise<void> | undefined;
    try {
        sink = args.out ? result.toFile(args.out) : pipeToWritable(result.audio, io.stdout);
        const wordsDone = args.words ? printWords(result, io) : Promise.resolve(0);
        // In binary mode `done` only resolves once `audio` is drained — the
        // sink above IS the drain, so awaiting all three together is correct.
        const [, wordCount, done] = await Promise.all([sink, wordsDone, result.done]);

        const elapsed = Date.now() - started;
        const where = args.out ? c.cyan(args.out) : c.dim("stdout");
        const audioMs = done.audioMs ? `${done.audioMs} ms audio` : `${format} audio`;
        const wordsNote = args.words ? ` · ${wordCount} words` : "";
        io.stderr.write(
            `\n  ${c.green("✓")} ${where} ${c.dim("·")} ${result.format} ${result.sampleRate} Hz ${c.dim("·")} ` +
            `${done.characters} chars ${c.dim("·")} ${audioMs}${wordsNote} ${c.dim("·")} ${elapsed} ms` +
            (result.requestId ? ` ${c.dim(`· ${result.requestId}`)}` : "") + "\n\n",
        );
    } catch (err) {
        result.cancel();
        // Let the sink settle (the file handle closes) before reporting.
        await sink?.catch(() => {});
        return failTts(err, io);
    }
}

function failTts(err: unknown, io: TtsIO): never {
    if (err instanceof AudioApiError) {
        io.stderr.write(`\n  ${c.red("✗")} ${explainAudioError(err)}\n\n`);
        return io.exit(1);
    }
    if ((err as Error)?.name === "AbortError") {
        io.stderr.write(`\n  ${c.yellow("·")} cancelled\n\n`);
        return io.exit(130);
    }
    io.stderr.write(`\n  ${c.red("✗")} ${(err as Error)?.message ?? String(err)}\n\n`);
    return io.exit(1);
}

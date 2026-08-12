/**
 * play_voice — hear a TTS voice through the machine the MCP server runs on.
 *
 * The stdio transport puts this process on the USER'S machine, next to their
 * speakers, so playing audio locally is legitimate here and nowhere else.
 *
 * The audio is the SAME sample the playground's voice picker plays: the
 * server's `/api/sdk/voice-preview`. Two shapes, decided by the server (see
 * sdk_api.py): providers with a provider-hosted preview clip (elevenlabs,
 * cartesia) expose a `preview_url` on GET /api/sdk/voices — fetching that file
 * is the cheapest correct path and costs no TTS credits; providers without one
 * (rime, xai/grok) are synthesized on demand from `text`. So `text` only
 * changes what you hear on the synth providers — on a preview-clip provider
 * the clip is fixed, and the result says so rather than pretending.
 */

import { z } from "zod";
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool } from "./types.js";
import { fetchVoices, type Voice } from "../../../src/api/voices.js";

/** The sample sentence when the caller gives no `text`. */
export const DEFAULT_TEXT = "Hi, this is a quick sample of my voice. How can I help you today?";

/** Never hold the tool call open longer than this. */
export const PLAY_TIMEOUT_MS = 15_000;

/**
 * Providers the server synthesizes a preview for, because they have no
 * provider-hosted clip. Mirrors `_MANAGED_ENV_KEY` in sdk_api.py.
 */
const SYNTH_PROVIDERS = new Set(["rime", "soniox", "xai", "grok"]);

export interface ParsedVoice {
    provider: string;
    alias: string;
}

/** `"elevenlabs/sarah"` → its two halves. Throws the fix, not a type error. */
export function parseVoiceString(voice: string): ParsedVoice {
    const raw = (voice ?? "").trim();
    const slash = raw.indexOf("/");
    if (slash <= 0 || slash === raw.length - 1) {
        throw new Error(
            `"${raw}" is not a voice string. It must be provider/alias, e.g. "elevenlabs/sarah". ` +
            "Run `list_voices` and copy a row's `voice` field verbatim.",
        );
    }
    return { provider: raw.slice(0, slash).toLowerCase(), alias: raw.slice(slash + 1) };
}

/** Match on alias first, then raw id — both case-insensitively. */
export function resolveVoice(voices: Voice[], alias: string): Voice | null {
    const want = alias.toLowerCase();
    return (
        voices.find((v) => (v.alias ?? "").toLowerCase() === want) ??
        voices.find((v) => v.id.toLowerCase() === want) ??
        null
    );
}

/** A few near misses, so an unknown voice error can suggest instead of only refusing. */
export function suggest(voices: Voice[], alias: string, max = 5): string[] {
    const want = alias.toLowerCase();
    const names = voices.map((v) => v.alias).filter((a): a is string => !!a);
    const near = names.filter((a) => a.includes(want) || want.includes(a));
    return [...new Set([...near, ...names])].slice(0, max);
}

export interface PlayerCommand {
    cmd: string;
    args: string[];
}

function exists(bin: string): boolean {
    const probe = process.platform === "win32" ? "where" : "which";
    return spawnSync(probe, [bin], { stdio: "ignore" }).status === 0;
}

/**
 * The OS player for `file`, or null when the box has none.
 * `has` is injectable so the choice is testable without the binaries.
 */
export function playerCommand(
    platform: NodeJS.Platform,
    file: string,
    has: (bin: string) => boolean = exists,
): PlayerCommand | null {
    if (platform === "darwin") return { cmd: "afplay", args: [file] };
    if (platform === "win32") {
        return {
            cmd: "powershell",
            args: ["-NoProfile", "-Command", `(New-Object Media.SoundPlayer '${file}').PlaySync()`],
        };
    }
    if (has("ffplay")) return { cmd: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet", file] };
    if (has("aplay")) return { cmd: "aplay", args: ["-q", file] };
    if (has("mpg123")) return { cmd: "mpg123", args: ["-q", file] };
    return null;
}

/** File extension for what the server actually sent — the player picks the decoder by it. */
export function extensionFor(contentType: string | null): string {
    const ct = (contentType ?? "").toLowerCase();
    if (ct.includes("wav")) return ".wav";
    if (ct.includes("ogg")) return ".ogg";
    if (ct.includes("webm")) return ".webm";
    if (ct.includes("aac") || ct.includes("mp4")) return ".m4a";
    return ".mp3";
}

export interface PlayOutcome {
    exitCode: number | null;
    durationMs: number;
    timedOut: boolean;
}

/** Runs the player, kills it at `timeoutMs`, and reports how long sound was out. */
export function playFile(cmd: PlayerCommand, timeoutMs = PLAY_TIMEOUT_MS): Promise<PlayOutcome> {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        let timedOut = false;
        const child = spawn(cmd.cmd, cmd.args, { stdio: "ignore" });

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, timeoutMs);

        child.on("error", (err: NodeJS.ErrnoException) => {
            clearTimeout(timer);
            reject(
                err.code === "ENOENT"
                    ? new Error(
                        `No audio player: \`${cmd.cmd}\` is not on this machine's PATH. ` +
                        "Install one (macOS has afplay built in; Linux: ffmpeg for ffplay, or alsa-utils for aplay).",
                    )
                    : err,
            );
        });

        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ exitCode: code, durationMs: Date.now() - started, timedOut });
        });
    });
}

export default defineTool({
    name: "play_voice",
    description:
        "Play a sample of a TTS voice out loud on this machine, so you can pick a `voice` by ear (stdio MCP only).",
    schema: {
        voice: z
            .string()
            .describe("The exact `voice` string from list_voices, e.g. \"elevenlabs/sarah\"."),
        text: z
            .string()
            .max(300)
            .optional()
            .describe(
                "What the voice should say. Only honoured on providers the server synthesizes previews for (rime, xai); a provider-hosted preview clip is fixed.",
            ),
        language: z.string().optional().describe("ISO language code for a synthesized sample, e.g. \"es\"."),
    },
    manual: [
        "**`play_voice`** — hear a voice instead of guessing from its name. Run `list_voices`,",
        "then `play_voice` with a row's `voice` string verbatim; the sample comes out of the",
        "speakers of the machine this server runs on, which is the user's machine on the stdio",
        "transport. Say out loud that you are about to play audio — do not surprise them.",
        "",
        "`text` is only spoken by providers whose preview the server SYNTHESIZES (rime, xai).",
        "ElevenLabs and Cartesia ship a fixed preview clip, which is free and instant; the result",
        "reports `spoken: \"provider preview clip\"` and echoes `textIgnored` so you know why the",
        "words differ from what you asked for.",
        "",
        "**Stdio only.** Over a remote transport this process is not next to any speakers — then",
        "the result carries `played: false` with the `previewUrl`, and you hand that URL to the",
        "user instead of claiming they heard something. Set `PINECALL_MCP_NO_PLAYBACK=1` to force",
        "that mode (headless CI, a shared box). Playback is capped at 15s and the player is killed.",
    ].join("\n"),
    async handler(
        args: { voice: string; text?: string; language?: string },
        { session },
    ) {
        const { provider, alias } = parseVoiceString(args.voice);

        let voices: Voice[];
        try {
            voices = await fetchVoices({ provider, apiUrl: session.serverUrl });
        } catch (err) {
            throw new Error(
                `Could not list ${provider} voices to resolve "${args.voice}": ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
        }

        const voice = resolveVoice(voices, alias);
        if (!voice) {
            const near = suggest(voices, alias);
            throw new Error(
                `Unknown voice "${args.voice}": provider "${provider}" has no voice "${alias}". ` +
                "Run `list_voices` and copy a row's `voice` field verbatim" +
                (near.length ? ` — e.g. ${near.map((n) => `"${provider}/${n}"`).join(", ")}.` : "."),
            );
        }

        const synthesized = SYNTH_PROVIDERS.has(provider);
        const text = args.text ?? DEFAULT_TEXT;

        // ── the bytes ────────────────────────────────────────────────────
        let audioUrl: string;
        let headers: Record<string, string> = {};
        if (synthesized) {
            const q = new URLSearchParams({
                provider,
                voice: voice.id || alias,
                lang: args.language ?? "en",
                text,
            });
            audioUrl = `${session.serverUrl}/api/sdk/voice-preview?${q}`;
            headers = { Authorization: `Bearer ${session.apiKey()}` };
        } else if (voice.previewUrl) {
            audioUrl = voice.previewUrl;
        } else {
            throw new Error(
                `"${args.voice}" has no preview: the server hosts no sample clip for ${provider} ` +
                "and does not synthesize one. Pick a voice from another provider with `list_voices`.",
            );
        }

        const res = await fetch(audioUrl, { headers, redirect: "follow" });
        if (!res.ok) {
            const body = session.redact(await res.text());
            throw new Error(
                `Preview for "${args.voice}" failed: HTTP ${res.status} — ${body}` +
                (/no .* key available/i.test(body)
                    ? ` — ${provider} is BYOK: its previews need your org's own ${provider} key. ` +
                      "Pick a managed provider (elevenlabs, cartesia) with `list_voices`."
                    : ""),
            );
        }
        const bytes = Buffer.from(await res.arrayBuffer());

        const base = {
            voice: `${provider}/${voice.alias ?? voice.id}`,
            name: voice.name,
            spoken: synthesized ? text : "provider preview clip",
            ...(args.text && !synthesized ? { textIgnored: args.text } : {}),
            bytes: bytes.length,
        };

        // A remote transport has no speakers to reach — hand back the URL.
        if (process.env.PINECALL_MCP_NO_PLAYBACK === "1") {
            return {
                ...base,
                played: false,
                reason: "PINECALL_MCP_NO_PLAYBACK=1 — this server is not next to the user's speakers.",
                previewUrl: synthesized ? null : voice.previewUrl,
            };
        }

        // ── play it ──────────────────────────────────────────────────────
        const file = join(tmpdir(), `pinecall-voice-${provider}-${voice.alias ?? voice.id}${extensionFor(res.headers.get("content-type"))}`);
        await writeFile(file, bytes);

        const cmd = playerCommand(process.platform, file);
        if (!cmd) {
            return {
                ...base,
                played: false,
                file,
                reason:
                    `No audio player found on this ${process.platform} machine (tried ffplay, aplay, mpg123). ` +
                    "Install ffmpeg or alsa-utils, or open the file yourself.",
            };
        }

        const outcome = await playFile(cmd, PLAY_TIMEOUT_MS);
        return {
            ...base,
            played: outcome.exitCode === 0 || outcome.timedOut,
            player: cmd.cmd,
            exitCode: outcome.exitCode,
            durationMs: outcome.durationMs,
            ...(outcome.timedOut ? { truncated: true, note: `Stopped at the ${PLAY_TIMEOUT_MS / 1000}s cap.` } : {}),
            file,
        };
    },
});

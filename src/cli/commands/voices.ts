/**
 * CLI — `pinecall voices`
 *
 * Without flags: shows a summary of available providers, voice counts,
 * and languages — plus usage examples. Discovery-first UX.
 *
 * With flags: lists voices for a specific provider/language.
 *
 * Flags:
 *   --provider=<name>   elevenlabs, cartesia, polly
 *   --language=<code>   Filter by language code (en, es, pt, etc.)
 */

import type { CliConfig } from "../config.js";
import { c, table, info, error } from "../ui.js";

interface VoiceEntry {
    id: string;
    name: string;
    alias?: string;
    provider: string;
    gender?: string;
    style?: string;
    languages: { code: string; name: string }[];
    description?: string;
    preview_url?: string;
}

interface VoicesResponse {
    success: boolean;
    voices: VoiceEntry[];
    total: number;
}

function trunc(s: string, max: number): string {
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function shortDesc(name: string): string {
    const dash = name.indexOf(" - ");
    if (dash >= 0) return name.slice(dash + 3);
    const ndash = name.indexOf(" – ");
    if (ndash >= 0) return name.slice(ndash + 3);
    return "";
}

function genderIcon(g?: string): string {
    if (!g) return c.dim("·");
    if (g === "female") return "♀";
    if (g === "male") return "♂";
    return "◆";
}

function autoAlias(name: string, used: Set<string>): string {
    let base = name.split(" - ")[0].split(" – ")[0].trim();
    const parts = base.split(/\s+/);
    if (parts.length > 1 && /^(dr|mr|mrs|ms|prof)\.?$/i.test(parts[0]!)) {
        base = parts[parts.length - 1]!;
    } else {
        base = parts[0] ?? name;
    }
    let alias = base.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!alias) alias = "voice";
    let final = alias;
    let n = 2;
    while (used.has(final)) { final = `${alias}-${n++}`; }
    used.add(final);
    return final;
}

async function fetchVoices(config: CliConfig, provider: string): Promise<VoiceEntry[]> {
    const url = `${config.server}/api/sdk/voices?provider=${encodeURIComponent(provider)}`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) return [];
    const data: VoicesResponse = await res.json();
    return data.voices ?? [];
}

export async function voicesCommand(config: CliConfig, argv: string[]): Promise<void> {
    let provider = "";
    let language = "";
    const positional: string[] = [];

    for (const arg of argv) {
        if (arg.startsWith("--provider=")) provider = arg.slice("--provider=".length);
        else if (arg.startsWith("--language=")) language = arg.slice("--language=".length);
        else if (!arg.startsWith("--") && arg !== "voices") positional.push(arg);
    }

    // ── play subcommand ──────────────────────────────────────────────
    if (positional[0] === "play" && positional[1]) {
        await playVoice(config, positional[1]);
        return;
    }

    // ── No flags → discovery mode ────────────────────────────────────
    if (!provider && !language) {
        const providers = ["elevenlabs", "cartesia"];

        console.log("");
        console.log(`  ${c.bold("Voice Catalog")}`);
        console.log("");

        const headers = ["Provider", "Voices", "Languages"];
        const rows: string[][] = [];

        for (const p of providers) {
            try {
                const voices = await fetchVoices(config, p);
                const langSet = new Set<string>();
                for (const v of voices) {
                    for (const l of v.languages) langSet.add(l.code);
                }
                const langs = [...langSet].sort().join(", ");
                rows.push([
                    c.cyan(p),
                    String(voices.length),
                    langs || c.dim("—"),
                ]);
            } catch {
                rows.push([c.cyan(p), c.dim("offline"), c.dim("—")]);
            }
        }

        table(headers, rows);

        console.log("");
        console.log(`  ${c.bold("Usage")}`);
        console.log("");
        console.log(`  ${c.dim("$")} pinecall voices --provider=elevenlabs`);
        console.log(`  ${c.dim("$")} pinecall voices --provider=elevenlabs --language=es`);
        console.log(`  ${c.dim("$")} pinecall voices play elevenlabs/sarah`);
        console.log("");
        console.log(`  ${c.dim("In your agent:")} voice: ${c.cyan('"elevenlabs/sarah"')}`);
        console.log("");

        return;
    }

    // ── With flags → list voices ─────────────────────────────────────
    if (!provider) provider = "elevenlabs";

    let voices: VoiceEntry[];
    try {
        voices = await fetchVoices(config, provider);
    } catch {
        error(`Cannot reach server at ${config.server}`);
    }

    if (!voices!.length) {
        error(`No voices returned for ${provider}`);
    }

    // Filter by language
    if (language) {
        const lang = language.toLowerCase();
        voices = voices!.filter((v) =>
            v.languages.some((l) => l.code.toLowerCase().startsWith(lang)),
        );
    }

    // Ensure every voice has an alias
    const used = new Set<string>();
    for (const v of voices) { if (v.alias) used.add(v.alias); }
    for (const v of voices) { if (!v.alias) v.alias = autoAlias(v.name, used); }

    if (config.json) {
        console.log(JSON.stringify({ voices, total: voices.length, provider, language: language || undefined }, null, 2));
        return;
    }

    if (voices.length === 0) {
        info(`No voices found for language "${language}" (${provider}).`);
        return;
    }

    voices.sort((a, b) => (a.alias ?? "").localeCompare(b.alias ?? ""));

    console.log("");
    const title = language
        ? `${c.bold(provider)} voices ${c.dim(`(${language})`)}`
        : `${c.bold(provider)} voices`;
    console.log(`  ${title}`);
    console.log("");

    const headers = ["", "Voice", "Description", "Lang"];
    const rows = voices.map((v) => {
        const langs = v.languages.map((l) => l.code).join(",") || c.dim("—");
        const gi = genderIcon(v.gender);
        const voice = c.cyan(`${provider}/${v.alias}`);
        const desc = trunc(shortDesc(v.name) || v.style || "", 38);
        return [gi, voice, desc ? c.dim(desc) : "", langs];
    });

    table(headers, rows);
    info(`${c.bold(String(voices.length))} voices ${c.dim("· pinecall voices play <voice>")}`);
}

// ── Play voice preview ───────────────────────────────────────────────────

async function playVoice(config: CliConfig, voiceRef: string): Promise<void> {
    // Parse "elevenlabs/sarah" or just "sarah" (defaults to elevenlabs)
    let provider: string;
    let alias: string;
    if (voiceRef.includes("/")) {
        [provider, alias] = voiceRef.split("/", 2) as [string, string];
    } else {
        provider = "elevenlabs";
        alias = voiceRef;
    }

    process.stdout.write(`\n  ${c.dim("Fetching voice...")}\r`);

    const voices = await fetchVoices(config, provider);
    if (!voices.length) {
        error(`No voices returned for ${provider}`);
    }

    // Ensure aliases
    const used = new Set<string>();
    for (const v of voices) { if (v.alias) used.add(v.alias); }
    for (const v of voices) { if (!v.alias) v.alias = autoAlias(v.name, used); }

    const voice = voices.find((v) => v.alias === alias);
    if (!voice) {
        error(`Voice "${voiceRef}" not found. Run: pinecall voices --provider=${provider}`);
    }

    if (!voice.preview_url) {
        error(`No preview available for ${voiceRef}`);
    }

    // Voice info card
    const gi = genderIcon(voice.gender);
    const desc = shortDesc(voice.name) || voice.style || "";
    const langs = voice.languages.map((l) => l.code).join(", ") || "—";

    console.log("");
    console.log(`  ${c.purple("▶")} ${c.cyan(`${provider}/${alias}`)}`);
    console.log(`  ${c.dim(voice.name)}`);
    console.log(`  ${gi} ${voice.gender ?? "unknown"} ${c.dim("·")} ${langs}${desc ? ` ${c.dim("·")} ${c.dim(desc)}` : ""}`);
    console.log("");

    // Fetch audio
    process.stdout.write(`  ${c.dim("Downloading...")}\r`);
    const res = await fetch(voice.preview_url);
    if (!res.ok) error(`Failed to fetch preview: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    const { execSync, spawn } = await import("node:child_process");
    const { writeFileSync, unlinkSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tmpFile = join(tmpdir(), `pinecall-preview-${Date.now()}.mp3`);
    writeFileSync(tmpFile, buffer);

    // Get duration via afinfo (macOS)
    let durationSec = 10;
    try {
        const out = execSync(`afinfo "${tmpFile}" 2>/dev/null | grep duration`, { encoding: "utf-8" });
        const match = out.match(/([\d.]+)\s*sec/);
        if (match) durationSec = parseFloat(match[1]!);
    } catch { /* fallback */ }

    // Play with progress bar
    const player = spawn("afplay", [tmpFile], { stdio: "ignore" });
    const barWidth = 30;
    const startTime = Date.now();

    const progressInterval = setInterval(() => {
        const elapsed = (Date.now() - startTime) / 1000;
        const pct = Math.min(elapsed / durationSec, 1);
        const filled = Math.round(pct * barWidth);
        const bar = c.purple("━".repeat(filled)) + c.dim("─".repeat(barWidth - filled));
        const time = `${elapsed.toFixed(1)}s / ${durationSec.toFixed(1)}s`;
        process.stdout.write(`\r  ${bar} ${c.dim(time)}  `);
    }, 100);

    await new Promise<void>((resolve) => {
        player.on("close", () => {
            clearInterval(progressInterval);
            // Final state
            const bar = c.purple("━".repeat(barWidth));
            process.stdout.write(`\r  ${bar} ${c.dim(`${durationSec.toFixed(1)}s`)}  \n`);
            resolve();
        });
        player.on("error", () => {
            clearInterval(progressInterval);
            resolve();
        });
    });

    try { unlinkSync(tmpFile); } catch { /* ignore */ }

    console.log("");
    console.log(`  ${c.dim("Use in your agent:")} voice: ${c.cyan(`"${provider}/${alias}"`)}`);
    console.log("");
}

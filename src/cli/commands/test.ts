/**
 * pinecall test — CLI command
 *
 * Usage:
 *   pinecall test <path>                Run specs in directory or file
 *   pinecall test <path> --verbose      Show full agent responses
 *   pinecall test <path> --grep <pat>   Run only specs matching pattern
 *   pinecall test <path> --agent <id>   Override agent name
 *   pinecall test <path> --list         List specs without running
 *   pinecall test <path> --json         JSON output (for CI)
 */

import type { CliConfig } from "../config.js";
import { c, error } from "../ui.js";
import { loadSpec, discoverSpecs, runSpec } from "./test/runner.js";
import type { SpecResult } from "./test/types.js";

export async function testCommand(config: CliConfig, argv: string[]): Promise<void> {
    // Parse args
    const positional = argv.filter((a) => !a.startsWith("--") && a !== "test");
    const specPath = positional[0];

    if (!specPath) {
        console.log(`
  ${c.purple("⚡")} ${c.bold("pinecall test")} — Run agent specs

  ${c.bold("Usage:")}
    pinecall test <path>              ${c.dim("Run specs (file or directory)")}
    pinecall test <path> --verbose    ${c.dim("Show full responses")}
    pinecall test <path> --grep <p>   ${c.dim("Filter specs by name")}
    pinecall test <path> --agent <id> ${c.dim("Override agent name")}
    pinecall test <path> --judge <p/m>${c.dim("Override judge (e.g. openai/gpt-4.1-nano)")}
    pinecall test <path> --list       ${c.dim("List specs without running")}
    pinecall test <path> --json       ${c.dim("JSON output for CI")}

  ${c.bold("Voice mode")} ${c.dim("(real voice call — judge agent ↔ target agent):")}
    pinecall test <path> --voice <p/v>${c.dim("Judge agent voice, e.g. elevenlabs/professional-male")}
    pinecall test <path> --stt <prov> ${c.dim("Judge agent STT, e.g. flux (default)")}
    pinecall test <path> --record <f> ${c.dim("WAV output path (default <spec>.wav)")}
    pinecall test <path> --no-listen  ${c.dim("Don't auto-open the live browser player")}
    pinecall test <path> --lang <code>${c.dim("Language override (e.g. es)")}
    ${c.dim("The judge is a Pinecall agent (server-rendered voice) bridged to the target.")}
    ${c.dim("Records both voices to WAV + plays live. Needs only PINECALL_API_KEY + judge LLM key.")}

  ${c.bold("Spec format:")} YAML files ending in .spec.yaml

  ${c.bold("Example spec:")}
    ${c.dim("agent: florencia")}
    ${c.dim("description: Date handling")}
    ${c.dim("workflow: |")}
    ${c.dim("  1. Ask what day it is")}
    ${c.dim("  2. Verify the agent says the correct date")}
    ${c.dim("  3. Ask to book for tomorrow")}

  ${c.bold("Judge providers:")}
    anthropic/claude-haiku-4-5-20251001  ${c.dim("(default)")}
    openai/gpt-4.1-nano
    openai/gpt-5.4-nano
    google/gemini-2.5-flash
    deepseek/deepseek-v4-flash
    ollama/<model>                       ${c.dim("(local)")}

  ${c.bold("Environment:")}
    ANTHROPIC_API_KEY    ${c.dim("For Anthropic judge")}
    OPENAI_API_KEY       ${c.dim("For OpenAI judge")}
    GOOGLE_API_KEY       ${c.dim("For Google judge")}
    DEEPSEEK_API_KEY     ${c.dim("For DeepSeek judge")}
`);
        return;
    }

    const verbose = argv.includes("--verbose");
    const json = argv.includes("--json");
    const list = argv.includes("--list");
    const grepIdx = argv.indexOf("--grep");
    const grepPattern = grepIdx !== -1 ? argv[grepIdx + 1] : null;
    const agentIdx = argv.indexOf("--agent");
    const agentOverride = agentIdx !== -1 ? argv[agentIdx + 1] : undefined;
    const judgeIdx = argv.indexOf("--judge");
    const judgeOverride = judgeIdx !== -1 ? argv[judgeIdx + 1] : undefined;

    // ── Voice mode flags ──
    const voiceIdx = argv.indexOf("--voice");
    const voiceSpec = voiceIdx !== -1 ? argv[voiceIdx + 1] : undefined;
    const sttIdx = argv.indexOf("--stt");
    const sttFlag = sttIdx !== -1 ? argv[sttIdx + 1] : undefined;
    const recordIdx = argv.indexOf("--record");
    const recordPath = recordIdx !== -1 ? argv[recordIdx + 1] : undefined;
    const langIdx = argv.indexOf("--lang");
    const langFlag = langIdx !== -1 ? argv[langIdx + 1] : undefined;
    const noListen = argv.includes("--no-listen");
    const voiceFlag = !!voiceSpec;

    // Discover specs
    let specFiles: string[];
    try {
        specFiles = discoverSpecs(specPath);
    } catch (err: any) {
        error(`Cannot read specs: ${err.message}`);
        return;
    }

    if (specFiles.length === 0) {
        error(`No .spec.yaml files found in ${specPath}`);
        return;
    }

    // Load specs
    const specs = specFiles.map((f) => {
        try {
            return loadSpec(f);
        } catch (err: any) {
            console.error(`  ${c.red("✗")} ${f}: ${err.message}`);
            return null;
        }
    }).filter(Boolean) as ReturnType<typeof loadSpec>[];

    // Filter by grep
    const filtered = grepPattern
        ? specs.filter((s) => {
            const name = s._file?.toLowerCase() ?? "";
            const desc = (s.description ?? "").toLowerCase();
            const pat = grepPattern.toLowerCase();
            return name.includes(pat) || desc.includes(pat);
        })
        : specs;

    if (filtered.length === 0) {
        error(`No specs match pattern "${grepPattern}"`);
        return;
    }

    // List mode
    if (list) {
        console.log(`\n  ${c.bold("Specs:")} ${filtered.length} file(s)\n`);
        for (const s of filtered) {
            const file = s._file?.split("/").pop() ?? "unknown";
            console.log(`    ${c.purple(file)}`);
            console.log(`      agent: ${s.agent}  ${c.dim(s.description ?? "")}`);
        }
        console.log();
        return;
    }

    // API key
    if (!config.apiKey) {
        error("PINECALL_API_KEY not set");
        return;
    }

    // Parse judge override (format: provider/model or legacy provider:model)
    let judgeConfig: import("./test/types.js").JudgeConfig | undefined;
    if (judgeOverride) {
        const sep = judgeOverride.includes("/") ? "/" : ":";
        const [provider, ...modelParts] = judgeOverride.split(sep);
        const model = modelParts.join(sep) || undefined;
        judgeConfig = { provider: provider as any, model: model ?? "" };
    }

    // Banner
    const judgeName = judgeOverride
        ? judgeOverride
        : (filtered[0].judge?.provider)
            ? `${filtered[0].judge.provider}/${filtered[0].judge.model}`
            : "anthropic/claude-haiku-4-5";
    // Voice mode setup. A spec runs by voice if it declares `mode: voice` OR
    // the --voice flag is passed (flag wins / forces it). CLI flags override
    // per-spec values.
    const voiceMode = voiceFlag || filtered.some((s) => s.mode === "voice");
    const voiceServer = (config.server || "https://voice.pinecall.io")
        .replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/client$/, "").replace(/\/$/, "");

    if (!json) {
        console.log(`\n  ${c.purple("⚡")} ${c.bold("pinecall test")}${voiceMode ? c.purple(" · voice") : ""}\n`);
        console.log(`  ${c.dim("Agent:")}  ${c.bold(agentOverride ?? filtered[0].agent)}`);
        console.log(`  ${c.dim("Judge:")}  ${judgeName}`);
        if (voiceMode) {
            console.log(`  ${c.dim("Voice:")}  ${voiceSpec ?? filtered[0].voice ?? "elevenlabs/professional-male"} ${c.dim("(tester)")}`);
            console.log(`  ${c.dim("STT:")}    ${normalizeStt(sttFlag ?? filtered[0].stt ?? "deepgram-flux")}`);
            console.log(`  ${c.dim("Listen:")} ${noListen ? "off" : "live (browser player, opens automatically)"} · ${c.dim("recording → WAV")}`);
        }
        console.log(`  ${c.dim("Specs:")}  ${filtered.length} file(s)`);
        console.log(`  ${c.dim("Server:")} ${voiceMode ? voiceServer : (config.server || "wss://voice.pinecall.io")}`);
        console.log();
    }

    // Run specs
    const results: SpecResult[] = [];

    for (const spec of filtered) {
        const fileName = spec._file?.split("/").pop() ?? "unknown";
        // This spec runs by voice if forced by --voice or it declares mode: voice.
        const specVoice = voiceFlag || spec.mode === "voice";

        if (!json) {
            console.log(`  ${c.purple("━━━")} ${fileName} ${c.purple("━━━")}`);
            if (spec.description) console.log(`  ${c.dim(spec.description)}\n`);
        }

        const wavPath = specVoice
            ? (recordPath ?? `${(fileName.replace(/\.spec\.ya?ml$/, "") || "call")}.wav`)
            : "";

        const result = await runSpec(spec, {
            apiKey: config.apiKey,
            server: config.server ? config.server.replace("https://", "wss://").replace("http://", "ws://") + "/client" : undefined,
            verbose,
            agentOverride,
            judgeOverride: judgeConfig,
            log: json ? undefined : (msg) => console.log(msg),
            voice: specVoice ? {
                spec: voiceSpec ?? spec.voice ?? "elevenlabs/professional-male",
                stt: normalizeStt(sttFlag ?? spec.stt ?? "deepgram-flux"),
                server: voiceServer,
                recordPath: wavPath,
                play: !noListen,
                language: langFlag ?? spec.language,
                greeting: spec.greeting,
                detectTurnEnd: spec.detectTurnEnd ?? true,
            } : undefined,
        });

        results.push(result);

        if (!json) {
            const icon = result.passed
                ? `${c.green("✓ PASS")}`
                : `${c.red("✗ FAIL")}`;
            console.log(`\n  ${c.bold("Result:")} ${icon}`);
            console.log(`  ${c.dim(result.summary)}`);
            console.log(`  ${c.dim(`(${(result.durationMs / 1000).toFixed(1)}s, ${result.turns.length} turns)`)}`);
            if (result.recordingPath) {
                console.log(`  ${c.dim("Recording:")} ${result.recordingPath} ${c.dim(`(${result.recordingDuration?.toFixed(1)}s)`)}`);
                console.log(`  ${c.dim("Transcript:")} ${result.recordingPath.replace(/\.wav$/i, "")}.transcript.txt`);
            }
            console.log();
        }

        // Delay between specs
        if (filtered.indexOf(spec) < filtered.length - 1) {
            await new Promise((r) => setTimeout(r, 1000));
        }
    }

    // Summary
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;

    if (json) {
        console.log(JSON.stringify({ passed, failed, results }, null, 2));
    } else {
        console.log(`  ${c.bold("═══ Summary ═══")}`);
        for (const r of results) {
            const icon = r.passed ? c.green("✓") : c.red("✗");
            const file = r.file.split("/").pop();
            console.log(`    ${icon} ${file}  ${c.dim(`${r.turns.length} turns`)}`);
        }
        console.log();
        console.log(`  ${c.green(`${passed} passed`)}${failed > 0 ? `, ${c.red(`${failed} failed`)}` : `, ${c.dim("0 failed")}`}`);
        console.log();
    }

    process.exit(failed > 0 ? 1 : 0);
}

/** Map friendly STT aliases to server provider names. */
function normalizeStt(stt: string): string {
    const map: Record<string, string> = {
        flux: "deepgram-flux",
        "deepgram-flux": "deepgram-flux",
        deepgram: "deepgram",
        nova: "deepgram",
        gladia: "gladia",
        transcribe: "transcribe",
    };
    return map[stt.toLowerCase()] ?? stt;
}

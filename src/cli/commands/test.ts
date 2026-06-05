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
    pinecall test <path> --judge <p:m>${c.dim("Override judge (e.g. openai:gpt-4.1-nano)")}
    pinecall test <path> --list       ${c.dim("List specs without running")}
    pinecall test <path> --json       ${c.dim("JSON output for CI")}

  ${c.bold("Spec format:")} YAML files ending in .spec.yaml

  ${c.bold("Example spec:")}
    ${c.dim("agent: florencia")}
    ${c.dim("description: Date handling")}
    ${c.dim("workflow: |")}
    ${c.dim("  1. Ask what day it is")}
    ${c.dim("  2. Verify the agent says the correct date")}
    ${c.dim("  3. Ask to book for tomorrow")}

  ${c.bold("Judge providers:")}
    anthropic:claude-haiku-4-5-20251001  ${c.dim("(default)")}
    openai:gpt-4.1-nano
    openai:gpt-5.4-nano
    google:gemini-2.5-flash
    deepseek:deepseek-v4-flash
    ollama:<model>                       ${c.dim("(local)")}

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

    // Parse judge override (format: provider:model)
    let judgeConfig: import("./test/types.js").JudgeConfig | undefined;
    if (judgeOverride) {
        const [provider, ...modelParts] = judgeOverride.split(":");
        const model = modelParts.join(":") || undefined;
        judgeConfig = { provider: provider as any, model: model ?? "" };
    }

    // Banner
    const judgeName = judgeOverride
        ? judgeOverride
        : filtered[0].judge
            ? `${filtered[0].judge.provider}:${filtered[0].judge.model}`
            : "anthropic:claude-haiku-4-5";
    if (!json) {
        console.log(`\n  ${c.purple("⚡")} ${c.bold("pinecall test")}\n`);
        console.log(`  ${c.dim("Agent:")}  ${c.bold(agentOverride ?? filtered[0].agent)}`);
        console.log(`  ${c.dim("Judge:")}  ${judgeName}`);
        console.log(`  ${c.dim("Specs:")}  ${filtered.length} file(s)`);
        console.log(`  ${c.dim("Server:")} ${config.server || "wss://voice.pinecall.io"}`);
        console.log();
    }

    // Run specs
    const results: SpecResult[] = [];

    for (const spec of filtered) {
        const fileName = spec._file?.split("/").pop() ?? "unknown";

        if (!json) {
            console.log(`  ${c.purple("━━━")} ${fileName} ${c.purple("━━━")}`);
            if (spec.description) console.log(`  ${c.dim(spec.description)}\n`);
        }

        const result = await runSpec(spec, {
            apiKey: config.apiKey,
            server: config.server ? config.server.replace("https://", "wss://").replace("http://", "ws://") + "/client" : undefined,
            verbose,
            agentOverride,
            judgeOverride: judgeConfig,
            log: json ? undefined : (msg) => console.log(msg),
        });

        results.push(result);

        if (!json) {
            const icon = result.passed
                ? `${c.green("✓ PASS")}`
                : `${c.red("✗ FAIL")}`;
            console.log(`\n  ${c.bold("Result:")} ${icon}`);
            console.log(`  ${c.dim(result.summary)}`);
            console.log(`  ${c.dim(`(${(result.durationMs / 1000).toFixed(1)}s, ${result.turns.length} turns)`)}\n`);
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

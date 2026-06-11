/**
 * pinecall run <file> — execute an agent file with pretty terminal output.
 *
 * Spawns tsx (for .ts) or node (for .js/.mjs) with PINECALL_CLI_RUN=1,
 * which triggers the SDK to auto-attach the runner display (boot banner,
 * live transcript, tool call formatting).
 *
 * The user's file is a complete agent — this just adds the terminal UI.
 */

import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { c, error } from "../ui.js";

const HELP = `
  ${c.bold("pinecall run")} ${c.dim("<file>")}

  Run an agent file with live terminal output.

  ${c.bold("Usage")}
    pinecall run agent.ts          ${c.dim("Run a TypeScript agent")}
    pinecall run server.js         ${c.dim("Run a JavaScript agent")}

  ${c.bold("Requirements")}
    .ts files require ${c.cyan("tsx")} — install with: ${c.dim("npm i -g tsx")}

  ${c.bold("What it does")}
    Executes your agent file and displays:
      ${c.dim("•")} Boot banner with agent name, LLM, voice
      ${c.dim("•")} Live call transcription (caller/agent)
      ${c.dim("•")} Tool calls with formatted results
`;

export async function runCommand(_config: any, argv: string[]): Promise<void> {
    // Find the file argument (first non-flag arg after "run")
    const positional = argv.filter((a) => !a.startsWith("-") && a !== "run");
    const wantsHelp = argv.includes("--help") || argv.includes("-h");

    if (wantsHelp || positional.length === 0) {
        console.log(HELP);
        return;
    }

    const file = resolve(positional[0]!);
    const ext = extname(file);

    // Validate file exists
    if (!existsSync(file)) {
        error(`File not found: ${c.dim(file)}`);
    }

    // Validate extension
    if (![".ts", ".js", ".mjs"].includes(ext)) {
        error(`Unsupported file type: ${c.dim(ext)}\n\n  Supported: .ts, .js, .mjs`);
    }

    // Determine runner
    const useTsx = ext === ".ts";
    const runner = useTsx ? findTsx() : { bin: process.execPath, args: [] };

    if (useTsx && !runner) {
        error(
            `${c.bold("tsx")} is required to run TypeScript files.\n\n` +
            `  Install it globally:\n` +
            `    ${c.cyan("npm i -g tsx")}\n`,
        );
    }

    const { bin, args: runnerArgs } = runner!;

    // Spawn the agent process
    const child = spawn(bin, [...runnerArgs, file], {
        stdio: "inherit",
        env: {
            ...process.env,
            PINECALL_CLI_RUN: "1",
        },
        cwd: resolve(file, ".."),
    });

    child.on("error", (err) => {
        error(`Failed to start: ${err.message}`);
    });

    child.on("exit", (code) => {
        process.exit(code ?? 0);
    });
}

/** Find tsx — returns { bin, args } for spawn. */
function findTsx(): { bin: string; args: string[] } | null {
    // 1. Check global/PATH tsx
    try {
        const path = execSync("which tsx", { encoding: "utf8", stdio: "pipe" }).trim();
        if (path) return { bin: path, args: [] };
    } catch {}

    // 2. Check local node_modules/.bin/tsx
    try {
        const localTsx = resolve("node_modules/.bin/tsx");
        if (existsSync(localTsx)) return { bin: localTsx, args: [] };
    } catch {}

    // 3. Fall back to npx -y tsx (auto-installs if needed)
    return { bin: "npx", args: ["-y", "tsx"] };
}

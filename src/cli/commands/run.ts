/**
 * pinecall run <file> — execute an agent file with pretty terminal output.
 *
 * Spawns tsx (for .ts) or node (for .js/.mjs) with PINECALL_CLI_RUN=1,
 * which triggers the SDK to auto-attach the runner display (boot banner,
 * live transcript, tool call formatting — see src/cli/live-view.ts).
 * `--events` adds PINECALL_RUN_EVENTS=1: every event name + payload summary.
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
    pinecall run agent.ts --events ${c.dim("Also print every event (debug)")}
    pinecall run agent.ts --open   ${c.dim("Open the web console in the browser")}
    pinecall run agent.ts --call +34600000000
                                   ${c.dim("The agent rings that number as soon as it is live")}

  ${c.bold("Flags")}
    --events         ${c.dim("print every agent event name + payload summary (PINECALL_RUN_EVENTS=1)")}
    --no-ui          ${c.dim("do not start the local web console (PINECALL_RUN_UI=0)")}
    --ui-port <n>    ${c.dim("console port, the next 10 are tried if busy (PINECALL_RUN_UI_PORT, default 4747)")}
    --ui-host <h>    ${c.dim("console interface (PINECALL_RUN_UI_HOST, default 127.0.0.1)")}
    --open           ${c.dim("open the console in the default browser on boot (PINECALL_RUN_OPEN=1)")}
    --call <number>  ${c.dim("the agent calls you once it is registered, E.164 (PINECALL_RUN_CALL)")}
    --agent <id>     ${c.dim("which agent `c` and --call talk to, when the file runs several (PINECALL_RUN_AGENT)")}

  ${c.bold("The console")}
    A local web app served by the agent process itself: call the agent from the
    browser (WebRTC), watch every call live, chat by text. It binds 127.0.0.1;
    on any other host every request needs the per-run key printed in the banner.

  ${c.bold("In the terminal")}
    ${c.dim("p")} open the console   ${c.dim("c")} chat with the agent   ${c.dim("e")} every event   ${c.dim("q")} quit
    ${c.dim("`c` opens a `you ›` line under the transcript; the reply arrives as ordinary")}
    ${c.dim("agent events, so the terminal and the web console show the same conversation.")}

  ${c.bold("Requirements")}
    .ts files require ${c.cyan("tsx")} — install with: ${c.dim("npm i -g tsx")}

  ${c.bold("What it does")}
    Executes your agent file and displays:
      ${c.dim("•")} Boot banner with agent name, LLM, voice
      ${c.dim("•")} Live call transcription (caller/agent)
      ${c.dim("•")} Tool calls with formatted results
`;

/** Flags that take a separate value argument. */
const VALUE_FLAGS = ["--ui-port", "--ui-host", "--call", "--agent"];

export async function runCommand(_config: any, argv: string[]): Promise<void> {
    // Find the file argument (first non-flag arg after "run")
    // `--ui-port 4800 agent.ts`: the port is the flag's value, not the file.
    const consumed = new Set<number>();
    for (const flag of VALUE_FLAGS) {
        const at = argv.indexOf(flag);
        if (at !== -1 && argv[at + 1] && !argv[at + 1]!.startsWith("-")) consumed.add(at + 1);
    }
    const positional = argv.filter((a, i) => !a.startsWith("-") && a !== "run" && !consumed.has(i));
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
    const isWin = process.platform === "win32";
    const spawnEnv: NodeJS.ProcessEnv = { ...process.env, PINECALL_CLI_RUN: "1" };
    if (argv.includes("--events")) spawnEnv.PINECALL_RUN_EVENTS = "1";
    // Console flags — the flag wins over the env var the shell already carried.
    if (argv.includes("--no-ui")) spawnEnv.PINECALL_RUN_UI = "0";
    if (argv.includes("--open")) spawnEnv.PINECALL_RUN_OPEN = "1";
    const uiPort = flagValue(argv, "--ui-port");
    if (uiPort) spawnEnv.PINECALL_RUN_UI_PORT = uiPort;
    const uiHost = flagValue(argv, "--ui-host");
    if (uiHost) spawnEnv.PINECALL_RUN_UI_HOST = uiHost;
    // `--call +34…` — the agent rings that number the moment it is registered.
    const callTo = flagValue(argv, "--call");
    if (callTo) spawnEnv.PINECALL_RUN_CALL = callTo;
    const agentId = flagValue(argv, "--agent");
    if (agentId) spawnEnv.PINECALL_RUN_AGENT = agentId;
    const spawnCwd = resolve(file, "..");

    // Spawn the agent process
    // On Windows, .cmd shims (npx, tsx) require shell:true.
    // To avoid DEP0190 (Node 24+), we join into a single command string
    // with proper quoting instead of passing separate args.
    const child = isWin
        ? spawn(
            [bin, ...runnerArgs, file].map(winQuote).join(" "),
            { stdio: "inherit", env: spawnEnv, cwd: spawnCwd, shell: true },
        )
        : spawn(bin, [...runnerArgs, file], {
            stdio: "inherit", env: spawnEnv, cwd: spawnCwd,
        });

    child.on("error", (err) => {
        error(`Failed to start: ${err.message}`);
    });

    child.on("exit", (code) => {
        process.exit(code ?? 0);
    });
}

/** Read `--flag value` or `--flag=value` out of argv. */
export function flagValue(argv: string[], flag: string): string | undefined {
    const eq = argv.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1) || undefined;
    const at = argv.indexOf(flag);
    if (at === -1) return undefined;
    const next = argv[at + 1];
    return next && !next.startsWith("-") ? next : undefined;
}

/** Quote an argument for cmd.exe — wraps in double-quotes if it contains spaces or special chars. */
function winQuote(arg: string): string {
    if (/[\s&|<>^"()]/.test(arg)) return `"${arg}"`;
    return arg;
}

/** Find tsx — returns { bin, args } for spawn. */
function findTsx(): { bin: string; args: string[] } | null {
    const isWin = process.platform === "win32";

    // 1. Check global/PATH tsx
    try {
        const whichCmd = isWin ? "where tsx" : "which tsx";
        const path = execSync(whichCmd, { encoding: "utf8", stdio: "pipe" }).trim();
        // `where` on Windows can return multiple lines — take the first
        const first = path.split(/\r?\n/)[0]!;
        if (first) return { bin: first, args: [] };
    } catch {}

    // 2. Check local node_modules/.bin/tsx
    try {
        const ext = isWin ? ".cmd" : "";
        const localTsx = resolve(`node_modules/.bin/tsx${ext}`);
        if (existsSync(localTsx)) return { bin: localTsx, args: [] };
    } catch {}

    // 3. Fall back to npx -y tsx (auto-installs if needed)
    return { bin: "npx", args: ["-y", "tsx"] };
}

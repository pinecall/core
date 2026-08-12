/**
 * pinecall mcp — the Pinecall MCP server, and one command to wire it into every IDE.
 *
 * Usage:
 *   pinecall mcp                     Run the stdio MCP server (what a host launches)
 *   pinecall mcp install             Install into every detected assistant
 *   pinecall mcp install cursor      Install into named platforms only
 *   pinecall mcp install --remove    Uninstall
 *   pinecall mcp install --list      Show what is detected, change nothing
 *
 * No API key is ever written into a config file — the MCP server reads
 * PINECALL_API_KEY from the environment its host launches it in.
 */

import { spawn } from "node:child_process";
import { apply, detect } from "../install/apply.js";
import { PACKAGE, PLATFORMS } from "../install/platforms.js";
import { render, renderDetected } from "../install/render.js";
import { c, error } from "../ui.js";

const HELP = `
  ${c.purple("⚡")} ${c.bold("pinecall mcp")} — Pinecall as an MCP server

  ${c.bold("Usage:")}
    ${c.dim("$")} pinecall mcp                    ${c.dim("Run the stdio server (hosts launch this)")}
    ${c.dim("$")} pinecall mcp install            ${c.dim("Wire it into every assistant found here")}
    ${c.dim("$")} pinecall mcp install <platform> ${c.dim("Only the ones you name")}
    ${c.dim("$")} pinecall mcp install --list     ${c.dim("Show what is detected, change nothing")}
    ${c.dim("$")} pinecall mcp install --remove   ${c.dim("Take the pinecall entry back out")}

  ${c.bold("Platforms:")}
${Object.entries(PLATFORMS)
    .map(([k, p]) => `    ${c.cyan(k.padEnd(13))}${c.dim(`~/${p.path}`)}`)
    .join("\n")}

  ${c.bold("Notes")}
    ${c.dim("Each config is backed up to <file>.bak before it is written.")}
    ${c.dim("Re-running repairs a drifted entry — it never adds a second one.")}
    ${c.dim("The key is NOT written to any config:")} ${c.cyan("PINECALL_API_KEY")} ${c.dim("comes from the environment.")}
`;

export async function mcpCommand(args: string[]): Promise<void> {
    const rest = args.slice(args.indexOf("mcp") + 1);
    const sub = rest.find((a) => !a.startsWith("-"));

    if (rest.includes("--help") || rest.includes("-h")) {
        console.log(HELP);
        return;
    }

    if (!sub) return runServer();

    if (sub !== "install" && sub !== "uninstall") {
        error(`Unknown subcommand: ${sub}\n\n  Run ${c.dim("pinecall mcp --help")} for usage.`);
    }

    const flags = rest.filter((a) => a.startsWith("-"));
    const platforms = rest.filter((a) => !a.startsWith("-") && a !== sub);
    const remove = sub === "uninstall" || flags.includes("--remove");

    if (flags.includes("--list")) {
        console.log(renderDetected(detect()));
        return;
    }

    try {
        console.log(render(apply({ platforms, remove }), remove));
    } catch (err) {
        error((err as Error).message);
    }
}

/**
 * Run the MCP server itself.
 *
 * The server is its own package (@pinecall/mcp) so the SDK does not carry the
 * MCP dependency tree; `npx -y` is exactly what the installed config entries
 * launch, so `pinecall mcp` and a host's own launch are the same code path.
 * stdio is inherited whole — stdout IS the protocol.
 */
function runServer(): Promise<void> {
    return new Promise((resolve) => {
        const child = spawn("npx", ["-y", PACKAGE], { stdio: "inherit", shell: process.platform === "win32" });
        child.on("error", (err) => {
            console.error(`\n  ${c.red("✗")} Cannot launch ${PACKAGE}: ${err.message}\n`);
            process.exit(1);
        });
        child.on("exit", (code) => {
            resolve();
            process.exit(code ?? 0);
        });
    });
}

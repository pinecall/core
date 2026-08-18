/**
 * CLI — `pinecall chat [agent]`
 *
 * Interactive text chat with a connected agent via llm.chat WebSocket protocol.
 * If no agent specified, lists available agents and prompts selection.
 *
 * Slash commands:
 *   /reset   — start a new conversation
 *   /quit    — exit
 *   /clear   — clear screen
 */

import type { CliConfig } from "../config.js";
import { ChatClient, type ToolCallInfo } from "../../api/chat-client.js";
import { c, error, info } from "../ui.js";
import { createInterface } from "node:readline";

// ── Types ────────────────────────────────────────────────────────────────

interface AgentEntry {
    slug: string;
    channels: Record<string, { count: number; refs: string[] }>;
}

interface AgentsResponse {
    success: boolean;
    agents: AgentEntry[];
    total: number;
}

// ── Fetch agents ─────────────────────────────────────────────────────────

async function fetchAgents(config: CliConfig): Promise<AgentEntry[]> {
    const res = await fetch(`${config.server}/api/sdk/agents`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) return [];
    const data: AgentsResponse = await res.json();
    return data.agents ?? [];
}

// ── Main command ─────────────────────────────────────────────────────────

export async function chatCommand(config: CliConfig, argv: string[]): Promise<void> {
    // Extract agent from positional args
    const positional = argv.filter((a) => !a.startsWith("--") && a !== "chat");
    let agentId = positional[0] ?? "";

    // If no agent specified, list available and prompt
    if (!agentId) {
        process.stdout.write(`\n  ${c.dim("Fetching agents...")}\r`);
        const agents = await fetchAgents(config);

        if (agents.length === 0) {
            error("No agents connected. Deploy an agent first, then try again.");
        }

        if (agents.length === 1) {
            agentId = agents[0]!.slug;
        } else {
            console.log("");
            console.log(`  ${c.bold("Connected agents:")}`);
            console.log("");
            agents.forEach((a, i) => {
                const channels = Object.keys(a.channels).join(", ");
                console.log(`  ${c.bold(String(i + 1))}. ${c.cyan(a.slug)} ${c.dim(`(${channels})`)}`);
            });
            console.log("");

            const rl = createInterface({ input: process.stdin, output: process.stdout });
            const answer = await new Promise<string>((resolve) => {
                rl.question(`  ${c.dim("Select agent")} [1]: `, (ans) => {
                    rl.close();
                    resolve(ans.trim());
                });
            });

            const idx = (parseInt(answer) || 1) - 1;
            if (idx < 0 || idx >= agents.length) {
                error("Invalid selection.");
            }
            agentId = agents[idx]!.slug;
        }
    }

    // Connect
    process.stdout.write(`\n  ${c.dim("Connecting to")} ${c.cyan(agentId)}${c.dim("...")}\r`);
    const client = new ChatClient({
        // The client speaks WebSocket; `--server` is an HTTP base.
        server: config.server.replace(/^http:/, "ws:").replace(/^https:/, "wss:") + "/client",
        apiKey: config.apiKey,
        agentId,
        sessionPrefix: "chat-",
    });

    // EventEmitter throws on an unheard "error" — a mid-session server error
    // has never printed anything here, and must not start crashing the REPL.
    client.on("error", () => { /* connect() already reported the fatal ones */ });

    try {
        await client.connect();
    } catch (err: any) {
        error(`Failed to connect: ${err.message}`);
    }

    // State
    let model = "";
    let currentResponse = "";
    let responding = false;
    let promptShown = false;

    const agentLabel = c.cyan(agentId);
    const userLabel = c.green("you");

    // Header
    console.log(`  ${c.purple("⚡")} Connected to ${agentLabel}                        `);
    console.log(`  ${c.dim("Type a message or /quit to exit. /reset for new conversation.")}`);
    console.log("");

    // Handle incoming events
    client.on("started", ({ model: m }: { model?: string }) => {
        model = m || "";
        if (model && !promptShown) {
            // Update header with model info (only first time)
            promptShown = true;
        }
    });

    client.on("token", ({ token }: { token: string }) => {
        if (!responding) {
            // First token — print agent label
            responding = true;
            currentResponse = "";
            process.stdout.write(`  ${agentLabel} ${c.dim("›")} `);
        }
        currentResponse += token;
        process.stdout.write(token);
    });

    client.on("done", ({ text }: { text: string }) => {
        if (responding) {
            // End of streaming
            console.log("");
        } else {
            // Non-streamed response
            console.log(`  ${agentLabel} ${c.dim("›")} ${text ?? ""}`);
        }
        responding = false;
        currentResponse = "";
        // Show prompt again
        showPrompt();
    });

    client.on("tool_call", ({ tools }: { tools: ToolCallInfo[] }) => {
        // End current streaming line if active
        if (responding) {
            console.log("");
            responding = false;
        }
        for (const tc of tools) {
            let argsStr = tc.arguments;
            try {
                argsStr = JSON.stringify(JSON.parse(tc.arguments), null, 0);
            } catch { /* keep raw */ }
            console.log(`  ${c.dim("      ┌")} ${c.yellow("tool:")} ${tc.name}(${c.dim(argsStr)})`);
        }
    });

    client.on("tool_result", ({ result }: { result: string }) => {
        let resultStr = result ?? "";
        try {
            const parsed = JSON.parse(resultStr);
            resultStr = JSON.stringify(parsed, null, 0);
        } catch { /* keep raw */ }
        const short = resultStr.length > 80 ? resultStr.slice(0, 77) + "..." : resultStr;
        console.log(`  ${c.dim("      └")} ${c.dim(short)}`);
    });

    client.on("chat_error", ({ error: err }: { error?: string }) => {
        if (responding) { console.log(""); responding = false; }
        console.log(`  ${c.red("✗")} ${err ?? "Unknown error"}`);
        showPrompt();
    });

    // REPL
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
    });

    function showPrompt(): void {
        rl.setPrompt(`  ${userLabel} ${c.dim("›")} `);
        rl.prompt();
    }

    showPrompt();

    rl.on("line", (line) => {
        const input = line.trim();
        if (!input) { showPrompt(); return; }

        // Slash commands
        if (input === "/quit" || input === "/exit" || input === "/q") {
            console.log(`\n  ${c.dim("Disconnected.")}\n`);
            client.close();
            rl.close();
            process.exit(0);
        }

        if (input === "/reset" || input === "/new") {
            client.resetSession();
            console.log(`  ${c.dim("Session reset. Starting fresh conversation.")}`);
            console.log("");
            showPrompt();
            return;
        }

        if (input === "/clear") {
            console.clear();
            console.log(`  ${c.purple("⚡")} ${agentLabel}${model ? ` ${c.dim(`(${model})`)}` : ""}`);
            console.log("");
            showPrompt();
            return;
        }

        if (input.startsWith("/")) {
            console.log(`  ${c.dim("Commands: /reset /clear /quit")}`);
            showPrompt();
            return;
        }

        // Send message
        client.sendMessage(input);
    });

    rl.on("close", () => {
        client.close();
        process.exit(0);
    });

    // Keep process alive
    process.on("SIGINT", () => {
        console.log(`\n  ${c.dim("Disconnected.")}\n`);
        client.close();
        process.exit(0);
    });
}

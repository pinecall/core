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
import { c, error, info } from "../ui.js";
import { createInterface } from "node:readline";
import WebSocket from "ws";

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

interface ToolCallData {
    id: string;
    name: string;
    arguments: string;
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

// ── Chat Client ──────────────────────────────────────────────────────────

class ChatClient {
    private ws: WebSocket | null = null;
    private sessionId: string | null = null;
    private pingTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private server: string,
        private apiKey: string,
        private agentId: string,
    ) {}

    async connect(): Promise<void> {
        // HTTP → WS URL
        const wsUrl = this.server
            .replace(/^http:/, "ws:")
            .replace(/^https:/, "wss:")
            + "/client";

        return new Promise((resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            this.ws = ws;

            const timeout = setTimeout(() => {
                reject(new Error("Connection timeout (10s)"));
                ws.close();
            }, 10000);

            ws.on("open", () => {
                ws.send(JSON.stringify({
                    event: "connect",
                    api_key: this.apiKey,
                }));
            });

            ws.on("message", (raw: Buffer) => {
                try {
                    const data = JSON.parse(raw.toString());
                    if (data.event === "connected") {
                        clearTimeout(timeout);
                        this.startPing();
                        resolve();
                    } else if (data.event === "error") {
                        clearTimeout(timeout);
                        reject(new Error(data.error || "Connection rejected"));
                    } else if (data.event === "ping") {
                        ws.send(JSON.stringify({ event: "pong" }));
                    }
                } catch { /* ignore non-JSON */ }
            });

            ws.on("error", (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
    }

    onMessage(handler: (data: any) => void): void {
        this.ws?.on("message", (raw: Buffer) => {
            try { handler(JSON.parse(raw.toString())); } catch { /* ignore */ }
        });
    }

    send(text: string): string {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("Not connected");
        }
        if (!this.sessionId) {
            this.sessionId = "chat-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
        }
        this.ws.send(JSON.stringify({
            event: "llm.chat",
            session_id: this.sessionId,
            agent_id: this.agentId,
            text: text.trim(),
        }));
        return this.sessionId;
    }

    resetSession(): void {
        this.sessionId = null;
    }

    close(): void {
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.ws?.close();
        this.ws = null;
    }

    private startPing(): void {
        this.pingTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ event: "ping" }));
            }
        }, 30000);
    }
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
    const client = new ChatClient(config.server, config.apiKey, agentId);

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

    // Handle incoming messages
    client.onMessage((data) => {
        switch (data.event) {
            case "llm.chat.started":
                model = data.model || "";
                if (model && !promptShown) {
                    // Update header with model info (only first time)
                    promptShown = true;
                }
                break;

            case "llm.chat.token": {
                const token = data.token ?? "";
                if (!responding) {
                    // First token — print agent label
                    responding = true;
                    currentResponse = "";
                    process.stdout.write(`  ${agentLabel} ${c.dim("›")} `);
                }
                currentResponse += token;
                process.stdout.write(token);
                break;
            }

            case "llm.chat.done": {
                if (responding) {
                    // End of streaming
                    console.log("");
                } else {
                    // Non-streamed response
                    console.log(`  ${agentLabel} ${c.dim("›")} ${data.text ?? ""}`);
                }
                responding = false;
                currentResponse = "";
                // Show prompt again
                showPrompt();
                break;
            }

            case "llm.chat.tool_call": {
                // End current streaming line if active
                if (responding) {
                    console.log("");
                    responding = false;
                }
                const tools: ToolCallData[] = data.tool_calls ?? [];
                for (const tc of tools) {
                    let argsStr = tc.arguments;
                    try {
                        argsStr = JSON.stringify(JSON.parse(tc.arguments), null, 0);
                    } catch { /* keep raw */ }
                    console.log(`  ${c.dim("      ┌")} ${c.yellow("tool:")} ${tc.name}(${c.dim(argsStr)})`);
                }
                break;
            }

            case "llm.chat.tool_result": {
                let resultStr = data.result ?? data.text ?? "";
                try {
                    const parsed = JSON.parse(resultStr);
                    resultStr = JSON.stringify(parsed, null, 0);
                } catch { /* keep raw */ }
                const short = resultStr.length > 80 ? resultStr.slice(0, 77) + "..." : resultStr;
                console.log(`  ${c.dim("      └")} ${c.dim(short)}`);
                break;
            }

            case "llm.chat.error":
                if (responding) { console.log(""); responding = false; }
                console.log(`  ${c.red("✗")} ${data.error ?? "Unknown error"}`);
                showPrompt();
                break;

            case "ping":
                // Server ping — handled by client
                break;
        }
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
        client.send(input);
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

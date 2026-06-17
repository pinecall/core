/**
 * Runner — auto-attach display for `pinecall run`.
 *
 * When PINECALL_CLI_RUN=1, the Pinecall constructor calls attachRunner()
 * which hooks into agent creation and call lifecycle to display a
 * beautiful terminal UI:
 *
 *   ⚡ booting nova  ·  gpt-4.1-mini · cartesia/sonic
 *   ☎ listening on +1 415 555 0177 …
 *
 *   ☎  incoming call — connecting…
 *   caller › Hey, where's my order?
 *   nova   › Happy to check — what's the order number?
 *   caller › It's 48213.
 *           ⚡ lookupOrder({ id: "48213" })
 *           → shipped · UPS · ETA today 5:00pm
 */

import type { Agent } from "./domain/agent.js";
import type { Call } from "./domain/call.js";
import type { ToolCallEvent, ToolCallItem } from "./protocol/events.js";

// ── ANSI helpers (inline — zero deps) ────────────────────────────────────

const hasTTY = process.stdout.isTTY !== false && process.env.NO_COLOR === undefined;
const esc = (open: string, close: string) =>
    hasTTY ? (s: string) => `${open}${s}${close}` : (s: string) => s;

const dim    = esc("\x1b[2m", "\x1b[22m");
const bold   = esc("\x1b[1m", "\x1b[22m");
const green  = esc("\x1b[32m", "\x1b[39m");
const cyan   = esc("\x1b[36m", "\x1b[39m");
const purple = esc("\x1b[35m", "\x1b[39m");
const yellow = esc("\x1b[33m", "\x1b[39m");
const red    = esc("\x1b[31m", "\x1b[39m");

// ── Short model names ────────────────────────────────────────────────────

function shortModel(llm: string | Record<string, unknown> | undefined): string {
    if (!llm) return "default";
    if (typeof llm === "object") {
        const model = (llm as any).model || (llm as any).provider || "custom";
        return String(model);
    }
    // "openai/gpt-4.1-mini" → "gpt-4.1-mini"
    return llm.includes("/") ? llm.split("/").pop()! : llm;
}

function shortVoice(voice: string | Record<string, unknown> | undefined): string {
    if (!voice) return "default";
    if (typeof voice === "object") {
        const provider = (voice as any).provider || "custom";
        return String(provider);
    }
    // "cartesia/sonic" → "cartesia/sonic" (keep full for voice, it's short enough)
    return voice;
}



// ── Runner attach ────────────────────────────────────────────────────────

/**
 * Called from Pinecall constructor when PINECALL_CLI_RUN=1.
 * Returns a function that should be called each time an agent is created.
 */
export function attachRunner(): (agent: Agent) => void {
    return (agent: Agent) => {
        attachAgentDisplay(agent);
    };
}

function attachAgentDisplay(agent: Agent): void {
    const config = agent.getConfig();
    const model = shortModel(config.llm);
    const voice = shortVoice(config.voice);

    // Get phone from registered channels (phoneNumber is stripped from config by client.ts)
    let phone = "";
    for (const [_key, ch] of agent._getChannels()) {
        if (ch.type === "phone" && ch.ref) {
            phone = ch.ref;
            break;
        }
    }

    // ── Boot banner ──────────────────────────────────────────────────
    console.log("");
    console.log(`  ${purple("⚡")} ${bold("booting")} ${bold(agent.id)}  ${dim("·")}  ${cyan(model)} ${dim("·")} ${cyan(voice)}`);

    const toolNames = (config.tools ?? []).map((t) => t.name);
    if (toolNames.length > 0) {
        console.log(`  ${dim("⚙")} ${dim("tools:")} ${dim(toolNames.join(", "))}`);
    }

    if (phone) {
        console.log(`  ${green("☎")} listening on ${bold(phone)} ${dim("…")}`);
    } else {
        console.log(`  ${green("☎")} listening ${dim("(no phone — webrtc/chat only)")}`);
    }
    console.log("");

    // ── Pad the label for aligned output ─────────────────────────────
    const agentLabel = agent.id.length <= 8 ? agent.id.padEnd(8) : agent.id;

    // ── Call lifecycle ───────────────────────────────────────────────

    agent.on("call.started", (call: Call) => {
        const dir = call.direction === "outbound" ? "outgoing" : "incoming";
        const peer = call.direction === "outbound" ? call.to : call.from;
        console.log(`  ${green("☎")}  ${dir} call ${dim("—")} ${bold(peer || "unknown")} ${dim("— connecting…")}`);
    });

    agent.on("call.ended", (call: Call, reason: string) => {
        const dur = call.duration ? `${Math.round(call.duration)}s` : "";
        console.log(`  ${dim("☎")}  call ended ${dim("—")} ${dim(reason)} ${dur ? dim(`(${dur})`) : ""}`);
        console.log("");
    });

    // ── Live transcript ──────────────────────────────────────────────

    agent.on("user.message", (event, _call) => {
        const text = (event as any).text || "";
        if (text) {
            console.log(`  ${cyan("caller")} ${dim("›")} ${text}`);
        }
    });

    agent.on("message.confirmed", (event, _call) => {
        const text = (event as any).text || "";
        if (text) {
            console.log(`  ${purple(agentLabel)} ${dim("›")} ${text}`);
        }
    });

    // ── Tool calls ───────────────────────────────────────────────────

    agent.on("llm.toolCall", (event: ToolCallEvent, _call: Call) => {
        const items: ToolCallItem[] = (event as any).tool_calls || (event as any).tools || [];
        for (const item of items) {
            const name = item.name || "unknown";
            const args = item.arguments || {};
            const argsStr = colorizeJson(args, true);
            console.log(`          ${yellow("⚡")} ${yellow(bold(name))}(${argsStr})`);
        }
    });

    // Listen for tool results via the internal tool handler
    // The SDK auto-executes tools and emits bot.speaking with the result.
    // We intercept at the tool level by wrapping the execute function.
    wrapToolResults(agent);
}

/**
 * Wrap each tool's execute function to display results inline.
 */
function wrapToolResults(agent: Agent): void {
    const tools = agent._getTools();
    for (const tool of tools) {
        const originalExecute = tool.execute;
        (tool as any).execute = async (args: any, call: any) => {
            const result = await originalExecute(args, call);
            const display = colorizeJson(result);
            if (display) {
                console.log(`          ${green("✓")} ${display}`);
            }
            return result;
        };
    }
}

// ── JSON colorizer ──────────────────────────────────────────────────────

/**
 * Colorize a JSON value for terminal display.
 * Keys in cyan, strings in green, numbers in yellow, booleans in purple.
 * Inline mode (compact) for tool args, pretty mode for results.
 */
function colorizeJson(value: unknown, inline = false): string {
    if (value === null || value === undefined) return dim("null");
    if (typeof value === "string") return green(`"${value}"`);
    if (typeof value === "number") return yellow(String(value));
    if (typeof value === "boolean") return purple(String(value));

    if (Array.isArray(value)) {
        if (value.length === 0) return dim("[]");
        const items = value.map(v => colorizeJson(v, inline));
        if (inline) return `[${items.join(dim(", "))}]`;
        return `[${items.join(dim(", "))}]`;
    }

    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length === 0) return dim("{}");

        if (inline) {
            // Compact: { city: "New York" }
            const parts = entries.map(([k, v]) =>
                `${cyan(k)}${dim(":")} ${colorizeJson(v, true)}`
            );
            return parts.join(dim(", "));
        }

        // Pretty: multiline indented
        const parts = entries.map(([k, v]) => {
            const val = colorizeJson(v, false);
            return `            ${cyan(k)}${dim(":")} ${val}`;
        });
        return `\n${parts.join("\n")}`;
    }

    return String(value);
}

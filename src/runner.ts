/**
 * Runner — auto-attach display for `pinecall run`.
 *
 * When PINECALL_CLI_RUN=1, the Pinecall constructor calls attachRunner()
 * which hooks into agent creation and call lifecycle to display a live
 * terminal UI:
 *
 *   ⚡ booting nova  ·  gpt-4.1-mini · cartesia/sonic
 *   ☎ listening on +1 415 555 0177 …
 *
 *   ☎  incoming call — +14155550177 · phone — 14:02:11
 *   caller › Hey, where's my order?
 *   nova   › Happy to check — what's the order number?
 *   caller › It's 48213.
 *           ⚡ lookupOrder({ id: "48213" })
 *           ✓ shipped · UPS · ETA today 5:00pm
 *   ● listening t+14.2s                      ← the live last line (TTY)
 *
 * All rendering lives in src/cli/live-view.ts (one view shared by every
 * agent of the process, so multi-agent files get prefixed lines). This file
 * only decides the mode — TTY / colour / debug — from the environment, prints
 * the boot banner, and wraps tool execution so results land inline.
 *
 *   PINECALL_RUN_EVENTS=1   (or `pinecall run --events`) prints every event
 *                           name + payload summary, in both renderers.
 */

import type { Agent } from "./domain/agent.js";
import { createLiveView, type LiveView } from "./cli/live-view.js";

// ── Mode from the environment ────────────────────────────────────────────

const tty = process.stdout.isTTY === true;
const color = tty && process.env.NO_COLOR === undefined;
const events = process.env.PINECALL_RUN_EVENTS === "1";

let view: LiveView | null = null;

/** The process-wide view — created lazily so importing this module has no side effects. */
function getView(): LiveView {
    if (!view) view = createLiveView({ out: process.stdout, tty, color, events });
    return view;
}

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
    const v = getView();
    const { c } = v;
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
    v.print("");
    v.print(`  ${c.purple("⚡")} ${c.bold("booting")} ${c.bold(agent.id)}  ${c.dim("·")}  ${c.cyan(model)} ${c.dim("·")} ${c.cyan(voice)}`);

    const toolNames = (config.tools ?? []).map((t) => t.name);
    if (toolNames.length > 0) {
        v.print(`  ${c.dim("⚙")} ${c.dim("tools:")} ${c.dim(toolNames.join(", "))}`);
    }

    if (phone) {
        v.print(`  ${c.green("☎")} listening on ${c.bold(phone)} ${c.dim("…")}`);
    } else {
        v.print(`  ${c.green("☎")} listening ${c.dim("(no phone — webrtc/chat only)")}`);
    }
    if (events) {
        v.print(`  ${c.dim("·")} ${c.dim("events: on — every event is printed (PINECALL_RUN_EVENTS=1)")}`);
    }
    v.print("");

    // ── Live transcript: calls, speech, turns, bot words, tool calls ──
    v.attach(agent);

    // Tool results come from the SDK's auto-execution, not from an event —
    // wrap each tool's execute so the result lands inline under its call.
    wrapToolResults(agent, v);
}

/**
 * Wrap each tool's execute function to display results inline.
 */
function wrapToolResults(agent: Agent, v: LiveView): void {
    const tools = agent._getTools();
    for (const tool of tools) {
        const originalExecute = tool.execute;
        (tool as any).execute = async (args: any, call: any) => {
            const result = await originalExecute(args, call);
            v.toolResult(agent, call ?? undefined, result);
            return result;
        };
    }
}

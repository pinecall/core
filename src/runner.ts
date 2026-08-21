/**
 * Runner — auto-attach display for `pinecall run`.
 *
 * When PINECALL_CLI_RUN=1, the Pinecall constructor calls attachRunner(host)
 * which hooks into agent creation and call lifecycle to display a live
 * terminal UI:
 *
 *   ⚡ booting nova  ·  gpt-4.1-mini · cartesia/sonic
 *   ☎ listening on +1 415 555 0177 …
 *   ◉ console → http://127.0.0.1:4747   (p open · c chat · e events · q quit)
 *
 *   ☎  incoming call — +14155550177 · phone — 14:02:11
 *   caller › Hey, where's my order?
 *   nova   › Happy to check — what's the order number?
 *   caller › It's 48213.
 *           ⚡ lookupOrder({ id: "48213" })
 *           ✓ shipped · UPS · ETA today 5:00pm
 *   ● listening t+14.2s                      ← the live last line (TTY)
 *
 * ── Two observers, one bus ───────────────────────────────────────────────
 *
 * The agent process is the subject; the terminal view (src/cli/live-view.ts)
 * and the local web console (src/cli/console/) are observers of the SAME
 * transcript store, and `pc.stream()` in the developer's own server is a third.
 * Nothing here holds conversation state — the store does.
 *
 * This file only decides the mode — TTY / colour / debug / console — from the
 * environment, prints the boot banner, wires the keyboard, and wraps tool
 * execution so results land inline.
 *
 *   PINECALL_RUN_EVENTS=1     (`pinecall run --events`)   print every event
 *   PINECALL_RUN_UI=0         (`--no-ui`)                 no web console
 *   PINECALL_RUN_UI_PORT=n    (`--ui-port n`)             default 4747
 *   PINECALL_RUN_UI_HOST=h    (`--ui-host h`)             default 127.0.0.1
 *   PINECALL_RUN_OPEN=1       (`--open`)                  open the browser
 */

import type { Agent } from "./domain/agent.js";
import { createLiveView, type LiveView } from "./cli/live-view.js";
import { createCallsModel } from "./cli/console/calls-model.js";
import {
    shortModel,
    shortVoice,
    startConsoleServer,
    type ConsoleHost,
    type ConsoleServer,
} from "./cli/console/server.js";
import { attachKeys, openInBrowser } from "./cli/console/keys.js";

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

/**
 * What the runner needs from the Pinecall client to serve the web console.
 * Optional in full: `attachRunner()` with no host still gives the terminal UI,
 * so an older client (or a test) keeps working unchanged.
 */
export interface RunnerHost extends ConsoleHost {
    /** Graceful quit: disconnect the client and end every call. */
    close?(): void;
}

// ── Runner attach ────────────────────────────────────────────────────────

/**
 * Called from the Pinecall constructor when PINECALL_CLI_RUN=1.
 * Returns a function that should be called each time an agent is created.
 */
export function attachRunner(host?: RunnerHost): (agent: Agent) => void {
    return (agent: Agent) => {
        attachAgentDisplay(agent);
        if (host) startConsole(host);
    };
}

function attachAgentDisplay(agent: Agent): void {
    const v = getView();
    const { c } = v;
    const config = agent.getConfig();
    const model = shortModel(config.llm as any);
    const voice = shortVoice(config.voice as any);

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
    if (v.events) {
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

// ── The web console ──────────────────────────────────────────────────────

let consoleStarted = false;
let consoleServer: ConsoleServer | null = null;
let releaseKeys: (() => void) | null = null;

/** Start the console once, on the first agent. Never throws into the agent's boot. */
function startConsole(host: RunnerHost): void {
    if (consoleStarted) return;
    consoleStarted = true;
    if (process.env.PINECALL_RUN_UI === "0") return;

    const v = getView();
    const { c } = v;
    const hostname = process.env.PINECALL_RUN_UI_HOST || "127.0.0.1";
    const port = Number(process.env.PINECALL_RUN_UI_PORT || 4747);
    const calls = createCallsModel({
        store: v.store,
        agents: host.agents,
    });

    startConsoleServer({
        host,
        calls,
        store: v.store,
        hostname,
        port: Number.isFinite(port) && port > 0 ? port : 4747,
    }).then((server) => {
        consoleServer = server;
        v.print(`  ${c.purple("◉")} console ${c.dim("→")} ${c.cyan(server.url)}   ${c.dim("(p open · c chat · e events · q quit)")}`);
        if (server.guarded) {
            v.print(`  ${c.dim("·")} ${c.dim(`bound to ${server.hostname} — every request needs the run key above (?k=…)`)}`);
        }
        v.print("");
        bindKeys(host, server, v);
        if (process.env.PINECALL_RUN_OPEN === "1") open(server.url, v);
    }).catch((err: Error) => {
        v.print(`  ${c.yellow("◉")} ${c.dim(`console off — ${err.message}`)}`);
        v.print("");
    });
}

function bindKeys(host: RunnerHost, server: ConsoleServer, v: LiveView): void {
    const { c } = v;
    releaseKeys = attachKeys({
        input: process.stdin as any,
        bindings: {
            p: () => open(server.url, v),
            c: () => v.print(`  ${c.dim("·")} ${c.dim("terminal chat — coming soon; type in the web console meanwhile")}`),
            e: () => {
                v.setEvents(!v.events);
                v.print(`  ${c.dim("·")} ${c.dim(`events: ${v.events ? "on" : "off"}`)}`);
            },
        },
        onQuit: () => quit(host, v),
    });
}

function open(url: string, v: LiveView): void {
    import("node:child_process").then(({ spawn }) => {
        const ok = openInBrowser(url, spawn as any);
        if (!ok) v.print(`  ${v.c.dim("·")} ${v.c.dim(`open it yourself: ${url}`)}`);
    }).catch(() => {});
}

/** `q` / Ctrl-C: close the console, disconnect, leave the terminal as we found it. */
function quit(host: RunnerHost, v: LiveView): void {
    v.print("");
    v.print(`  ${v.c.dim("·")} ${v.c.dim("bye")}`);
    releaseKeys?.();
    releaseKeys = null;
    const done = () => {
        try { host.close?.(); } catch { /* going down anyway */ }
        process.exit(0);
    };
    if (consoleServer) consoleServer.close().then(done, done);
    else done();
}

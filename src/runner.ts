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
 *   PINECALL_RUN_AGENT=id     (`--agent id`)               who `c` and `--call` talk to
 *   PINECALL_RUN_CALL=+34…    (`--call +34…`)              the agent rings you on boot
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
import { openPrompt, type OpenPrompt } from "./cli/console/prompt.js";
import { isChatCapable, newChatSession, sendChat, type ChatAgentLike } from "./cli/console/chat.js";
import { ringMe, type DialAgentLike } from "./cli/console/dial.js";

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
        maybeRing(agent);
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

    const v0 = getView();
    if (process.env.PINECALL_RUN_UI === "0") {
        // No web console, but the terminal is still an observer — and `c` still
        // talks to the agent. Bind the keys the web half does not own.
        v0.print(`  ${v0.c.dim("·")} ${v0.c.dim("web console off (--no-ui)   (c chat · e events · q quit)")}`);
        v0.print("");
        bindKeys(host, v0);
        return;
    }

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
        bindKeys(host, v);
        if (process.env.PINECALL_RUN_OPEN === "1") open(server.url, v);
    }).catch((err: Error) => {
        v.print(`  ${c.yellow("◉")} ${c.dim(`console off — ${err.message}`)}`);
        v.print("");
    });
}

/**
 * Bind the shortcuts. Called again every time the chat prompt gives stdin back:
 * exactly one owner of the raw stream at a time — the keys, or the prompt.
 */
function bindKeys(host: RunnerHost, v: LiveView): void {
    const { c } = v;
    releaseKeys?.();
    releaseKeys = attachKeys({
        input: process.stdin as any,
        bindings: {
            p: () => {
                if (consoleServer) open(consoleServer.url, v);
                else v.print(`  ${c.dim("·")} ${c.dim("no web console in this run (--no-ui)")}`);
            },
            c: () => startChat(host, v),
            e: () => {
                v.setEvents(!v.events);
                v.print(`  ${c.dim("·")} ${c.dim(`events: ${v.events ? "on" : "off"}`)}`);
            },
        },
        onQuit: () => quit(host, v),
    });
}

// ── `c` — the terminal chat prompt ───────────────────────────────────────

/** The prompt that currently owns stdin. Only ever one. */
let prompt: OpenPrompt | null = null;
/** One chat session per agent, so the conversation continues across `c`. */
const chatSessions = new Map<string, string>();

/** Agents this process can chat with — a live `Agent`, not a snapshot of one. */
function chatTargets(host: RunnerHost): ChatAgentLike[] {
    const found: ChatAgentLike[] = [];
    for (const agent of host.agents.values()) if (isChatCapable(agent)) found.push(agent);
    return found;
}

/**
 * `c`: pick an agent (when there are several), then read lines and send them.
 *
 * The reply is NOT printed here — it comes back as ordinary agent events and
 * the live view draws it like any other conversation, which is the whole point.
 */
function startChat(host: RunnerHost, v: LiveView): void {
    const { c } = v;
    if (prompt) return;

    const targets = chatTargets(host);
    if (targets.length === 0) {
        v.print(`  ${c.dim("·")} ${c.dim("no agent to chat with yet — it appears as soon as one registers")}`);
        return;
    }

    const wanted = (process.env.PINECALL_RUN_AGENT || "").trim();
    const picked = wanted ? targets.find((a) => a.id === wanted) : undefined;
    if (picked) { chatWith(host, v, picked); return; }
    if (targets.length === 1) { chatWith(host, v, targets[0]!); return; }

    v.print("");
    v.print(`  ${c.dim("·")} ${c.dim("which agent?")}`);
    targets.forEach((a, i) => v.print(`  ${c.dim(`${i + 1})`)} ${c.bold(a.id)}`));

    const pick: { agent: ChatAgentLike | null } = { agent: null };
    prompt = openLine(host, v, `  ${c.dim("agent")} ${c.dim("›")} `, (line) => {
        const n = Number(line);
        if (!Number.isInteger(n) || n < 1 || n > targets.length) {
            v.print(`  ${c.dim("·")} ${c.dim(`pick 1–${targets.length}, or Esc`)}`);
            return;
        }
        pick.agent = targets[n - 1]!;
        prompt?.close();
    }, () => { if (pick.agent) chatWith(host, v, pick.agent); });
    if (!prompt) offTty(v);
}

function chatWith(host: RunnerHost, v: LiveView, agent: ChatAgentLike): void {
    const { c } = v;
    let session = chatSessions.get(agent.id);
    if (!session) { session = newChatSession(); chatSessions.set(agent.id, session); }

    v.print(`  ${c.dim("·")} ${c.dim(`chatting with ${agent.id} — Esc or an empty line closes the prompt`)}`);
    prompt = openLine(host, v, `  ${c.cyan("you")} ${c.dim("›")} `, (line) => {
        try {
            sendChat(agent, session!, line);
        } catch (err) {
            v.print(`  ${c.yellow("·")} ${c.dim(`could not send — ${(err as Error).message}`)}`);
        }
    });
    if (!prompt) offTty(v);
}

/**
 * Open a prompt: it takes stdin from the shortcuts and hands it back on close.
 * The line is drawn as the view's pinned last row, so the transcript — including
 * the agent's reply to what was just typed — keeps scrolling above it.
 */
function openLine(
    host: RunnerHost,
    v: LiveView,
    label: string,
    onSubmit: (line: string) => void,
    after?: () => void,
): OpenPrompt | null {
    releaseKeys?.();
    releaseKeys = null;
    const opened = openPrompt({
        input: process.stdin as any,
        label,
        render: (line) => v.pin(line),
        onSubmit,
        onClose: () => {
            prompt = null;
            bindKeys(host, v);
            after?.();
        },
    });
    if (!opened) bindKeys(host, v);   // not a TTY after all — put the keys back
    return opened;
}

function offTty(v: LiveView): void {
    v.print(`  ${v.c.dim("·")} ${v.c.dim("chat needs an interactive terminal — use the web console instead")}`);
}

// ── `--call <number>` — the agent rings you ──────────────────────────────

let ringing = false;

/**
 * Dial once per run, as soon as the agent the call belongs to is registered
 * server-side (`agent.ready`) — before that the server has no such agent and
 * the dial 404s.
 */
function maybeRing(agent: Agent): void {
    const to = (process.env.PINECALL_RUN_CALL || "").trim();
    if (!to || ringing) return;
    const wanted = (process.env.PINECALL_RUN_AGENT || "").trim();
    if (wanted && agent.id !== wanted) return;
    ringing = true;

    const v = getView();
    const { c } = v;
    const say = (glyph: string, line: string) => { v.print(`  ${glyph} ${line}`); v.print(""); };

    Promise.resolve(agent.ready)
        .then(() => ringMe(agent as unknown as DialAgentLike, to))
        .then((result) => {
            if (result.ok) say(c.green("☎"), result.message);
            else say(c.yellow("☎"), c.dim(result.message));
        })
        .catch((err: Error) => say(c.yellow("☎"), c.dim(`could not call ${to} — ${err?.message ?? String(err)}`)));
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
    prompt?.close();
    prompt = null;
    releaseKeys?.();
    releaseKeys = null;
    const done = () => {
        try { host.close?.(); } catch { /* going down anyway */ }
        process.exit(0);
    };
    if (consoleServer) consoleServer.close().then(done, done);
    else done();
}

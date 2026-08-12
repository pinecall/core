/**
 * AgentProcess — the ONE user-code process this MCP session manages.
 *
 * WHY A PROCESS AT ALL (and why configure_agent is not enough):
 *
 * `configure_agent` holds a live SDK client for a CONFIG-ONLY agent — prompt,
 * voice, model. That is everything an agent needs right up until it needs to
 * DO something: a code tool (`agent.tool(...)`) is a JavaScript function, and a
 * function cannot be sent over `agent.create`. It has to be running somewhere.
 * That somewhere is the user's own entry file — the same file `pinecall run`
 * spawns (src/cli/commands/run.ts). So the honest way to make a real agent
 * reachable from the editor is to run that file, exactly as the CLI does, and
 * keep it alive.
 *
 * Consequences that shape this class:
 *
 * WHY IT SPAWNS THE CLI AND NOT `node <file>`:
 *
 * `pinecall run` is not a thin wrapper — it sets `PINECALL_CLI_RUN=1`, and the
 * Pinecall constructor keys off exactly that (src/client.ts:199 → attachRunner,
 * src/runner.ts) to attach the runner display: the boot banner naming agent /
 * LLM / voice, the live transcript, formatted tool calls. That output IS the
 * debugging surface this tool promises in `logs`. A bare `node <file>` produces
 * none of it. The CLI also owns the tsx lookup, the extension whitelist and the
 * `cwd = dirname(file)` convention (src/cli/commands/run.ts). Reimplementing any
 * of that here would be a second, drifting copy of the run semantics.
 *
 * So the managed child is `node <pinecall-cli> run <file>` — the same entry the
 * `pinecall` bin points at (package.json bin → dist/cli.js), resolved from the
 * PROJECT and never from a bare PATH lookup. The CLI's own child inherits stdio,
 * so the agent's output flows through the CLI into our pipes unchanged.
 *
 * That makes the managed thing a process TREE (CLI → tsx/node → agent), which is
 * why it is spawned `detached: true` into its own process group and signalled as
 * `-pid`: SIGTERM to the CLI alone would leave the agent orphaned, still holding
 * its websocket, still registered — the exact ghost this class exists to prevent.
 *
 * Consequences that shape this class:
 *
 * · The registration dies with the socket (see agent-hosts.ts for the citation),
 *   and the socket belongs to the child. So the child must OUTLIVE the tool call
 *   that started it, and must NOT outlive the MCP server — hence the exit hooks.
 * · ONE managed process per session. Two would race for the same slug and the
 *   loser's `AGENT_CONFLICT` would be blamed on the user's code. A second
 *   `start` stops the first and says so.
 * · Its output is the only debugging surface the coding agent has (an MCP server
 *   owns stdout for the protocol, so the child's stdout can never be inherited).
 *   It goes into a ring buffer instead — bounded, so a chatty agent cannot grow
 *   this process without limit.
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Lines kept per run. Enough for a boot banner plus a stack trace. */
export const RING_CAPACITY = 500;
/** Default `logs` page. */
export const DEFAULT_LOG_LINES = 50;
/** Grace between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 5_000;

export class PathOutsideCwd extends Error {
    constructor(file: string, resolved: string, cwd: string) {
        super(
            `Refusing to run "${file}": it resolves to ${resolved}, which is outside this ` +
            `server's working directory (${cwd}).\n\n` +
            `run_agent executes code with your API key in its environment, so it only runs ` +
            `files from the project the editor opened. Pass a path relative to that project ` +
            `(e.g. "agent/index.mjs"), or start the MCP server in the project that owns the file.`,
        );
        this.name = "PathOutsideCwd";
    }
}

export class AgentFileMissing extends Error {
    constructor(file: string, resolved: string, reason: "missing" | "not-a-file") {
        super(
            reason === "missing"
                ? `No such file: "${file}" (looked at ${resolved}). Pass the path to your agent's ` +
                  `entry file, relative to the project root — e.g. "agent/index.mjs" or "src/agent.ts".`
                : `"${file}" (${resolved}) is not a file. run_agent takes an entry FILE, not a directory.`,
        );
        this.name = "AgentFileMissing";
    }
}

export class TsxNotInstalled extends Error {
    constructor(file: string, from: string) {
        super(
            `"${file}" is TypeScript, which node cannot run directly, and no tsx binary was found ` +
            `on PATH or in node_modules/.bin between ${from} and the project root.\n\n` +
            `Install it in the project (npm i -D tsx) — the same requirement \`pinecall run\` has — ` +
            `or point run_agent at a compiled .js/.mjs entry instead.\n\n` +
            `(\`pinecall run\` would fall back to \`npx -y tsx\` here, which downloads and installs a ` +
            `package mid-call. run_agent refuses that one step: an MCP tool must not silently pull ` +
            `from the network on your behalf.)`,
        );
        this.name = "TsxNotInstalled";
    }
}

/** `pinecall run` accepts exactly these (src/cli/commands/run.ts). */
export const RUNNABLE_EXTENSIONS = [".ts", ".js", ".mjs"];

export class UnsupportedEntry extends Error {
    constructor(file: string, ext: string) {
        super(
            `"${file}" has an unsupported extension (${ext || "none"}). ` +
            `\`pinecall run\` — which run_agent drives — accepts ${RUNNABLE_EXTENSIONS.join(", ")}.`,
        );
        this.name = "UnsupportedEntry";
    }
}

export class PinecallCliNotFound extends Error {
    constructor(cwd: string) {
        super(
            `Could not locate the Pinecall CLI to run your agent with. Looked for ` +
            `node_modules/.bin/pinecall under ${cwd}, for the @pinecall/sdk package next to this ` +
            `server, and for a built dist/cli.js in the SDK checkout.\n\n` +
            `Install the SDK in the project (npm i @pinecall/sdk) — run_agent deliberately does NOT ` +
            `fall back to a \`pinecall\` on your PATH, because the agent must run against the SDK ` +
            `version the project pinned, not whatever is installed globally.`,
        );
        this.name = "PinecallCliNotFound";
    }
}

export interface StartOptions {
    /** Path as the caller typed it — relative paths resolve against `cwd`. */
    file: string;
    /** Injected as PINECALL_API_KEY. Process env, never written to disk. */
    apiKey: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}

export interface StartResult {
    file: string;
    pid: number;
    started: true;
    runner: "node" | "tsx";
    /** Set when this start stopped a previously managed process. */
    replaced?: { file: string; pid: number };
}

export interface StatusResult {
    running: boolean;
    file?: string;
    pid?: number;
    uptimeMs?: number;
    runner?: "node" | "tsx";
    exitCode?: number | null;
    signal?: string | null;
    logLines: number;
}

/**
 * The path rule: a resolved path must live under `cwd`. `path.relative` is the
 * check — a result that escapes with `..` (or is absolute, on a different
 * Windows drive) is outside, and "" means the cwd itself.
 */
export function resolveAgentFile(file: string, cwd: string): string {
    const raw = String(file ?? "").trim();
    if (!raw) throw new AgentFileMissing(file, cwd, "missing");

    const root = resolve(cwd);
    const target = resolve(root, raw);
    const rel = relative(root, target);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new PathOutsideCwd(raw, target, root);
    }

    if (!existsSync(target)) throw new AgentFileMissing(raw, target, "missing");
    if (!statSync(target).isFile()) throw new AgentFileMissing(raw, target, "not-a-file");
    return target;
}

/** TypeScript entries need tsx; everything else is plain node. */
export function needsTsx(file: string): boolean {
    return /\.(ts|tsx|mts|cts)$/i.test(file);
}

/**
 * Walk `node_modules/.bin/<bin>` from `fromDir` up to (and including) `cwd` —
 * the same place npm puts it, and the reason a globally-installed MCP server
 * can still run a project's own toolchain.
 */
export function findLocalBin(bin: string, fromDir: string, cwd: string): string | null {
    const root = resolve(cwd);
    let dir = resolve(fromDir);
    for (;;) {
        const candidate = join(dir, "node_modules", ".bin", bin);
        if (existsSync(candidate)) return candidate;
        const rel = relative(root, dir);
        if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) break;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/**
 * The CLI's own tsx lookup is PATH first, then node_modules/.bin, then
 * `npx -y tsx` (src/cli/commands/run.ts findTsx). We mirror the first two and
 * refuse the third — see TsxNotInstalled for why.
 */
export function findTsx(fromDir: string, cwd: string): string | null {
    try {
        const onPath = execSync("which tsx", { encoding: "utf8", stdio: "pipe" }).trim().split(/\r?\n/)[0];
        if (onPath) return onPath;
    } catch {
        /* not on PATH */
    }
    return findLocalBin("tsx", fromDir, cwd);
}

/**
 * The `pinecall` CLI entry to drive, resolved from the project — never a bare
 * PATH lookup, so the agent runs against the SDK version the project pinned.
 *
 *   1. the project's own node_modules/.bin/pinecall
 *   2. the @pinecall/sdk package resolvable from this module (published layout)
 *   3. dist/cli.js in the SDK checkout this file lives in (monorepo / dev)
 */
export function findPinecallCli(fromDir: string, cwd: string): string | null {
    const local = findLocalBin("pinecall", fromDir, cwd);
    if (local) return local;

    try {
        const require = createRequire(import.meta.url);
        const pkgPath = require.resolve("@pinecall/sdk/package.json");
        const bin = join(dirname(pkgPath), "dist", "cli.js");
        if (existsSync(bin)) return bin;
    } catch {
        /* not installed as a package */
    }

    // mcp/src/agent-process.ts → the SDK checkout two levels up.
    const here = dirname(fileURLToPath(import.meta.url));
    for (const up of ["../..", "../../.."]) {
        const bin = resolve(here, up, "dist", "cli.js");
        if (existsSync(bin)) return bin;
    }
    return null;
}

/** Bounded line buffer — the child's stdout+stderr, newest kept. */
export class RingBuffer {
    #lines: string[] = [];
    #partial = "";

    constructor(readonly capacity: number = RING_CAPACITY) {}

    /** Chunks arrive split anywhere; only complete lines are committed. */
    push(chunk: string, prefix = ""): void {
        const text = this.#partial + chunk;
        const parts = text.split(/\r?\n/);
        this.#partial = parts.pop() ?? "";
        for (const line of parts) this.#commit(prefix + line);
    }

    /** End of stream: whatever is left is a line. */
    flush(prefix = ""): void {
        if (!this.#partial) return;
        this.#commit(prefix + this.#partial);
        this.#partial = "";
    }

    #commit(line: string): void {
        this.#lines.push(line);
        if (this.#lines.length > this.capacity) this.#lines.splice(0, this.#lines.length - this.capacity);
    }

    get size(): number {
        return this.#lines.length;
    }

    last(n: number): string[] {
        return this.#lines.slice(Math.max(0, this.#lines.length - n));
    }

    clear(): void {
        this.#lines = [];
        this.#partial = "";
    }
}

/**
 * Signal the whole process GROUP (`-pid`). The managed child is the CLI, which
 * re-spawns the agent: signalling the CLI alone leaves the agent orphaned and
 * still registered. Falls back to the single pid if the group is already gone.
 */
function signalTree(managed: { child: ChildProcess; pid: number }, sig: NodeJS.Signals): void {
    try {
        process.kill(-managed.pid, sig);
    } catch {
        try {
            managed.child.kill(sig);
        } catch {
            /* already gone */
        }
    }
}

interface Managed {
    child: ChildProcess;
    file: string;
    pid: number;
    runner: "node" | "tsx";
    startedAt: number;
    alive: boolean;
    exitCode: number | null;
    signal: string | null;
    exited: Promise<void>;
}

export class AgentProcessManager {
    #current?: Managed;
    #logs = new RingBuffer();
    #hooked = false;

    get running(): boolean {
        return this.#current?.alive === true;
    }

    async start(opts: StartOptions): Promise<StartResult> {
        const cwd = resolve(opts.cwd ?? process.cwd());
        const target = resolveAgentFile(opts.file, cwd);

        const ext = extname(target);
        if (!RUNNABLE_EXTENSIONS.includes(ext)) throw new UnsupportedEntry(opts.file, ext);

        // Preflight the CLI's own requirements so a failure is an error the tool
        // returns, not a stack the caller has to go find in `logs`.
        const runner: "node" | "tsx" = needsTsx(target) ? "tsx" : "node";
        if (runner === "tsx" && !findTsx(dirname(target), cwd)) {
            throw new TsxNotInstalled(opts.file, dirname(target));
        }

        const cli = findPinecallCli(dirname(target), cwd);
        if (!cli) throw new PinecallCliNotFound(cwd);

        // `node <pinecall-cli> run <file>` — the bin's own entry, driven with the
        // same argv a terminal would type. PINECALL_CLI_RUN and the tsx/node
        // choice are then the CLI's, not ours.
        const command = process.execPath;
        const args = [cli, "run", target];

        // One managed process per session: the previous one goes first, and the
        // caller is TOLD, because a silently-killed agent looks like a crash.
        let replaced: StartResult["replaced"];
        if (this.#current?.alive) {
            replaced = { file: this.#current.file, pid: this.#current.pid };
            await this.stop();
        }

        this.#logs.clear();
        const child = spawn(command, args, {
            // The CLI re-spawns with cwd = dirname(file); ours only has to be
            // inside the project so relative requires from the MCP side resolve.
            cwd,
            env: { ...(opts.env ?? process.env), PINECALL_API_KEY: opts.apiKey },
            stdio: ["ignore", "pipe", "pipe"],
            // Own process group — `stop` signals the whole tree (CLI + agent).
            detached: true,
        });

        if (!child.pid) {
            const err = new Error(`Failed to spawn ${runner} for ${opts.file}.`);
            child.kill("SIGKILL");
            throw err;
        }

        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (c: string) => this.#logs.push(c));
        child.stderr?.on("data", (c: string) => this.#logs.push(c, "[stderr] "));

        const managed: Managed = {
            child,
            file: relative(cwd, target) || target,
            pid: child.pid,
            runner,
            startedAt: Date.now(),
            alive: true,
            exitCode: null,
            signal: null,
            exited: new Promise<void>((res) => {
                child.once("exit", (code, sig) => {
                    managed.alive = false;
                    managed.exitCode = code;
                    managed.signal = sig;
                    this.#logs.flush();
                    this.#logs.push(`\n[run_agent] process exited (code=${code}, signal=${sig})\n`);
                    res();
                });
            }),
        };
        // A spawn that fails asynchronously (ENOENT) never emits 'exit' as an
        // error — record it as output so `logs` explains the dead process.
        child.on("error", (err) => this.#logs.push(`[run_agent] spawn error: ${err.message}\n`));

        this.#current = managed;
        this.#installExitHooks();

        const result: StartResult = { file: managed.file, pid: managed.pid, started: true, runner };
        if (replaced) result.replaced = replaced;
        return result;
    }

    status(): StatusResult {
        const cur = this.#current;
        if (!cur) return { running: false, logLines: this.#logs.size };
        return {
            running: cur.alive,
            file: cur.file,
            pid: cur.pid,
            runner: cur.runner,
            uptimeMs: cur.alive ? Date.now() - cur.startedAt : undefined,
            exitCode: cur.alive ? undefined : cur.exitCode,
            signal: cur.alive ? undefined : cur.signal,
            logLines: this.#logs.size,
        };
    }

    logs(n: number = DEFAULT_LOG_LINES): { lines: string[]; totalLines: number; running: boolean; pid?: number } {
        const cur = this.#current;
        return {
            lines: this.#logs.last(n),
            totalLines: this.#logs.size,
            running: cur?.alive === true,
            ...(cur ? { pid: cur.pid } : {}),
        };
    }

    /** SIGTERM, then SIGKILL after the grace period. Idempotent. */
    async stop(graceMs: number = KILL_GRACE_MS): Promise<{ stopped: boolean; pid?: number; file?: string; killed?: boolean }> {
        const cur = this.#current;
        if (!cur || !cur.alive) return { stopped: false, ...(cur ? { pid: cur.pid, file: cur.file } : {}) };

        signalTree(cur, "SIGTERM");
        let killed = false;
        const timer = setTimeout(() => {
            if (cur.alive) {
                killed = true;
                signalTree(cur, "SIGKILL");
            }
        }, graceMs);
        try {
            await cur.exited;
        } finally {
            clearTimeout(timer);
        }
        return { stopped: true, pid: cur.pid, file: cur.file, killed };
    }

    /** Best-effort synchronous kill — for process-exit hooks, which cannot await. */
    killNow(): void {
        const cur = this.#current;
        if (cur?.alive) signalTree(cur, "SIGKILL");
    }

    /**
     * The child must never outlive this server: an orphan keeps the agent
     * registered, so the next session's `configure_agent` on that slug fights a
     * process nobody can see. `exit` cannot await, so it kills hard; the signal
     * hooks kill and then let the default disposition take over.
     */
    #installExitHooks(): void {
        if (this.#hooked) return;
        this.#hooked = true;
        process.once("exit", () => this.killNow());
        for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
            process.once(sig, () => {
                this.killNow();
                process.exit(0);
            });
        }
    }
}

/** One per process = one per MCP session. */
export const agentProcess = new AgentProcessManager();

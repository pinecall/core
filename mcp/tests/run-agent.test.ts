/**
 * run_agent — path rule, the ring buffer, and one-process-per-session.
 *
 * These run REAL child processes (tiny node scripts written into a tmp dir that
 * is made the cwd), because the whole point of the tool is process lifecycle:
 * mocking spawn would test nothing that can break.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import runAgent from "../src/tools/run-agent.js";
import {
    AgentProcessManager,
    RingBuffer,
    PathOutsideCwd,
    AgentFileMissing,
    UnsupportedEntry,
    resolveAgentFile,
    needsTsx,
    findLocalBin,
    findPinecallCli,
} from "../src/agent-process.js";
import { tools } from "../src/tools/index.js";
import { Session } from "../src/session.js";

const ctx = { session: new Session({ PINECALL_API_KEY: "pk_test_run_agent" } as any) };

let root: string;
let originalCwd: string;

beforeEach(() => {
    originalCwd = process.cwd();
    root = mkdtempSync(join(tmpdir(), "run-agent-"));
    process.chdir(root);
});

afterEach(() => {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
});

/** A script that prints, then stays alive until SIGTERM — like a real agent. */
function writeLongRunning(name = "agent.mjs", banner = "AGENT UP"): string {
    const file = join(root, name);
    writeFileSync(
        file,
        `console.log(${JSON.stringify(banner)});\n` +
        `console.log("key=" + (process.env.PINECALL_API_KEY ? "present" : "missing"));\n` +
        `console.log("cli_run=" + process.env.PINECALL_CLI_RUN);\n` +
        `setInterval(() => {}, 1000);\n`,
    );
    return name;
}

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

describe("path safety", () => {
    it("refuses a path outside the working directory", () => {
        expect(() => resolveAgentFile("../../etc/passwd", root)).toThrow(PathOutsideCwd);
        expect(() => resolveAgentFile("/etc/passwd", root)).toThrow(PathOutsideCwd);
    });

    it("the refusal names the cwd and says why", () => {
        const err: any = (() => {
            try {
                resolveAgentFile("/etc/passwd", root);
            } catch (e) {
                return e;
            }
        })();
        expect(err.message).toContain(resolve(root));
        expect(err.message).toMatch(/outside/i);
    });

    it("a missing file is a clear error, not a spawn failure", () => {
        expect(() => resolveAgentFile("nope.mjs", root)).toThrow(AgentFileMissing);
        const err: any = (() => {
            try {
                resolveAgentFile("nope.mjs", root);
            } catch (e) {
                return e;
            }
        })();
        expect(err.message).toMatch(/No such file/i);
        expect(err.message).toContain("nope.mjs");
    });

    it("a directory is not an entry file", () => {
        mkdirSync(join(root, "agent"));
        expect(() => resolveAgentFile("agent", root)).toThrow(AgentFileMissing);
    });

    it("accepts a nested file inside the tree", () => {
        mkdirSync(join(root, "agent"));
        writeFileSync(join(root, "agent", "index.mjs"), "");
        expect(resolveAgentFile("agent/index.mjs", root)).toBe(resolve(root, "agent/index.mjs"));
    });

    it("the tool itself refuses, through the handler", async () => {
        await expect(runAgent.handler({ action: "start", file: "../escape.mjs" }, ctx)).rejects.toBeInstanceOf(
            PathOutsideCwd,
        );
    });
});

describe("runner selection", () => {
    it("picks tsx only for TypeScript", () => {
        expect(needsTsx("a.ts")).toBe(true);
        expect(needsTsx("a.mts")).toBe(true);
        expect(needsTsx("a.mjs")).toBe(false);
        expect(needsTsx("a.js")).toBe(false);
    });

    it("finds a bin in the project's node_modules/.bin, walking up", () => {
        mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
        writeFileSync(join(root, "node_modules", ".bin", "tsx"), "#!/bin/sh\n");
        mkdirSync(join(root, "src"));
        expect(findLocalBin("tsx", join(root, "src"), root)).toBe(join(root, "node_modules", ".bin", "tsx"));
    });

    it("never falls back to a `pinecall` on PATH — only project/package/checkout", () => {
        const cli = findPinecallCli(root, root);
        // In this checkout it resolves to the SDK's own built bin.
        expect(cli === null || cli.endsWith("cli.js") || cli.endsWith(join(".bin", "pinecall"))).toBe(true);
    });

    it("refuses an extension `pinecall run` does not accept", async () => {
        writeFileSync(join(root, "agent.py"), "print(1)\n");
        const mgr = new AgentProcessManager();
        await expect(mgr.start({ file: "agent.py", apiKey: "pk_x", cwd: root })).rejects.toBeInstanceOf(
            UnsupportedEntry,
        );
    });
});

describe("ring buffer", () => {
    it("keeps only the last N lines and joins split chunks", () => {
        const ring = new RingBuffer(3);
        ring.push("a\nb\nc\nd\n");
        expect(ring.last(10)).toEqual(["b", "c", "d"]);
        ring.push("par");
        expect(ring.last(10)).toEqual(["b", "c", "d"]);
        ring.push("tial\n");
        expect(ring.last(1)).toEqual(["partial"]);
    });

    it("flush commits a trailing line with no newline", () => {
        const ring = new RingBuffer();
        ring.push("no-newline");
        expect(ring.size).toBe(0);
        ring.flush();
        expect(ring.last(1)).toEqual(["no-newline"]);
    });
});

describe("lifecycle", () => {
    it("starts, reports status, captures output, and stops", async () => {
        const mgr = new AgentProcessManager();
        const file = writeLongRunning();
        const started = await mgr.start({ file, apiKey: "pk_secret_value", cwd: root });
        try {
            expect(started.started).toBe(true);
            expect(started.pid).toBeGreaterThan(0);
            expect(started.runner).toBe("node");

            const status = mgr.status();
            expect(status.running).toBe(true);
            expect(status.pid).toBe(started.pid);
            expect(status.uptimeMs).toBeGreaterThanOrEqual(0);

            await settle();
            const logs = mgr.logs(50);
            expect(logs.lines).toContain("AGENT UP");
            // the key reaches the child through env, not a file
            expect(logs.lines).toContain("key=present");
            // proof it went through `pinecall run` and not a bare `node <file>`:
            // PINECALL_CLI_RUN=1 is set by src/cli/commands/run.ts alone, and it
            // is what makes the SDK attach the runner display (src/client.ts:199).
            expect(logs.lines).toContain("cli_run=1");
        } finally {
            const stopped = await mgr.stop();
            expect(stopped.stopped).toBe(true);
        }
        expect(mgr.status().running).toBe(false);
    });

    it("stopping nothing is not an error", async () => {
        const mgr = new AgentProcessManager();
        expect((await mgr.stop()).stopped).toBe(false);
    });

    it("a second start replaces the first", async () => {
        const mgr = new AgentProcessManager();
        const first = await mgr.start({ file: writeLongRunning("one.mjs", "ONE"), apiKey: "k", cwd: root });
        const second = await mgr.start({ file: writeLongRunning("two.mjs", "TWO"), apiKey: "k", cwd: root });
        try {
            expect(second.replaced).toEqual({ file: "one.mjs", pid: first.pid });
            expect(second.pid).not.toBe(first.pid);
            expect(mgr.status().file).toBe("two.mjs");
            // the first is really gone
            expect(() => process.kill(first.pid, 0)).toThrow();
            await settle();
            expect(mgr.logs(50).lines).toContain("TWO");
            expect(mgr.logs(50).lines).not.toContain("ONE");
        } finally {
            await mgr.stop();
        }
    });

    it("records the exit of a child that dies on its own", async () => {
        const mgr = new AgentProcessManager();
        writeFileSync(join(root, "boom.mjs"), 'console.error("BOOM"); process.exit(3);\n');
        await mgr.start({ file: "boom.mjs", apiKey: "k", cwd: root });
        await settle();
        const status = mgr.status();
        expect(status.running).toBe(false);
        expect(status.exitCode).toBe(3);
        expect(mgr.logs(50).lines).toContain("[stderr] BOOM");
    });
});

describe("tool surface", () => {
    it("is registered in the journey, right after configure_agent", () => {
        const names = tools.map((t) => t.name);
        expect(names).toContain("run_agent");
        expect(names.indexOf("run_agent")).toBe(names.indexOf("configure_agent") + 1);
    });

    it("start without a file says what is missing", async () => {
        await expect(runAgent.handler({ action: "start" }, ctx)).rejects.toThrow(/needs `file`/);
    });

    it("status and logs work with nothing running", async () => {
        expect(await runAgent.handler({ action: "status" }, ctx)).toMatchObject({ running: false });
        expect(await runAgent.handler({ action: "logs" }, ctx)).toMatchObject({ lines: [], running: false });
    });

    it("the manual carries the security note and the loop", () => {
        expect(runAgent.manual).toMatch(/SECURITY/);
        expect(runAgent.manual).toMatch(/chat/);
        expect(runAgent.manual.split("\n").length).toBeLessThanOrEqual(3);
    });
});

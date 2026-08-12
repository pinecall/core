/**
 * run_agent — run the user's own agent entry file, from the editor.
 *
 * configure_agent covers agents that are pure config. The moment an agent has a
 * code tool it needs a PROCESS, because a function cannot be serialized into
 * `agent.create` — so this tool does what `pinecall run` does: spawn the file
 * and hold it. The lifecycle (path rule, ring buffer, one-per-session, kill on
 * exit) lives in agent-process.ts; this file is the thin MCP surface over it.
 */

import { z } from "zod";
import { defineTool } from "./types.js";
import { agentProcess, DEFAULT_LOG_LINES } from "../agent-process.js";

const schema = {
    file: z
        .string()
        .optional()
        .describe(
            'Path to your agent entry file, relative to the project root — e.g. "agent/index.mjs" or "src/agent.ts". Required for action "start".',
        ),
    action: z
        .enum(["start", "stop", "status", "logs"])
        .optional()
        .describe('What to do. Default "start".'),
    lines: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe(`For action "logs": how many trailing lines (default ${DEFAULT_LOG_LINES}).`),
};

export default defineTool({
    name: "run_agent",
    description:
        "Run your project's agent entry file as a managed child process (like `pinecall run`), so an agent with code tools is live and chattable. Also stop/status/logs.",
    schema,
    manual:
        "The loop: write agent code → start → `chat` → `logs` when a reply is off → `stop`. Needed when the agent has code tools (`configure_agent` cannot carry functions). ONE process per session; killed when this server exits. SECURITY: runs YOUR project's code locally with your key in its env — IDE-terminal trust, files inside cwd only.",
    async handler(
        args: { file?: string; action?: "start" | "stop" | "status" | "logs"; lines?: number },
        { session },
    ) {
        const action = args.action ?? "start";

        switch (action) {
            case "start": {
                if (!args.file) {
                    throw new Error(
                        'run_agent action "start" needs `file` — the path to your agent entry file, relative to the project root (e.g. "agent/index.mjs").',
                    );
                }
                const result = await agentProcess.start({ file: args.file, apiKey: session.apiKey() });
                return {
                    ...result,
                    note: result.replaced
                        ? `Stopped the previously managed process (${result.replaced.file}, pid ${result.replaced.pid}) — one agent process per MCP session.`
                        : "Registration lives as long as this process: it is stopped when the MCP server exits. Use action:\"logs\" to read its output.",
                };
            }
            case "status":
                return agentProcess.status();
            case "logs":
                return agentProcess.logs(args.lines ?? DEFAULT_LOG_LINES);
            case "stop": {
                const stopped = await agentProcess.stop();
                return stopped.stopped
                    ? { ...stopped, note: "SIGTERM sent; the agent's registration drops as its socket closes." }
                    : { ...stopped, note: "Nothing was running." };
            }
        }
    },
});

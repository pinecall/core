/**
 * chat — say something to an agent and read what it says back.
 *
 * This is the iteration AND the testing loop: there is deliberately no
 * spec-runner tool. The transport is the CLI's own chat client (the `llm.chat`
 * WebSocket protocol), never a hand-rolled one.
 */

import { z } from "zod";
import { defineTool } from "./types.js";
import { chatSessions, DEFAULT_TIMEOUT_MS } from "../chat-sessions.js";

export default defineTool({
    name: "chat",
    description:
        "Send a text message to a Pinecall agent and return its reply. Continue a conversation by passing the session id back. Read-only: chat never mutates an agent.",
    schema: {
        agent: z.string().min(1).describe("Agent slug, e.g. dev-support or the production slug"),
        message: z.string().min(1).describe("What to say to the agent, as a caller would say it"),
        session: z
            .string()
            .optional()
            .describe("Session id returned by a previous chat call — continues that conversation with its history"),
        timeoutSeconds: z
            .number()
            .int()
            .min(5)
            .max(120)
            .optional()
            .describe(`Budget for this turn, connect included (default ${DEFAULT_TIMEOUT_MS / 1000}s)`),
    },
    manual: [
        "**`chat`** — the iteration loop AND the test suite. Send a message, read the reply,",
        "change the prompt, send again. There is deliberately no spec-runner tool: **to test",
        "behaviour, converse**. Ask what a real caller would ask — the awkward question, the",
        "interruption, the thing the prompt forbids — and judge the transcript yourself.",
        "",
        "- **Iterate on a `dev-` agent, verify on prod.** `chat` talks to ANY agent and never",
        "  mutates one, so chatting a production slug is safe; `configure_agent` is not.",
        "- **`session`**: the first call returns a `session` id. Pass it back and the agent",
        "  remembers the conversation — that is how you test memory, follow-ups and hand-offs.",
        "  Omit it to start clean. Sessions live in memory here and expire after 15 min idle.",
        "- **`toolCalls`** is present only when the agent actually invoked a tool this turn —",
        "  the cheapest way to check function calling fires (and fires once).",
        "- **Timeouts are errors, not hangs.** A turn is capped (default 30s); an offline agent",
        "  or a stalled model comes back as an error naming which. Retry with the same session.",
        "- For what happened *underneath* a real phone call — turns, latencies, tool results —",
        "  use `get_call`, not `chat`.",
    ].join("\n"),
    async handler(
        args: { agent: string; message: string; session?: string; timeoutSeconds?: number },
        { session },
    ) {
        return chatSessions.send({
            agent: args.agent,
            message: args.message,
            session: args.session,
            apiKey: session.apiKey(),
            serverUrl: session.serverUrl,
            timeoutMs: args.timeoutSeconds ? args.timeoutSeconds * 1000 : undefined,
        });
    },
});

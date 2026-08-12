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
    manual: "The testing path — there is no test-runner tool. Converse: ask what a real caller would and judge the transcript. The returned `session` id IS the thread: pass it back to continue; each reply is matched to your message (`in_reply_to`); 15 min idle.",
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

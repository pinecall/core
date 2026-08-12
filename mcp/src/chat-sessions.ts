/**
 * Live chat conversations, in memory, keyed by session id.
 *
 * The transport is NOT re-implemented here: it is the very `ChatClient` the
 * CLI's `pinecall test` / `pinecall chat` use (src/cli/commands/test/chat-client.ts),
 * which speaks the `llm.chat` WebSocket protocol against the voice server.
 * This module only owns the *lifetime* of those connections:
 *
 *   · a `session` id maps to one open WebSocket, so a second `chat` call with
 *     the same id continues the same conversation (the server keys history by
 *     `session_id`, and the socket stays warm between turns);
 *   · every turn has a hard budget — connect and reply are both raced against
 *     a deadline, so an offline agent or a stalled model surfaces as a thrown
 *     error within the budget instead of hanging the MCP client;
 *   · idle conversations are closed and dropped, so a long-lived MCP server
 *     does not accumulate sockets.
 */

import { ChatClient } from "../../src/cli/commands/test/chat-client.js";
import type { ToolCallInfo } from "../../src/cli/commands/test/types.js";

/** A turn that takes longer than this is reported as a timeout, never awaited further. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Connecting is part of the turn budget, but never gets more than this. */
const CONNECT_TIMEOUT_MS = 10_000;
/** A conversation nobody has spoken to in this long is closed. */
const IDLE_TTL_MS = 15 * 60_000;

export class ChatTimeoutError extends Error {
    readonly phase: "connect" | "reply";
    constructor(phase: "connect" | "reply", agent: string, ms: number) {
        super(
            phase === "connect"
                ? `Timed out after ${Math.round(ms / 1000)}s connecting to the Pinecall chat server for agent "${agent}". ` +
                  `The server or the network is unreachable — check PINECALL_URL and the API key.`
                : `Agent "${agent}" did not finish replying within ${Math.round(ms / 1000)}s. ` +
                  `The agent may be offline (nothing is running its process), its model may be stalled, ` +
                  `or a tool it called never returned. Check the agent is running, then retry — ` +
                  `the conversation is still open under the same session id.`,
        );
        this.name = "ChatTimeoutError";
        this.phase = phase;
    }
}

export class UnknownSessionError extends Error {
    constructor(session: string) {
        super(
            `No live chat session "${session}". Sessions live in this MCP server's memory only and are ` +
            `dropped after 15 minutes idle (or when the server restarts). Call chat again WITHOUT ` +
            `session to start a fresh conversation; the id it returns is the one to keep passing.`,
        );
        this.name = "UnknownSessionError";
    }
}

export interface ChatTurnResult {
    reply: string;
    session: string;
    toolCalls?: ToolCallInfo[];
}

export interface SendOptions {
    agent: string;
    message: string;
    session?: string;
    apiKey: string;
    /** Voice server base, http(s) — converted to ws(s) exactly as the CLI does. */
    serverUrl: string;
    timeoutMs?: number;
}

interface Conversation {
    client: ChatClient;
    agent: string;
    lastUsed: number;
    turns: number;
}

/** http(s)://host → ws(s)://host/client — the CLI's own conversion. */
export function chatWsUrl(serverUrl: string): string {
    return serverUrl.replace(/\/+$/, "").replace(/^http:/, "ws:").replace(/^https:/, "wss:") + "/client";
}

export class ChatSessions {
    readonly #live = new Map<string, Conversation>();

    /** Test seam: how a client is built. */
    constructor(
        private readonly makeClient: (opts: { server: string; apiKey: string; agentId: string }) => ChatClient =
            (opts) => new ChatClient(opts),
    ) {}

    get size(): number {
        return this.#live.size;
    }

    async send(opts: SendOptions): Promise<ChatTurnResult> {
        this.#evictIdle();
        const budget = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const startedAt = Date.now();

        let convo = opts.session ? this.#live.get(opts.session) : undefined;
        if (opts.session && !convo) throw new UnknownSessionError(opts.session);

        if (convo && convo.agent !== opts.agent) {
            throw new Error(
                `Session "${opts.session}" is a conversation with "${convo.agent}", not "${opts.agent}". ` +
                `One session is one agent — omit session to start a conversation with "${opts.agent}".`,
            );
        }

        if (!convo) {
            const client = this.makeClient({
                server: chatWsUrl(opts.serverUrl),
                apiKey: opts.apiKey,
                agentId: opts.agent,
            });
            try {
                await withDeadline(
                    client.connect(),
                    Math.min(CONNECT_TIMEOUT_MS, budget),
                    () => new ChatTimeoutError("connect", opts.agent, Math.min(CONNECT_TIMEOUT_MS, budget)),
                );
            } catch (err) {
                try { client.close(); } catch { /* ignore */ }
                throw err;
            }
            convo = { client, agent: opts.agent, lastUsed: Date.now(), turns: 0 };
        }

        const remaining = Math.max(1_000, budget - (Date.now() - startedAt));
        let id: string;
        try {
            id = convo.client.sendMessage(opts.message);
        } catch (err) {
            // Socket died between turns — the session is no longer usable.
            this.#drop(opts.session);
            throw new Error(
                `The chat connection to "${opts.agent}" is closed. Call chat again without session to reconnect. ` +
                `(${err instanceof Error ? err.message : String(err)})`,
            );
        }

        // Register BEFORE awaiting: a turn that times out must still be resumable
        // under the same id, because the socket and its history are still alive.
        this.#live.set(id, convo);
        convo.lastUsed = Date.now();

        let result: { text: string; toolCalls: ToolCallInfo[] };
        try {
            // The client has its own reply timeout, but the deadline is OURS: a client
            // that never settles must still surface as an error, never as a hung tool call.
            result = await withDeadline(
                convo.client.waitForResponse(remaining),
                remaining + 500,
                () => new ChatTimeoutError("reply", opts.agent, remaining),
            );
        } catch (err) {
            if (err instanceof Error && /timeout/i.test(err.message)) {
                throw new ChatTimeoutError("reply", opts.agent, remaining);
            }
            throw err;
        }

        convo.lastUsed = Date.now();
        convo.turns += 1;

        const out: ChatTurnResult = { reply: result.text, session: id };
        if (result.toolCalls.length > 0) out.toolCalls = result.toolCalls;
        return out;
    }

    /** Close everything — used on shutdown and by tests. */
    closeAll(): void {
        for (const [id, convo] of this.#live) {
            try { convo.client.close(); } catch { /* ignore */ }
            this.#live.delete(id);
        }
    }

    #drop(id?: string): void {
        if (!id) return;
        const convo = this.#live.get(id);
        if (!convo) return;
        try { convo.client.close(); } catch { /* ignore */ }
        this.#live.delete(id);
    }

    #evictIdle(): void {
        const cutoff = Date.now() - IDLE_TTL_MS;
        for (const [id, convo] of this.#live) {
            if (convo.lastUsed < cutoff) {
                try { convo.client.close(); } catch { /* ignore */ }
                this.#live.delete(id);
            }
        }
    }
}

/** Race a promise against a deadline. The loser is ignored, never awaited. */
function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(onTimeout()), ms);
        p.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); },
        );
    });
}

/** The process-wide map the `chat` tool uses — one per MCP server process. */
export const chatSessions = new ChatSessions();

/**
 * chat — the iteration loop.
 *
 * The unit tests drive a fake ChatClient through the real ChatSessions
 * lifetime logic (session reuse, unknown session, deadlines). The live test
 * talks to the REAL server (voice.pinecall.io) against a dev- agent; it is
 * skipped without PINECALL_API_KEY so CI stays hermetic.
 */

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ChatSessions, ChatTimeoutError, UnknownSessionError, chatWsUrl } from "../src/chat-sessions.js";
import chatTool from "../src/tools/chat.js";
import { tools } from "../src/tools/index.js";

class FakeClient extends EventEmitter {
    sessionId: string | null = null;
    sent: string[] = [];
    closed = false;
    connectCalls = 0;
    constructor(
        public opts: { server: string; apiKey: string; agentId: string },
        private behaviour: {
            connect?: () => Promise<void>;
            reply?: (text: string) => Promise<{ text: string; toolCalls: any[] }>;
        } = {},
    ) { super(); }

    async connect(): Promise<void> {
        this.connectCalls++;
        if (this.behaviour.connect) return this.behaviour.connect();
    }
    sendMessage(text: string): string {
        this.sent.push(text);
        if (!this.sessionId) this.sessionId = "fake-1";
        return this.sessionId;
    }
    async waitForResponse(timeoutMs: number): Promise<{ text: string; toolCalls: any[] }> {
        if (this.behaviour.reply) return this.behaviour.reply(this.sent[this.sent.length - 1]!);
        return { text: `echo:${this.sent[this.sent.length - 1]}`, toolCalls: [] };
    }
    close(): void { this.closed = true; }
}

const base = { agent: "dev-x", apiKey: "pk_secret", serverUrl: "https://voice.pinecall.io" };

describe("chat tool wiring", () => {
    it("is registered and carries a manual saying chat IS the test suite", () => {
        expect(tools.map((t) => t.name)).toContain("chat");
        expect(chatTool.manual).toMatch(/test/i);
        expect(Object.keys(chatTool.schema)).toEqual(["agent", "message", "session", "timeoutSeconds"]);
    });

    it("derives the CLI's own ws endpoint from the http server url", () => {
        expect(chatWsUrl("https://voice.pinecall.io")).toBe("wss://voice.pinecall.io/client");
        expect(chatWsUrl("http://localhost:8080/")).toBe("ws://localhost:8080/client");
    });
});

describe("ChatSessions", () => {
    it("returns the reply and a session id, and includes toolCalls only when there were some", async () => {
        const s = new ChatSessions((o) => new FakeClient(o) as any);
        const r = await s.send({ ...base, message: "hola" });
        expect(r.reply).toBe("echo:hola");
        expect(r.session).toBe("fake-1");
        expect(r).not.toHaveProperty("toolCalls");

        const withTools = new ChatSessions(
            (o) => new FakeClient(o, { reply: async () => ({ text: "done", toolCalls: [{ name: "book" }] }) }) as any,
        );
        const r2 = await withTools.send({ ...base, message: "book me" });
        expect(r2.toolCalls).toEqual([{ name: "book" }]);
    });

    it("reuses the same connection — and therefore the same history — for one session", async () => {
        let made: FakeClient | null = null;
        const s = new ChatSessions((o) => (made = new FakeClient(o)) as any);
        const first = await s.send({ ...base, message: "one" });
        const second = await s.send({ ...base, session: first.session, message: "two" });
        expect(second.session).toBe(first.session);
        expect(made!.connectCalls).toBe(1);
        expect(made!.sent).toEqual(["one", "two"]);
        expect(s.size).toBe(1);
    });

    it("refuses an unknown session id with the fix in the message", async () => {
        const s = new ChatSessions((o) => new FakeClient(o) as any);
        await expect(s.send({ ...base, session: "nope", message: "hi" })).rejects.toBeInstanceOf(UnknownSessionError);
    });

    it("refuses to point an existing session at a different agent", async () => {
        const s = new ChatSessions((o) => new FakeClient(o) as any);
        const first = await s.send({ ...base, message: "one" });
        await expect(
            s.send({ ...base, agent: "dev-other", session: first.session, message: "two" }),
        ).rejects.toThrow(/One session is one agent/);
    });

    it("a stalled model surfaces as a timeout error, not a hang", async () => {
        const s = new ChatSessions(
            (o) => new FakeClient(o, { reply: () => new Promise(() => {}) }) as any,
        );
        const started = Date.now();
        await expect(s.send({ ...base, message: "hi", timeoutMs: 6000 })).rejects.toBeInstanceOf(Error);
        expect(Date.now() - started).toBeLessThan(20_000);
    });

    it("an unreachable server surfaces as a connect timeout within the budget", async () => {
        const s = new ChatSessions(
            (o) => new FakeClient(o, { connect: () => new Promise(() => {}) }) as any,
        );
        const started = Date.now();
        const err = await s.send({ ...base, message: "hi", timeoutMs: 5000 }).catch((e) => e);
        expect(err).toBeInstanceOf(ChatTimeoutError);
        expect(err.phase).toBe("connect");
        expect(Date.now() - started).toBeLessThan(15_000);
    });

    it("closeAll drops every live conversation", async () => {
        const clients: FakeClient[] = [];
        const s = new ChatSessions((o) => { const c = new FakeClient(o); clients.push(c); return c as any; });
        await s.send({ ...base, message: "one" });
        s.closeAll();
        expect(s.size).toBe(0);
        expect(clients[0]!.closed).toBe(true);
    });
});

const LIVE_AGENT = process.env.PINECALL_MCP_TEST_AGENT ?? "dev-bistro";
const live = process.env.PINECALL_API_KEY ? describe : describe.skip;

live("chat against the real server", () => {
    it(
        "gets a model reply from a dev- agent and remembers within one session",
        async () => {
            const s = new ChatSessions();
            try {
                const first = await s.send({
                    agent: LIVE_AGENT,
                    message: "Hola, me llamo Bernardo. ¿Qué es este lugar?",
                    apiKey: process.env.PINECALL_API_KEY!,
                    serverUrl: process.env.PINECALL_URL ?? "https://voice.pinecall.io",
                });
                expect(first.reply.length).toBeGreaterThan(0);
                expect(first.session).toBeTruthy();

                const second = await s.send({
                    agent: LIVE_AGENT,
                    session: first.session,
                    message: "¿Cómo dije que me llamo?",
                    apiKey: process.env.PINECALL_API_KEY!,
                    serverUrl: process.env.PINECALL_URL ?? "https://voice.pinecall.io",
                });
                expect(second.session).toBe(first.session);
                expect(second.reply.toLowerCase()).toContain("bernardo");
            } finally {
                s.closeAll();
            }
        },
        90_000,
    );

    it(
        "an agent that never answers times out inside the budget",
        async () => {
            const s = new ChatSessions();
            const started = Date.now();
            const err = await s
                .send({
                    agent: "dev-does-not-exist-mcp-chat",
                    message: "hola",
                    apiKey: process.env.PINECALL_API_KEY!,
                    serverUrl: process.env.PINECALL_URL ?? "https://voice.pinecall.io",
                    timeoutMs: 8000,
                })
                .catch((e) => e);
            s.closeAll();
            expect(err).toBeInstanceOf(Error);
            expect(Date.now() - started).toBeLessThan(25_000);
        },
        60_000,
    );
});

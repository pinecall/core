/**
 * The console server behind `pinecall run` — the HTTP contract the web app is
 * built against, driven end to end over a real socket on an ephemeral port.
 *
 * Nothing here talks to Pinecall: the host is a fake with fake agents (plain
 * emitters), a stubbed `createToken` and the SDK's own `createMultiAgentStream`
 * as `stream`, so `/events` is exercised through the real SSE writer and read
 * back with the real parser (src/sse/parse.ts).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { startConsoleServer, type ConsoleHost, type ConsoleServer } from "../src/cli/console/server.js";
import { createCallsModel } from "../src/cli/console/calls-model.js";
import { createTranscriptStore, type TranscriptStore } from "../src/cli/console/transcript-reducer.js";
import { createMultiAgentStream } from "../src/sse/stream.js";
import { createSSEParser, type SSEEvent } from "../src/sse/parse.js";

// ── Fakes ────────────────────────────────────────────────────────────────

class FakeAgent {
    #handlers = new Map<string, Set<(...a: any[]) => void>>();
    hungUp: string[] = [];
    constructor(
        public id: string,
        private config: Record<string, unknown> = {},
        private channels: Array<{ type: string; ref?: string }> = [],
    ) {}
    on(event: string, handler: (...a: any[]) => void) {
        if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
        this.#handlers.get(event)!.add(handler);
        return this;
    }
    off(event: string, handler: (...a: any[]) => void) {
        this.#handlers.get(event)?.delete(handler);
        return this;
    }
    emit(event: string, ...args: any[]) {
        for (const h of [...(this.#handlers.get(event) ?? [])]) h(...args);
    }
    getConfig() { return this.config as any; }
    _getChannels() {
        return new Map(this.channels.map((ch, i) => [`${ch.type}:${ch.ref ?? i}`, ch]));
    }
    call(callId: string) {
        return { hangup: () => { this.hungUp.push(callId); } };
    }
}

function fakeHost(agents: FakeAgent[]) {
    const map = new Map(agents.map((a) => [a.id, a]));
    const createToken = vi.fn(async (_c: string, agentId: string, _m?: unknown) => ({
        token: `tok_${agentId}`,
        server: "https://voice.pinecall.io",
    }));
    const host: ConsoleHost = {
        agents: map as any,
        apiUrl: "https://voice.pinecall.io",
        createToken: createToken as any,
        stream: (res, opts) => createMultiAgentStream(map as any, res, opts),
    };
    return { host, map, createToken };
}

function call(id = "call_abc123", transport = "phone") {
    return { id, from: "+14155550177", to: "+15550001111", direction: "inbound", transport, duration: 0 };
}

// ── Harness ──────────────────────────────────────────────────────────────

let servers: ConsoleServer[] = [];

async function boot(opts: {
    agents?: FakeAgent[];
    hostname?: string;
    port?: number;
    requireKey?: boolean;
    key?: string;
    uiDir?: string | null;
} = {}) {
    const agents = opts.agents ?? [new FakeAgent("pines", { llm: "openai/gpt-4.1-mini", voice: "cartesia/sonic" })];
    const { host, createToken } = fakeHost(agents);
    const store: TranscriptStore = createTranscriptStore();
    for (const a of agents) store.attach(a as any);
    const calls = createCallsModel({ store, agents: host.agents as any });
    const server = await startConsoleServer({
        host, calls, store,
        hostname: opts.hostname ?? "127.0.0.1",
        port: opts.port ?? 0,
        uiDir: opts.uiDir === undefined ? null : opts.uiDir,
        ...(opts.requireKey === undefined ? {} : { requireKey: opts.requireKey }),
        ...(opts.key ? { key: opts.key } : {}),
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    return { server, base, agents, store, createToken, calls };
}

afterEach(async () => {
    await Promise.all(servers.map((s) => s.close()));
    servers = [];
});

// ── /api/agents ──────────────────────────────────────────────────────────

describe("console server — /api/agents", () => {
    it("describes every agent the process runs", async () => {
        const pines = new FakeAgent(
            "pines",
            { name: "Pines", llm: "openai/gpt-4.1-mini", voice: "cartesia/sonic", tools: [{ name: "getWeather" }] },
            [{ type: "phone", ref: "+14155550177" }, { type: "webrtc" }],
        );
        const { base } = await boot({ agents: [pines] });

        const body = await (await fetch(`${base}/api/agents`)).json();
        expect(body.agents).toEqual([{
            id: "pines",
            label: "Pines",
            channels: ["phone", "webrtc"],
            phone: "+14155550177",
            llm: "gpt-4.1-mini",
            voice: "cartesia/sonic",
            tools: ["getWeather"],
            canCall: true,
        }]);
    });

    it("falls back to `default` for an agent with no llm or voice", async () => {
        const { base } = await boot({ agents: [new FakeAgent("bare")] });
        const body = await (await fetch(`${base}/api/agents`)).json();
        expect(body.agents[0]).toMatchObject({
            id: "bare", llm: "default", voice: "default", channels: [], tools: [], canCall: false,
        });
    });
});

// ── /api/calls ───────────────────────────────────────────────────────────

describe("console server — /api/calls", () => {
    it("reflects the model: live calls with their transcript, newest first", async () => {
        const { base, agents, store } = await boot();
        const agent = agents[0]!;
        const c = call();
        agent.emit("call.started", c);
        agent.emit("user.message", { text: "Hi there" }, c);
        agent.emit("bot.speaking", { messageId: "m1", text: "Hello!" }, c);
        agent.emit("bot.word", { messageId: "m1", word: "Hello!" }, c);
        agent.emit("bot.finished", { messageId: "m1" }, c);

        const body = await (await fetch(`${base}/api/calls`)).json();
        expect(body.calls).toHaveLength(1);
        const snapshot = body.calls[0];
        expect(snapshot).toMatchObject({
            id: c.id, agent: "pines", channel: "phone", peer: "+14155550177", state: "listening",
        });
        expect(snapshot.lines.map((l: any) => [l.who, l.text])).toEqual([
            ["caller", "Hi there"],
            ["agent", "Hello!"],
        ]);
        store.dispose();
    });

    it("keeps an ended call in the list with its duration and reason", async () => {
        const { base, agents } = await boot();
        const c = call();
        agents[0]!.emit("call.started", c);
        agents[0]!.emit("call.ended", { ...c, duration: 12.5 }, "hangup");

        const body = await (await fetch(`${base}/api/calls`)).json();
        expect(body.calls[0]).toMatchObject({ id: c.id, state: "ended", durationS: 12.5, reason: "hangup" });
    });

    it("hangs a live call up through its agent, and 404s an unknown one", async () => {
        const { base, agents } = await boot();
        const c = call();
        agents[0]!.emit("call.started", c);

        const ok = await fetch(`${base}/api/calls/${c.id}/hangup`, { method: "POST" });
        expect(ok.status).toBe(200);
        expect(await ok.json()).toEqual({ ok: true });
        expect(agents[0]!.hungUp).toEqual([c.id]);

        const gone = await fetch(`${base}/api/calls/call_nope/hangup`, { method: "POST" });
        expect(gone.status).toBe(404);
    });
});

// ── /events ──────────────────────────────────────────────────────────────

/** Read an SSE response until `want` events have arrived. */
async function readEvents(res: Response, want: number, kick?: () => void): Promise<SSEEvent[]> {
    const got: SSEEvent[] = [];
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    const parser = createSSEParser((evt) => {
        got.push(evt);
        if (got.length >= want) resolve();
    });
    const reader = res.body!.getReader();
    (async () => {
        try {
            for (;;) {
                const { value, done: end } = await reader.read();
                if (end) break;
                if (value) parser.feed(value);
            }
        } catch { /* cancelled */ }
    })();
    // The first frame is already on the wire; emit the rest once we are reading.
    kick?.();
    await done;
    await reader.cancel().catch(() => {});
    return got;
}

describe("console server — /events", () => {
    it("opens with console.hello (agents + calls), then streams live events", async () => {
        const { base, agents } = await boot();
        const c = call();
        agents[0]!.emit("call.started", c); // already in flight when the page connects

        const res = await fetch(`${base}/events`);
        expect(res.headers.get("content-type")).toContain("text/event-stream");

        const got = await readEvents(res, 3, () => {
            agents[0]!.emit("user.message", { text: "Hello" }, c);
        });

        expect(got[0]!.event).toBe("console.hello");
        const hello = JSON.parse(got[0]!.data);
        expect(hello.agents[0].id).toBe("pines");
        expect(hello.calls[0].id).toBe(c.id);

        expect(got[1]!.event).toBe("connected");
        const names = got.map((e) => e.event);
        expect(names).toContain("user.message");
        const message = JSON.parse(got.find((e) => e.event === "user.message")!.data);
        expect(message).toMatchObject({ text: "Hello", agent: "pines", callId: c.id });
    });

    it("carries llm.toolCall and llm.toolResult, which pc.stream() does not", async () => {
        const { base, agents, store } = await boot();
        const c = call();
        agents[0]!.emit("call.started", c);

        const res = await fetch(`${base}/events`);
        const got = await readEvents(res, 4, () => {
            agents[0]!.emit("llm.toolCall", {
                toolCalls: [{ name: "checkAvailability", arguments: '{"partySize":2}' }],
            }, c);
            store.toolResult("pines", c, { available: true });
        });

        const toolCall = got.find((e) => e.event === "llm.toolCall");
        expect(JSON.parse(toolCall!.data)).toEqual({
            agent: "pines", callId: c.id,
            toolCalls: [{ name: "checkAvailability", arguments: { partySize: 2 } }],
        });
        const toolResult = got.find((e) => e.event === "llm.toolResult");
        expect(JSON.parse(toolResult!.data)).toEqual({
            agent: "pines", callId: c.id, name: "checkAvailability", result: { available: true },
        });
    });

    it("?agent= narrows the stream to that agent", async () => {
        const a = new FakeAgent("pines");
        const b = new FakeAgent("nova");
        const { base } = await boot({ agents: [a, b] });

        const res = await fetch(`${base}/events?agent=nova`);
        const got = await readEvents(res, 3, () => {
            a.emit("user.message", { text: "from pines" }, call("call_a"));
            b.emit("user.message", { text: "from nova" }, call("call_b"));
        });

        const messages = got.filter((e) => e.event === "user.message").map((e) => JSON.parse(e.data));
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ agent: "nova", text: "from nova" });
    });

    it("writes an (event, callId, messageId) frame once, even re-sent — tk-476280", async () => {
        // The call proxy an Agent wires with `forwardCallEvents` (or a re-sent
        // wire frame from the server) can put the SAME logical event on the
        // agent bus twice. `pc.stream()`/`/events` must still write it once.
        const { base, agents } = await boot();
        const c = call("call_dup", "webrtc");
        agents[0]!.emit("call.started", c);

        const res = await fetch(`${base}/events`);
        const got = await readEvents(res, 4, () => {
            agents[0]!.emit("message.confirmed", { text: "Hi there", messageId: "msg_1" }, c);
            agents[0]!.emit("message.confirmed", { text: "Hi there", messageId: "msg_1" }, c); // re-sent
            agents[0]!.emit("call.ended", c, "done");
        });

        const confirmed = got.filter((e) => e.event === "message.confirmed");
        expect(confirmed).toHaveLength(1);
    });
});

// ── /token and /chat-token ───────────────────────────────────────────────

describe("console server — tokens", () => {
    it("mints a webrtc token with { console: true } and never exposes the API key", async () => {
        const { base, createToken } = await boot();
        const res = await fetch(`${base}/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agent: "pines" }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            token: "tok_pines", server: "https://voice.pinecall.io", agent: "pines",
        });
        expect(createToken).toHaveBeenCalledWith("webrtc", "pines", { console: true });
    });

    it("mints a chat token on /chat-token", async () => {
        const { base, createToken } = await boot();
        const res = await fetch(`${base}/chat-token`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agent: "pines" }),
        });
        expect(res.status).toBe(200);
        expect(createToken).toHaveBeenCalledWith("chat", "pines", { console: true });
    });

    it("404s an agent this process does not run", async () => {
        const { base } = await boot();
        const res = await fetch(`${base}/token`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agent: "ghost" }),
        });
        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe("no_such_agent");
    });

    it("passes the voice server's refusal through as 502", async () => {
        const agent = new FakeAgent("pines");
        const { host } = fakeHost([agent]);
        (host as any).createToken = async () => { throw new Error("Agent 'pines' is not online"); };
        const store = createTranscriptStore();
        const server = await startConsoleServer({
            host, store, calls: createCallsModel({ store, agents: host.agents as any }),
            hostname: "127.0.0.1", port: 0, uiDir: null,
        });
        servers.push(server);

        const res = await fetch(`http://127.0.0.1:${server.port}/token`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agent: "pines" }),
        });
        expect(res.status).toBe(502);
        expect((await res.json()).message).toContain("not online");
    });

    it("rejects GET on the token endpoints", async () => {
        const { base } = await boot();
        expect((await fetch(`${base}/token`)).status).toBe(405);
    });
});

// ── The run key ──────────────────────────────────────────────────────────

describe("console server — the run key", () => {
    it("loopback needs nothing", async () => {
        const { base, server } = await boot();
        expect(server.guarded).toBe(false);
        expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
        expect((await fetch(`${base}/api/agents`)).status).toBe(200);
    });

    it("a guarded bind is 401 without the key, 200 with it — and sets the cookie", async () => {
        const { base, server } = await boot({ requireKey: true, key: "s3cret" });
        expect(server.guarded).toBe(true);
        expect(server.url).toContain("?k=s3cret");

        const denied = await fetch(`${base}/api/agents`);
        expect(denied.status).toBe(401);

        const allowed = await fetch(`${base}/api/agents?k=s3cret`);
        expect(allowed.status).toBe(200);
        expect(allowed.headers.get("set-cookie")).toContain("pc_console=s3cret");

        const viaCookie = await fetch(`${base}/api/calls`, { headers: { Cookie: "pc_console=s3cret" } });
        expect(viaCookie.status).toBe(200);

        const wrongCookie = await fetch(`${base}/api/calls`, { headers: { Cookie: "pc_console=nope" } });
        expect(wrongCookie.status).toBe(401);
    });
});

// ── Static files ─────────────────────────────────────────────────────────

describe("console server — the app", () => {
    it("explains itself when dist/ui is missing, listing the endpoints", async () => {
        const { base } = await boot({ uiDir: null });
        const res = await fetch(`${base}/`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/html");
        const html = await res.text();
        expect(html).toContain("the web app is not built");
        expect(html).toContain("/events");
        expect(html).toContain("/api/agents");
    });

    it("serves the built app and falls back to index.html for SPA routes", async () => {
        const { mkdtempSync, writeFileSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const dir = mkdtempSync(join(tmpdir(), "pc-ui-"));
        writeFileSync(join(dir, "index.html"), "<!doctype html><title>console</title>");
        writeFileSync(join(dir, "app.js"), "export const ok = 1;\n");

        const { base } = await boot({ uiDir: dir });
        expect(await (await fetch(`${base}/`)).text()).toContain("<title>console</title>");

        const js = await fetch(`${base}/app.js`);
        expect(js.headers.get("content-type")).toContain("text/javascript");
        expect(await js.text()).toContain("export const ok");

        // A client-side route, and a traversal attempt: both land on the app.
        expect(await (await fetch(`${base}/calls/call_1`)).text()).toContain("<title>console</title>");
        expect(await (await fetch(`${base}/../../etc/passwd`)).text()).toContain("<title>console</title>");
    });

    it("404s an unknown /api/ path instead of serving the app", async () => {
        const { base } = await boot();
        expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    });
});

// ── Ports ────────────────────────────────────────────────────────────────

describe("console server — ports", () => {
    it("takes the next port when the asked-for one is busy", async () => {
        const first = await boot();
        const second = await boot({ port: first.server.port });
        expect(second.server.port).toBe(first.server.port + 1);
    });

    it("fails loudly when the whole range is taken", async () => {
        const held = await boot();
        await expect(startConsoleServer({
            host: fakeHost([new FakeAgent("pines")]).host,
            store: createTranscriptStore(),
            calls: createCallsModel({ store: createTranscriptStore(), agents: new Map() }),
            hostname: "127.0.0.1", port: held.server.port, portTries: 0, uiDir: null,
        })).rejects.toThrow(/in use/);
    });
});

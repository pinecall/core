/**
 * observe — the long poll.
 *
 * These run against a REAL WebSocket server on localhost, not a mock: the
 * things worth pinning here are socket-lifetime facts, and a stubbed socket
 * cannot lie about being closed. What is pinned:
 *
 *  · news returns fast and does not wait out the budget;
 *  · silence returns `{ timedOut: true }` with the cursor UNMOVED — never an
 *    error, because an error ends the loop the tool exists to sustain;
 *  · `log.caught_up` alone is NOT news (it repeats a seq and arrives the
 *    instant the backlog drains — treating it as news would make every poll
 *    return empty immediately);
 *  · nothing leaks: the server sees zero clients after every path.
 *
 * The against-production proof is on the card.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { WebSocketServer, type WebSocket as WS } from "ws";
import type { AddressInfo } from "node:net";
import { attachOnce, attachUrl, AttachClosedError } from "../src/attach.js";
import { Session } from "../src/session.js";
import observe from "../src/tools/observe.js";
import { tools } from "../src/tools/index.js";

const CALL = "CAtest1";

function entry(seq: number, type: string, data: Record<string, unknown> = {}, call: string | null = CALL) {
    return { seq, ts: 1786538100 + seq, call, agent: "dev-a", type, ephemeral: false, data };
}

/** A stand-in for the voice server's /v1/attach, driven per test. */
class FakeLog {
    readonly wss: WebSocketServer;
    /** What the handshake saw — the query is the whole resume protocol. */
    lastQuery?: URLSearchParams;
    onConnect: (ws: WS) => void = () => { };

    constructor(wss: WebSocketServer) {
        this.wss = wss;
        wss.on("connection", (ws, req) => {
            this.lastQuery = new URL(req.url ?? "/", "http://x").searchParams;
            this.onConnect(ws);
        });
    }

    get url(): string {
        return `http://127.0.0.1:${(this.wss.address() as AddressInfo).port}`;
    }

    /** Every path must leave the server with no clients — that IS the leak check. */
    get clients(): number {
        return this.wss.clients.size;
    }

    close(): Promise<void> {
        return new Promise((r) => {
            for (const c of this.wss.clients) c.terminate();
            this.wss.close(() => r());
        });
    }
}

async function startLog(): Promise<FakeLog> {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss.once("listening", r));
    return new FakeLog(wss);
}

/** The socket is closed asynchronously; give the server a tick to notice. */
async function settle(log: FakeLog) {
    for (let i = 0; i < 40 && log.clients > 0; i++) await new Promise((r) => setTimeout(r, 25));
}

let log: FakeLog;
beforeEach(async () => { log = await startLog(); });
afterEach(async () => { await log.close(); vi.unstubAllGlobals(); });

describe("attachUrl", () => {
    it("speaks ws:// and carries the cursor — a reconnect IS the same URL with a fresher after", () => {
        const url = new URL(attachUrl({ server: "https://voice.pinecall.io/", token: "t", call: CALL, after: 12 }));
        expect(url.protocol).toBe("wss:");
        expect(url.pathname).toBe("/v1/attach");
        expect(url.searchParams.get("call")).toBe(CALL);
        expect(url.searchParams.get("after")).toBe("12");
        expect(url.searchParams.get("agent")).toBeNull();
    });
});

describe("attachOnce", () => {
    it("returns as soon as entries arrive, well inside the budget, and closes the socket", async () => {
        log.onConnect = (ws) => {
            ws.send(JSON.stringify(entry(7, "log.caught_up", { seq: 7 })));
            setTimeout(() => ws.send(JSON.stringify(entry(8, "user.message", { text: "hola" }))), 40);
        };

        const t0 = Date.now();
        const res = await attachOnce({ server: log.url, token: "t", call: CALL, after: 6 }, 10_000);

        expect(res.timedOut).toBe(false);
        expect(Date.now() - t0).toBeLessThan(3_000);
        expect(res.entries.map((e) => e.seq)).toEqual([7, 8]);
        await settle(log);
        expect(log.clients).toBe(0);
    });

    it("collects the whole burst of a turn rather than answering with half of it", async () => {
        log.onConnect = (ws) => {
            ws.send(JSON.stringify(entry(8, "turn.start", { turn: 1, role: "user" })));
            setTimeout(() => ws.send(JSON.stringify(entry(9, "user.message", { text: "hola" }))), 30);
            setTimeout(() => ws.send(JSON.stringify(entry(10, "bot.finished", { text: "buenas" }))), 60);
        };

        const res = await attachOnce({ server: log.url, token: "t", call: CALL, after: 7 }, 10_000);
        expect(res.entries.map((e) => e.seq)).toEqual([8, 9, 10]);
    });

    it("a quiet log times out — no error, and no socket left behind", async () => {
        log.onConnect = () => { /* say nothing at all */ };

        const res = await attachOnce({ server: log.url, token: "t", call: CALL, after: 3 }, 300);
        expect(res).toMatchObject({ timedOut: true, entries: [] });
        await settle(log);
        expect(log.clients).toBe(0);
    });

    it("caught_up alone is NOT news — it repeats a seq and would make every poll return empty", async () => {
        log.onConnect = (ws) => ws.send(JSON.stringify(entry(3, "log.caught_up", { seq: 3 })));

        const res = await attachOnce({ server: log.url, token: "t", call: CALL, after: 3 }, 400);
        expect(res.timedOut).toBe(true);
        expect(res.entries).toHaveLength(1); // kept for the reducer, just not woken up for
    });

    it("a refusal close is surfaced, not swallowed as a timeout", async () => {
        log.onConnect = (ws) => ws.close(4001, "bad token");

        await expect(attachOnce({ server: log.url, token: "t", call: CALL, after: 0 }, 5_000))
            .rejects.toBeInstanceOf(AttachClosedError);
        await settle(log);
        expect(log.clients).toBe(0);
    });

    it("a polite hang-up with news already in hand is an answer, not an error", async () => {
        log.onConnect = (ws) => {
            ws.send(JSON.stringify(entry(4, "call.ended", { reason: "hangup", duration: 3 })));
            setTimeout(() => ws.close(1000, "done"), 20);
        };

        const res = await attachOnce({ server: log.url, token: "t", call: CALL, after: 3 }, 5_000);
        expect(res.timedOut).toBe(false);
        expect(res.entries).toHaveLength(1);
    });
});

// ── The tool ────────────────────────────────────────────────────────────────

function session(): Session {
    return new Session({ PINECALL_API_KEY: "pk_test_key" } as NodeJS.ProcessEnv);
}

/** Mint answers with the fake log's address, so the tool attaches to it. */
function stubMint(server: string) {
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
        const url = String(input);
        if (url.includes("/stream/token")) {
            return new Response(JSON.stringify({ token: "str_x", server, expires_in: 60 }));
        }
        if (url.includes("/api/sdk/agents")) {
            return new Response(JSON.stringify({ agents: [{ slug: "dev-a" }] }));
        }
        throw new Error(`unstubbed ${url}`);
    }));
}

describe("observe", () => {
    it("is registered and its manual is one terse block", () => {
        expect(tools.find((t) => t.name === "observe")).toBe(observe);
        expect(observe.manual.length).toBeLessThan(600);
    });

    it("refuses without a target rather than guessing which log to tail", async () => {
        await expect(observe.handler({}, { session: session() })).rejects.toThrow(/call_id|agent/);
    });

    it("call mode answers in the get_call shape, with the cursor advanced", async () => {
        stubMint(log.url);
        log.onConnect = (ws) => {
            ws.send(JSON.stringify(entry(8, "user.message", { text: "quiero reservar", final: true })));
            ws.send(JSON.stringify(entry(9, "tool.call", { id: "t1", name: "book", args: { day: "jueves" } })));
        };

        const out: any = await observe.handler({ call_id: CALL, agent: "dev-a", after: 7 }, { session: session() });

        expect(out.timedOut).toBe(false);
        expect(out.nextAfter).toBe(9);
        // Exactly what `get_call` would have produced from the same entries —
        // including the reducer's own system line for a running tool.
        expect(out.messages).toEqual([
            { seq: 8, role: "user", text: "quiero reservar" },
            { seq: 9, role: "system", text: "Using book…" },
        ]);
        expect(out.toolCalls[0]).toMatchObject({ name: "book", args: { day: "jueves" }, pending: true });
        expect(out).toHaveProperty("phase");
        expect(out).toHaveProperty("caughtUp");
        // The cursor travels in the URL — that is the whole resume protocol.
        expect(log.lastQuery?.get("after")).toBe("7");
        expect(log.lastQuery?.get("call")).toBe(CALL);
    });

    it("silence returns timedOut with the cursor UNMOVED, and never throws", async () => {
        stubMint(log.url);
        log.onConnect = () => { /* nothing happens */ };

        const out: any = await observe.handler(
            { call_id: CALL, agent: "dev-a", after: 42, waitSeconds: 1 },
            { session: session() },
        );

        expect(out).toEqual({ timedOut: true, nextAfter: 42, call: CALL });
        await settle(log);
        expect(log.clients).toBe(0);
    });

    it("agent mode hands back the id of the call that just started", async () => {
        stubMint(log.url);
        // ⚠️ On an agent log the envelope's `call` is null; the id is in data.call.
        log.onConnect = (ws) => {
            ws.send(JSON.stringify(
                entry(5, "call.started", { call: "CAnew99", direction: "inbound", from: "+1", to: "+2" }, null),
            ));
        };

        const out: any = await observe.handler({ agent: "dev-a", after: 4 }, { session: session() });

        expect(out.call).toBe("CAnew99");
        expect(out.live).toBe(true);
        expect(out.nextAfter).toBe(5);
        expect(out.calls[0]).toMatchObject({ call: "CAnew99", direction: "inbound" });
        expect(log.lastQuery?.get("agent")).toBe("dev-a");
        expect(log.lastQuery?.get("call")).toBeNull();
    });

    it("caps waitSeconds instead of holding a socket open past the cap", async () => {
        expect(observe.schema.waitSeconds.safeParse(51).success).toBe(false);
        expect(observe.schema.waitSeconds.safeParse(50).success).toBe(true);
    });
});

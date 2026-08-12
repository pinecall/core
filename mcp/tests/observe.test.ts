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
import { resetFollows } from "../src/follow.js";

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
// The follow memo is process-wide by design — each test starts from nothing.
beforeEach(async () => { resetFollows(); log = await startLog(); });
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

    it("a 4xxx refusal is surfaced, not swallowed as a timeout", async () => {
        log.onConnect = (ws) => ws.close(4001, "bad token");

        await expect(attachOnce({ server: log.url, token: "t", call: CALL, after: 0 }, 5_000))
            .rejects.toBeInstanceOf(AttachClosedError);
        await settle(log);
        expect(log.clients).toBe(0);
    });

    // ⚠️ Measured against voice.pinecall.io: a bad token is NOT a 4xxx close.
    // The server sends an error FRAME and then closes 1000 — the politest code
    // there is — so the frame, not the code, is what a refusal looks like here.
    it("an error frame followed by a polite 1000 is a refusal, not an empty answer", async () => {
        log.onConnect = (ws) => {
            ws.send(JSON.stringify({ error: "Invalid or expired token" }));
            setTimeout(() => ws.close(1000, ""), 20);
        };

        await expect(attachOnce({ server: log.url, token: "bogus", agent: "dev-a", after: 0 }, 5_000))
            .rejects.toThrow(/Invalid or expired token/);
        await settle(log);
        expect(log.clients).toBe(0);
    });

    it("an entry that merely carries an error in its payload is NOT a refusal", async () => {
        log.onConnect = (ws) => {
            ws.send(JSON.stringify(entry(5, "tool.result", { id: "t1", error: "book failed" })));
        };

        const res = await attachOnce({ server: log.url, token: "t", call: CALL, after: 4 }, 5_000);
        expect(res.timedOut).toBe(false);
        expect(res.entries).toHaveLength(1);
    });

    // ── The 1006 regression (tk-8f3277) ────────────────────────────────────
    // A quiet agent-log socket dropped by the server or an intermediary reports
    // 1006: "abnormal, no close frame". Nobody said no — that is SILENCE. It
    // used to be classified as a refusal, so EVERY observe(agent) on an idle
    // agent threw AttachClosedError and ended the caller's loop.
    it("a socket dropped WITHOUT a close frame (1006) is silence, not a refusal", async () => {
        log.onConnect = (ws) => setTimeout(() => ws.terminate(), 30); // no close frame at all

        const res = await attachOnce({ server: log.url, token: "t", agent: "dev-a", after: 5 }, 5_000);

        expect(res).toMatchObject({ timedOut: true, entries: [] });
        await settle(log);
        expect(log.clients).toBe(0);
    });

    it("1006 after only a caught_up marker — the exact live repro — still times out", async () => {
        log.onConnect = (ws) => {
            ws.send(JSON.stringify(entry(9, "log.caught_up", { seq: 9 }, null)));
            setTimeout(() => ws.terminate(), 30);
        };

        const res = await attachOnce({ server: log.url, token: "t", agent: "dev-a", after: 9 }, 5_000);
        expect(res.timedOut).toBe(true);
        expect(res.entries).toHaveLength(1);
    });

    it("1006 AFTER news answers with the news", async () => {
        log.onConnect = (ws) => {
            ws.send(JSON.stringify(entry(10, "user.message", { text: "hola" })));
            setTimeout(() => ws.terminate(), 60);
        };

        const res = await attachOnce({ server: log.url, token: "t", call: CALL, after: 9 }, 5_000);
        expect(res.timedOut).toBe(false);
        expect(res.entries.map((e) => e.seq)).toEqual([10]);
    });

    it("a connection that never opens still throws — that is a real problem, not silence", async () => {
        await expect(attachOnce({ server: "http://127.0.0.1:1", token: "t", agent: "dev-a", after: 0 }, 5_000))
            .rejects.toBeInstanceOf(Error);
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

/**
 * Mint answers with the fake log's address, so the tool attaches to it.
 * `http` lets a test also serve the two HTTP log reads agent mode makes:
 * `/v1/agents/<slug>/calls` (where the log's head is) and
 * `/v1/calls/<id>/events` (a just-started call's opening entries).
 */
function stubMint(server: string, http: Record<string, unknown> = {}) {
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
        const url = String(input);
        if (url.includes("/stream/token")) {
            return new Response(JSON.stringify({ token: "str_x", server, expires_in: 60 }));
        }
        if (url.includes("/api/sdk/agents")) {
            return new Response(JSON.stringify({ agents: [{ slug: "dev-a" }] }));
        }
        for (const [path, body] of Object.entries(http)) {
            if (url.includes(path)) return new Response(JSON.stringify(body));
        }
        throw new Error(`unstubbed ${url}`);
    }));
}

/** The agent log is lifecycle-only: the envelope's `call` is null. */
function lifecycle(seq: number, type: string, data: Record<string, unknown>) {
    return entry(seq, type, data, null);
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

    // ── Agent mode = the whole loop (tk-8f3277) ─────────────────────────────

    it("a quiet agent log answers timedOut — even when the socket is dropped with 1006", async () => {
        stubMint(log.url, {
            // One old, finished call: the head is 3, so the poll waits for what
            // comes NEXT instead of replaying it.
            "/v1/agents/dev-a/calls": {
                entries: [
                    lifecycle(2, "call.started", { call: "CAold" }),
                    lifecycle(3, "call.ended", { call: "CAold", reason: "hangup" }),
                ],
                next: 3,
            },
        });
        log.onConnect = (ws) => setTimeout(() => ws.terminate(), 30); // no close frame

        const out: any = await observe.handler({ agent: "dev-a", waitSeconds: 2 }, { session: session() });

        expect(out).toMatchObject({ timedOut: true, agent: "dev-a", following: "agent" });
        // Started from the HEAD of the agent log — "from now", not a replay.
        expect(log.lastQuery?.get("after")).toBe("3");
        expect(out.nextAfter).toBe(3);
    });

    it("a call starting on the agent comes back with its id AND its first entries, in one answer", async () => {
        stubMint(log.url, {
            "/v1/calls/CAnew99/events": {
                entries: [
                    entry(1, "call.started", { direction: "inbound" }, "CAnew99"),
                    entry(2, "user.message", { text: "hola, quiero reservar", final: true }, "CAnew99"),
                ],
                live: true,
                next: 2,
            },
        });
        // ⚠️ On an agent log the envelope's `call` is null; the id is in data.call.
        log.onConnect = (ws) => {
            ws.send(JSON.stringify(
                lifecycle(5, "call.started", { call: "CAnew99", direction: "inbound", from: "+1", to: "+2" }),
            ));
        };

        const out: any = await observe.handler({ agent: "dev-a", after: 4 }, { session: session() });

        expect(out.call).toBe("CAnew99");
        expect(out.following).toBe("call");           // already switched, no manual step
        expect(out.messages).toEqual([{ seq: 2, role: "user", text: "hola, quiero reservar" }]);
        expect(out.nextAfter).toBe(5);                // the AGENT cursor still travels
        expect(out.callAfter).toBe(2);
        expect(out.calls[0]).toMatchObject({ call: "CAnew99", direction: "inbound" });
        expect(log.lastQuery?.get("agent")).toBe("dev-a");
    });

    it("the SAME observe(agent, after) then streams that call's transcript — no switch by the caller", async () => {
        // Step 1: the call appears (as above), which is what arms the follow.
        stubMint(log.url, {
            "/v1/calls/CAnew99/events": {
                entries: [entry(1, "call.started", { direction: "inbound" }, "CAnew99")],
                live: true,
                next: 1,
            },
        });
        log.onConnect = (ws) =>
            ws.send(JSON.stringify(lifecycle(5, "call.started", { call: "CAnew99" })));
        const first: any = await observe.handler({ agent: "dev-a", after: 4 }, { session: session() });
        expect(first.following).toBe("call");

        // Step 2: the caller loops with exactly what it was handed. It must now
        // be attached to the CALL's log, not the agent's.
        log.onConnect = (ws) => {
            ws.send(JSON.stringify(entry(2, "user.message", { text: "el jueves", final: true }, "CAnew99")));
        };
        const second: any = await observe.handler(
            { agent: "dev-a", after: first.nextAfter },
            { session: session() },
        );

        expect(log.lastQuery?.get("call")).toBe("CAnew99");
        expect(log.lastQuery?.get("after")).toBe("1");     // resumed the call cursor for us
        expect(second.following).toBe("call");
        expect(second.messages).toEqual([{ seq: 2, role: "user", text: "el jueves" }]);
        expect(second.callAfter).toBe(2);
        expect(second.nextAfter).toBe(5);

        // Step 3: it ends → the loop goes back to waiting for the next call.
        log.onConnect = (ws) => {
            ws.send(JSON.stringify(entry(3, "call.ended", { reason: "hangup", duration: 12 }, "CAnew99")));
        };
        const third: any = await observe.handler(
            { agent: "dev-a", after: second.nextAfter },
            { session: session() },
        );
        expect(third.following).toBe("agent");

        // Step 4: same call again, and it is on the AGENT log once more.
        log.onConnect = () => { /* quiet */ };
        const fourth: any = await observe.handler(
            { agent: "dev-a", after: third.nextAfter, waitSeconds: 1 },
            { session: session() },
        );
        expect(fourth.timedOut).toBe(true);
        expect(log.lastQuery?.get("agent")).toBe("dev-a");
        expect(log.lastQuery?.get("call")).toBeNull();
    });

    // Seen for real: a chat session left open on dev-bistro never ends, and a
    // loop pinned to it would be deaf to every phone call that follows.
    it("a followed call that goes silent does not pin the loop — a newer live call wins", async () => {
        const stale = {
            "/v1/agents/dev-a/calls": {
                entries: [lifecycle(5, "call.started", { call: "CAstale" })],
                next: 5,
            },
            "/v1/calls/CAstale/events": {
                entries: [entry(1, "call.started", { direction: "inbound" }, "CAstale")],
                live: true,
                next: 1,
            },
        };
        stubMint(log.url, stale);

        // Round 1 adopts the already-running stale call — it is all there is.
        const first: any = await observe.handler({ agent: "dev-a" }, { session: session() });
        expect(first.call).toBe("CAstale");

        // Round 2: the stale call says nothing for the whole budget, and a
        // phone call has since started.
        stubMint(log.url, {
            ...stale,
            "/v1/agents/dev-a/calls": {
                entries: [
                    lifecycle(5, "call.started", { call: "CAstale" }),
                    lifecycle(9, "call.started", { call: "CAphone", direction: "inbound", from: "+34600" }),
                ],
                next: 9,
            },
            "/v1/calls/CAphone/events": {
                entries: [entry(1, "user.message", { text: "buenas, quería una mesa", final: true }, "CAphone")],
                live: true,
                next: 1,
            },
        });
        log.onConnect = () => { /* CAstale is silent */ };
        const second: any = await observe.handler(
            { agent: "dev-a", after: first.nextAfter, waitSeconds: 1 },
            { session: session() },
        );

        expect(second.call).toBe("CAphone");
        expect(second.following).toBe("call");
        expect(second.timedOut).toBe(false);
        expect(second.messages).toEqual([{ seq: 1, role: "user", text: "buenas, quería una mesa" }]);
    });

    it("a call already running when the loop starts is picked up, not waited for", async () => {
        stubMint(log.url, {
            "/v1/agents/dev-a/calls": {
                entries: [lifecycle(7, "call.started", { call: "CAlive1", direction: "inbound" })],
                next: 7,
            },
            "/v1/calls/CAlive1/events": {
                entries: [entry(4, "bot.speaking", { id: "b1", text: "buenas" }, "CAlive1")],
                live: true,
                next: 4,
            },
        });

        const out: any = await observe.handler({ agent: "dev-a" }, { session: session() });

        expect(out.call).toBe("CAlive1");
        expect(out.following).toBe("call");
        expect(out.messages).toEqual([{ seq: 4, role: "bot", text: "buenas" }]);
    });

    it("caps waitSeconds instead of holding a socket open past the cap", async () => {
        expect(observe.schema.waitSeconds.safeParse(51).success).toBe(false);
        expect(observe.schema.waitSeconds.safeParse(50).success).toBe(true);
    });
});

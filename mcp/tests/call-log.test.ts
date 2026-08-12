/**
 * The call-log tools.
 *
 * Two things are worth pinning here, and both are shape traps rather than
 * plumbing:
 *
 *  · the AGENT log puts the call id in `data.call` while the envelope's `call`
 *    is null — reading `entry.call` alone yields a list of nulls, silently;
 *  · `truncated` must resume at the last entry ACTUALLY applied, not at the
 *    server's cursor, or the tail of a cut page is skipped forever.
 *
 * `fetch` is stubbed so both the token mint and the log read are covered
 * without a network — the real-server proof is on the card.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { reduceAgentLog, maxSeq, tsToIso } from "../src/call-log.js";
import { Session } from "../src/session.js";
import listCalls from "../src/tools/list-calls.js";
import getCall from "../src/tools/get-call.js";
import { tools } from "../src/tools/index.js";

const T0 = 1786538100;

function session(): Session {
    return new Session({ PINECALL_API_KEY: "pk_test_key" } as NodeJS.ProcessEnv);
}

/** Route every URL this pair of tools can produce. */
function stubFetch(pages: Record<string, unknown>) {
    return vi.fn(async (input: any) => {
        const url = String(input);
        if (url.includes("/stream/token")) {
            return new Response(JSON.stringify({ token: "str_x", server: "https://voice.pinecall.io", expires_in: 60 }));
        }
        if (url.includes("/api/sdk/agents")) {
            return new Response(JSON.stringify({ agents: [{ slug: "dev-a" }] }));
        }
        const after = new URL(url).searchParams.get("after") ?? "0";
        const body = pages[after];
        if (!body) throw new Error(`unstubbed page after=${after} (${url})`);
        return new Response(JSON.stringify(body));
    });
}

afterEach(() => vi.unstubAllGlobals());

describe("reduceAgentLog", () => {
    it("finds the call id in data.call — the envelope's call is null on an agent log", () => {
        const rows = reduceAgentLog([
            { seq: 1, ts: T0, call: null, agent: "dev-a", ephemeral: false, type: "call.started", data: { direction: "inbound", from: "chat", to: "chat", channel: "chat", call: "c1" } },
            { seq: 2, ts: T0 + 9, call: null, agent: "dev-a", ephemeral: false, type: "call.ended", data: { reason: "hangup", duration: 9.5, call: "c1" } },
        ] as any);

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            call: "c1",
            live: false,
            direction: "inbound",
            from: "chat",
            reason: "hangup",
            durationSec: 9.5,
        });
        expect(rows[0]!.startedAt).toBe(new Date(T0 * 1000).toISOString());
    });

    it("a started-and-not-ended call is live; newest call comes first", () => {
        const rows = reduceAgentLog([
            { seq: 1, ts: T0, call: null, agent: "dev-a", ephemeral: false, type: "call.started", data: { call: "old", direction: "inbound", from: "chat" } },
            { seq: 2, ts: T0 + 1, call: null, agent: "dev-a", ephemeral: false, type: "call.ended", data: { call: "old", reason: "hangup", duration: 1 } },
            { seq: 3, ts: T0 + 50, call: null, agent: "dev-a", ephemeral: false, type: "call.started", data: { call: "new", direction: "inbound", from: "chat" } },
        ] as any);

        expect(rows.map((r) => r.call)).toEqual(["new", "old"]);
        expect(rows[0]!.live).toBe(true);
        expect(rows[1]!.live).toBe(false);
    });

    it("ignores entries that name no call, and log.gap noise", () => {
        expect(reduceAgentLog([
            { seq: 7, ts: T0, call: null, agent: "dev-a", ephemeral: false, type: "log.gap", data: { from: 0, resume_from: 8 } },
        ] as any)).toEqual([]);
    });
});

describe("maxSeq / tsToIso", () => {
    it("maxSeq keeps the cursor when a page is empty", () => {
        expect(maxSeq([], 12)).toBe(12);
        expect(maxSeq([{ seq: 4 }, { seq: 19 }] as any, 12)).toBe(19);
    });
    it("tsToIso survives a missing ts", () => {
        expect(tsToIso(undefined)).toBeUndefined();
        expect(tsToIso(T0)).toBe(new Date(T0 * 1000).toISOString());
    });
});

describe("list_calls", () => {
    it("pages the agent log until it stops advancing, then reduces to rows", async () => {
        vi.stubGlobal("fetch", stubFetch({
            "0": { entries: [{ seq: 1, ts: T0, call: null, agent: "dev-a", ephemeral: false, type: "call.started", data: { call: "c1", direction: "inbound", from: "chat" } }], live: true },
            "1": { entries: [{ seq: 2, ts: T0 + 5, call: null, agent: "dev-a", ephemeral: false, type: "call.ended", data: { call: "c1", reason: "hangup", duration: 5 } }], live: true },
            "2": { entries: [], live: true },
        }));

        const out: any = await listCalls.handler({ agent: "dev-a" }, { session: session() });
        expect(out.agent).toBe("dev-a");
        expect(out.calls).toHaveLength(1);
        expect(out.calls[0]).toMatchObject({ call: "c1", live: false, reason: "hangup" });
        expect(out.truncated).toBe(false);
    });

    it("live=true keeps only running calls", async () => {
        vi.stubGlobal("fetch", stubFetch({
            "0": { entries: [
                { seq: 1, ts: T0, call: null, agent: "dev-a", ephemeral: false, type: "call.started", data: { call: "done" } },
                { seq: 2, ts: T0 + 1, call: null, agent: "dev-a", ephemeral: false, type: "call.ended", data: { call: "done", reason: "hangup", duration: 1 } },
                { seq: 3, ts: T0 + 2, call: null, agent: "dev-a", ephemeral: false, type: "call.started", data: { call: "running" } },
            ] },
            "3": { entries: [] },
        }));

        const out: any = await listCalls.handler({ agent: "dev-a", live: true }, { session: session() });
        expect(out.calls.map((c: any) => c.call)).toEqual(["running"]);
    });
});

describe("get_call", () => {
    const callEntries = [
        { seq: 1, ts: T0, call: "c1", agent: "dev-a", ephemeral: false, type: "call.started", data: { direction: "inbound", from: "chat", to: "chat", channel: "chat" } },
        // an interim transcript, superseded by the final below — must collapse
        { seq: 2, ts: T0 + 1, call: "c1", agent: "dev-a", ephemeral: true, type: "user.message", data: { id: "u1", text: "where is my", final: false } },
        { seq: 3, ts: T0 + 2, call: "c1", agent: "dev-a", ephemeral: false, type: "user.message", data: { id: "u1", text: "where is my order ABC-123", final: true } },
        { seq: 4, ts: T0 + 3, call: "c1", agent: "dev-a", ephemeral: false, type: "tool.call", data: { id: "t1", name: "getOrderStatus", args: { orderId: "ABC-123" } } },
        { seq: 5, ts: T0 + 4, call: "c1", agent: "dev-a", ephemeral: false, type: "tool.result", data: { id: "t1", result: { port: "Rotterdam" }, ms: 12 } },
        { seq: 6, ts: T0 + 5, call: "c1", agent: "dev-a", ephemeral: false, type: "bot.speaking", data: { id: "b1", text: "It is held in customs in Rotterdam." } },
        { seq: 7, ts: T0 + 6, call: "c1", agent: "dev-a", ephemeral: false, type: "call.ended", data: { reason: "hangup", duration: 6 } },
    ];

    it("reduces a call to messages with seqs, tool calls with args and results", async () => {
        vi.stubGlobal("fetch", stubFetch({ "0": { entries: callEntries, live: false, next: 7 } }));

        const out: any = await getCall.handler({ call_id: "c1", agent: "dev-a" }, { session: session() });
        expect(out.call).toBe("c1");
        expect(out.phase).toBe("ended");
        expect(out.live).toBe(false);
        expect(out.truncated).toBe(false);
        expect(out.nextAfter).toBe(7);

        // The interim "where is my" collapsed into the final — one user bubble.
        const user = out.messages.filter((m: any) => m.role === "user");
        expect(user).toHaveLength(1);
        expect(user[0].text).toBe("where is my order ABC-123");
        expect(typeof user[0].seq).toBe("number");

        expect(out.toolCalls).toHaveLength(1);
        expect(out.toolCalls[0]).toMatchObject({ name: "getOrderStatus", args: { orderId: "ABC-123" }, result: { port: "Rotterdam" } });
        expect(out.messages.some((m: any) => m.role === "bot" && m.text.includes("Rotterdam"))).toBe(true);
    });

    it("truncates with a cursor that resumes at the last entry APPLIED, not the server's", async () => {
        vi.stubGlobal("fetch", stubFetch({ "0": { entries: callEntries, live: false, next: 7 } }));

        const p1: any = await getCall.handler({ call_id: "c1", agent: "dev-a", limit: 3 }, { session: session() });
        expect(p1.truncated).toBe(true);
        expect(p1.entryCount).toBe(3);
        expect(p1.nextAfter).toBe(3); // NOT the server's 7

        vi.stubGlobal("fetch", stubFetch({
            "3": { entries: callEntries.filter((e) => e.seq > 3), live: false, next: 7 },
        }));
        const p2: any = await getCall.handler({ call_id: "c1", agent: "dev-a", after: p1.nextAfter }, { session: session() });
        expect(p2.truncated).toBe(false);
        expect(p2.lastSeq).toBeGreaterThan(p1.nextAfter);
        expect(p2.nextAfter).toBe(7);
    });

    it("surfaces a declared gap instead of papering over it", async () => {
        vi.stubGlobal("fetch", stubFetch({
            "0": { entries: [
                { seq: 40, ts: T0, call: "c1", agent: "dev-a", ephemeral: false, type: "log.gap", data: { from: 0, resume_from: 41, snapshot: { phase: "ended", messages: [], open_tools: [] } } },
                { seq: 41, ts: T0 + 1, call: "c1", agent: "dev-a", ephemeral: false, type: "call.summary", data: { metrics: { duration: 6 }, reason: "hangup" } },
            ], live: false, next: 41 },
        }));

        const out: any = await getCall.handler({ call_id: "c1", agent: "dev-a" }, { session: session() });
        expect(out.gaps).toEqual([{ from: 0, resumeFrom: 41 }]);
        expect(out.summary).toBeTruthy();
    });

    it("resolves the agent set itself when the caller gives only a call id", async () => {
        const f = stubFetch({ "0": { entries: callEntries, live: false, next: 7 } });
        vi.stubGlobal("fetch", f);

        await getCall.handler({ call_id: "c1" }, { session: session() });
        expect(f.mock.calls.some((c) => String(c[0]).includes("/api/sdk/agents"))).toBe(true);
    });

    it("never echoes the API key into a result", async () => {
        vi.stubGlobal("fetch", stubFetch({ "0": { entries: callEntries, live: false, next: 7 } }));
        const out = await getCall.handler({ call_id: "c1", agent: "dev-a" }, { session: session() });
        expect(JSON.stringify(out)).not.toContain("pk_test_key");
    });
});

describe("registry", () => {
    it("both tools are registered, with a manual", () => {
        for (const name of ["list_calls", "get_call"]) {
            const t = tools.find((x) => x.name === name);
            expect(t, name).toBeTruthy();
            expect(t!.manual.length).toBeGreaterThan(50);
        }
    });
});

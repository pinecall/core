/**
 * Registration ordering — `agent.ready` and the token-mint race.
 *
 * The bug: `pc.agent()` returns synchronously and only QUEUES `agent.create`
 * on the socket. A consumer that registered an agent and minted a token in the
 * next statement had its HTTP mint overtake the WebSocket frame, and the
 * server answered `404 Agent '<id>' is not online` for a registration that was
 * perfectly valid — it just did not exist server-side yet.
 *
 * The contract now: `agent.ready` settles when the SERVER acks the
 * registration, and `createToken` is ordered after it for agents this client
 * owns. No sleeps, no retries in the caller.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const holder = vi.hoisted(() => ({ transport: null as any }));
const mint = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock("../src/transport/websocket.js", async () => {
    const { FakeTransport } = await import("../src/transport/fake.js");
    return {
        WebSocketTransport: class extends FakeTransport {
            constructor(_opts?: unknown) {
                super();
                holder.transport = this;
            }
        },
    };
});

vi.mock("../src/api/tokens.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, createToken: (...args: unknown[]) => mint.fn(...args) };
});

import { Pinecall, AgentConflictError } from "../src/client.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A connected client whose server side we drive by hand. */
async function connectedClient(opts: { autoReconnect?: boolean } = {}) {
    const pc = new Pinecall({ apiKey: "pk_test", apiUrl: "ws://localhost:1337", ...opts });
    await flush();
    const t = holder.transport;
    t.receive({ event: "connected", org_id: "org_test" });
    await pc.ready;
    return { pc, t };
}

beforeEach(() => {
    holder.transport = null;
    mint.fn.mockReset();
    mint.fn.mockResolvedValue({ token: "cht_test", server: "https://voice.pinecall.io", expiresIn: 60 });
});

describe("agent.ready — the server's ack, not the local call", () => {
    it("is pending until the server sends agent.created", async () => {
        const { pc, t } = await connectedClient();
        const agent = pc.agent("dev-ready-1", {});

        expect(agent.registered).toBe(false);
        let settled = false;
        agent.ready.then(() => { settled = true; });
        await flush();
        expect(settled).toBe(false);

        t.receive({ event: "agent.created", agent_id: "dev-ready-1" });
        await agent.ready;
        expect(agent.registered).toBe(true);
    });

    it("rejects on a terminal conflict so an awaiting caller fails loudly", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const { pc, t } = await connectedClient();
            const agent = pc.agent("dev-ready-2", {});
            pc.on("error", () => {}); // the client also emits it
            t.receive({
                event: "error", code: "AGENT_CONFLICT_FATAL", agent_id: "dev-ready-2",
                error: "Agent 'dev-ready-2' is already connected.", holder_alive: true,
            });
            await expect(agent.ready).rejects.toBeInstanceOf(AgentConflictError);
        } finally {
            spy.mockRestore();
        }
    });

    it("goes back to pending when the socket drops (the reconnect re-registers)", async () => {
        const { pc, t } = await connectedClient({ autoReconnect: false });
        const agent = pc.agent("dev-ready-3", {});
        t.receive({ event: "agent.created", agent_id: "dev-ready-3" });
        await agent.ready;

        t.simulateClose("network");
        expect(agent.registered).toBe(false);
        let settled = false;
        agent.ready.then(() => { settled = true; });
        await flush();
        expect(settled).toBe(false);
    });
});

describe("createToken — ordered after the registration ack", () => {
    it("register-then-mint with NO delay does not mint before the server acks", async () => {
        const { pc, t } = await connectedClient();

        // Exactly the consumer's sequence: register, then mint on the next line.
        const agent = pc.agent("dev-mint-1", {});
        const minted = pc.createToken("chat", "dev-mint-1");

        await flush();
        expect(mint.fn).not.toHaveBeenCalled(); // would have 404'd "is not online"

        t.receive({ event: "agent.created", agent_id: "dev-mint-1" });
        await expect(minted).resolves.toMatchObject({ token: "cht_test" });
        expect(mint.fn).toHaveBeenCalledTimes(1);
        expect(agent.registered).toBe(true);
    });

    it("mints straight through once the agent is registered", async () => {
        const { pc, t } = await connectedClient();
        pc.agent("dev-mint-2", {});
        t.receive({ event: "agent.created", agent_id: "dev-mint-2" });

        await expect(pc.createToken("webrtc", "dev-mint-2")).resolves.toMatchObject({ token: "cht_test" });
        expect(mint.fn).toHaveBeenCalledTimes(1);
    });

    it("agent.createToken() inherits the same ordering", async () => {
        const { pc, t } = await connectedClient();
        const agent = pc.agent("dev-mint-3", {});
        const minted = agent.createToken("chat");

        await flush();
        expect(mint.fn).not.toHaveBeenCalled();

        t.receive({ event: "agent.created", agent_id: "dev-mint-3" });
        await minted;
        expect(mint.fn).toHaveBeenCalledTimes(1);
    });

    it("does not wait for an agent this client does not own", async () => {
        const { pc } = await connectedClient();
        // No pc.agent() call — the agent lives in another process.
        await expect(pc.createToken("chat", "someone-elses-agent")).resolves.toMatchObject({ token: "cht_test" });
        expect(mint.fn).toHaveBeenCalledTimes(1);
    });

    it("surfaces the terminal conflict instead of minting a doomed token", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const { pc, t } = await connectedClient();
            pc.on("error", () => {});
            pc.agent("dev-mint-4", {});
            const minted = pc.createToken("chat", "dev-mint-4");
            t.receive({
                event: "error", code: "AGENT_CONFLICT_FATAL", agent_id: "dev-mint-4",
                error: "Agent 'dev-mint-4' is already connected.", holder_alive: true,
            });
            await expect(minted).rejects.toBeInstanceOf(AgentConflictError);
            expect(mint.fn).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });
});

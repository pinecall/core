/**
 * SERVER_AT_CAPACITY — a capacity refusal must reach the caller AS a capacity
 * refusal.
 *
 * The bug (2026-07-31): the voice server refused `agent.create` with
 * "Maximum clients (100) reached" but tagged the frame with the generic
 * REGISTRATION_ERROR code, so the SDK failed the registration with a plain
 * `Error` indistinguishable from a bad config. The only symptom the consumer
 * then saw was its next token mint answering `Agent 'x' is not online` — a
 * claim about the agent, when the truth was about the server. An engineer
 * spent an hour hunting a liveness race that did not exist.
 *
 * The contract: SERVER_AT_CAPACITY is its own code, its own typed error, and
 * carries the server's own words plus the slot counts. It is NOT a conflict,
 * so it must not enter the AGENT_CONFLICT retry machinery.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const holder = vi.hoisted(() => ({ transport: null as any }));

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

import { Pinecall, PinecallError, ServerAtCapacityError } from "../src/client.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

async function connectedClient() {
    const pc = new Pinecall({ apiKey: "pk_test", apiUrl: "ws://localhost:1337" });
    await flush();
    const t = holder.transport;
    t.receive({ event: "connected", org_id: "org_test" });
    await pc.ready;
    return { pc, t };
}

/** The frame the server sends when max_clients is exhausted. */
const CAPACITY_FRAME = {
    event: "error",
    code: "SERVER_AT_CAPACITY",
    agent_id: "dev-spa-test-1-97be-recepcion",
    error:
        "SERVER_AT_CAPACITY: Maximum clients (100) reached (100/100 slots used). " +
        "The server cannot register another agent until a slot is freed.",
    used: 100,
    limit: 100,
};

beforeEach(() => {
    holder.transport = null;
});

describe("SERVER_AT_CAPACITY", () => {
    it("rejects agent.ready with a typed ServerAtCapacityError, verbatim", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const { pc, t } = await connectedClient();
            pc.on("error", () => {});
            const agent = pc.agent("dev-spa-test-1-97be-recepcion", {});

            t.receive(CAPACITY_FRAME);

            const err = await agent.ready.then(
                () => null,
                (e: unknown) => e,
            );
            expect(err).toBeInstanceOf(ServerAtCapacityError);
            expect(err).toBeInstanceOf(PinecallError);
            const capErr = err as ServerAtCapacityError;
            expect(capErr.code).toBe("SERVER_AT_CAPACITY");
            expect(capErr.message).toBe(CAPACITY_FRAME.error); // verbatim
            expect(capErr.used).toBe(100);
            expect(capErr.limit).toBe(100);
            expect(capErr.agentId).toBe("dev-spa-test-1-97be-recepcion");
        } finally {
            spy.mockRestore();
        }
    });

    it("is not a conflict: it does not re-send agent.create on a backoff", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        const { pc, t } = await connectedClient();
        vi.useFakeTimers(); // only AFTER connecting — connectedClient awaits real timers
        try {
            pc.on("error", () => {});
            const agent = pc.agent("dev-spa-test-1-97be-recepcion", {});
            agent.ready.catch(() => {});
            const creates = () =>
                t.sentMessages.filter((m: any) => m.event === "agent.create").length;
            expect(creates()).toBe(1);

            t.receive(CAPACITY_FRAME);
            // Well past the conflict retry base (15s) and its first escalation.
            await vi.advanceTimersByTimeAsync(60_000);

            expect(creates()).toBe(1);
        } finally {
            vi.useRealTimers();
            spy.mockRestore();
        }
    });

    it("says the agent is NOT offline — the server is full", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const { pc, t } = await connectedClient();
            pc.on("error", () => {});
            const agent = pc.agent("dev-spa-test-1-97be-recepcion", {});
            t.receive(CAPACITY_FRAME);
            await agent.ready.catch(() => {});

            const printed = spy.mock.calls.flat().join("\n");
            expect(printed).toMatch(/capacity/i);
            expect(printed).toMatch(/not offline/i);
            expect(printed).not.toMatch(/is not online/i);
        } finally {
            spy.mockRestore();
        }
    });

    it("emits the same typed error on the client so it is catchable", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const { pc, t } = await connectedClient();
            const seen: unknown[] = [];
            pc.on("error", (e) => seen.push(e));
            pc.agent("dev-spa-test-1-97be-recepcion", {}).ready.catch(() => {});

            t.receive(CAPACITY_FRAME);
            await flush();

            expect(seen.some((e) => e instanceof ServerAtCapacityError)).toBe(true);
        } finally {
            spy.mockRestore();
        }
    });
});

/**
 * Registration-conflict retry — AGENT_CONFLICT / AGENT_IN_USE handling.
 *
 * Born from the 2026-07-25 landing outage: a restart raced the server's
 * stale-socket detection, every agent got AGENT_CONFLICT, and the SDK gave
 * up permanently → hours of silent downtime. The contract now: a conflict
 * schedules a registration retry; a confirmed registration clears it.
 */

import { describe, it, expect, vi } from "vitest";
import { ErrorHandler } from "../src/dispatch/handlers/error.js";
import { ConnectionHandler } from "../src/dispatch/handlers/connection.js";
import type { DispatchContext } from "../src/dispatch/handler.js";

const noopLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
} as any;

function makeCtx(
    overrides: Partial<DispatchContext["registration"]> = {},
    agent: any = null,
): DispatchContext {
    return {
        agent: () => agent,
        call: () => undefined,
        logger: noopLogger,
        send: () => {},
        onConnected: () => {},
        registration: {
            scheduleRetry: vi.fn(() => false),
            clear: vi.fn(),
            fail: vi.fn(),
            ...overrides,
        },
        emitClientEvent: vi.fn(),
        allAgents: () => [],
        whatsappSession: () => undefined,
    } as unknown as DispatchContext;
}

describe("ErrorHandler — registration conflicts", () => {
    it("schedules a retry on AGENT_CONFLICT", () => {
        const ctx = makeCtx();
        const handled = new ErrorHandler().handle(
            { event: "error", code: "AGENT_CONFLICT", error: "Agent 'pines' is already connected.", agent_id: "pines" } as any,
            ctx,
        );
        expect(handled).toBe(true);
        expect(ctx.registration.scheduleRetry).toHaveBeenCalledWith("pines", undefined);
        expect(ctx.emitClientEvent).toHaveBeenCalled(); // still surfaces the error
    });

    it("schedules a retry on AGENT_IN_USE", () => {
        const ctx = makeCtx();
        new ErrorHandler().handle(
            { event: "error", code: "AGENT_IN_USE", error: "already connected", agent_id: "docs" } as any,
            ctx,
        );
        expect(ctx.registration.scheduleRetry).toHaveBeenCalledWith("docs", undefined);
    });

    it("forwards the server's structured backoff hint", () => {
        const ctx = makeCtx();
        new ErrorHandler().handle(
            {
                event: "error", code: "AGENT_CONFLICT", error: "held",
                agent_id: "pines", retry_after_s: 120, holder_alive: true,
            } as any,
            ctx,
        );
        expect(ctx.registration.scheduleRetry).toHaveBeenCalledWith(
            "pines", { retryAfterS: 120, holderAlive: true },
        );
    });

    it("logs the conflict banner only on the FIRST rejection of an episode", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            // New client: returns true on the first conflict, false after.
            const ctx = makeCtx({ scheduleRetry: vi.fn()
                .mockReturnValueOnce(true)
                .mockReturnValue(false) });
            const wire = { event: "error", code: "AGENT_CONFLICT", error: "held", agent_id: "pines" } as any;
            new ErrorHandler().handle(wire, ctx);
            expect(spy).toHaveBeenCalledTimes(1);
            new ErrorHandler().handle(wire, ctx);
            new ErrorHandler().handle(wire, ctx);
            expect(spy).toHaveBeenCalledTimes(1); // still just the one banner
        } finally {
            spy.mockRestore();
        }
    });

    it("banners every rejection the coordinator calls a first one", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            // Two separate episodes (a clear in between) each earn a banner.
            const ctx = makeCtx({ scheduleRetry: vi.fn().mockReturnValue(true) });
            const wire = { event: "error", code: "AGENT_CONFLICT", error: "held", agent_id: "pines" } as any;
            new ErrorHandler().handle(wire, ctx);
            new ErrorHandler().handle(wire, ctx);
            expect(spy).toHaveBeenCalledTimes(2);
        } finally {
            spy.mockRestore();
        }
    });

    it("does not schedule a retry for unrelated errors", () => {
        const ctx = makeCtx();
        new ErrorHandler().handle(
            { event: "error", code: "INVALID_KEY", error: "Invalid API key" } as any,
            ctx,
        );
        expect(ctx.registration.scheduleRetry).not.toHaveBeenCalled();
    });

    it("survives a conflict the server did not attach an agent_id to", () => {
        const ctx = makeCtx();
        expect(() =>
            new ErrorHandler().handle(
                { event: "error", code: "AGENT_CONFLICT", error: "conflict" } as any,
                ctx,
            ),
        ).not.toThrow();
        // Nothing to key an episode on — no retry is scheduled.
        expect(ctx.registration.scheduleRetry).not.toHaveBeenCalled();
    });
});

describe("ErrorHandler — AGENT_CONFLICT_FATAL is terminal", () => {
    it("stops instead of retrying when the server proved the holder alive", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const ctx = makeCtx();
            const handled = new ErrorHandler().handle(
                {
                    event: "error", code: "AGENT_CONFLICT_FATAL", agent_id: "pines",
                    error: "Agent 'pines' is already connected.", holder_alive: true,
                } as any,
                ctx,
            );
            expect(handled).toBe(true);
            expect(ctx.registration.scheduleRetry).not.toHaveBeenCalled();
            expect(ctx.registration.fail).toHaveBeenCalledWith("pines");
            // The banner names both ways out.
            const banner = spy.mock.calls.map((c) => String(c[0])).join("\n");
            expect(banner).toContain("pinecall kick pines");
            expect(banner).toContain("different id");
        } finally {
            spy.mockRestore();
        }
    });

    it("falls back to a plain error event when there is no agent to fail", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const ctx = makeCtx();
            new ErrorHandler().handle(
                { event: "error", code: "AGENT_CONFLICT_FATAL", error: "held" } as any,
                ctx,
            );
            expect(ctx.emitClientEvent).toHaveBeenCalled();
            expect(ctx.registration.fail).not.toHaveBeenCalled();
            expect(ctx.registration.scheduleRetry).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });
});

describe("ConnectionHandler — retry state reset", () => {
    it("clears the retry on agent.created", () => {
        // `_markRegistered` is part of the real Agent's ack path (it settles
        // `agent.ready`); the double needs it, the assertions below are unchanged.
        const agent = { id: "pines", _flushPending: vi.fn(), _emitWire: vi.fn(), _markRegistered: vi.fn() };
        const ctx = makeCtx({}, agent);
        new ConnectionHandler().handle({ event: "agent.created", agent_id: "pines" } as any, ctx);
        expect(ctx.registration.clear).toHaveBeenCalledWith("pines");
        expect(agent._flushPending).toHaveBeenCalled();
    });

    it("clears the retry on agent.resumed", () => {
        // `_markRegistered` is part of the real Agent's ack path (it settles
        // `agent.ready`); the double needs it, the assertions below are unchanged.
        const agent = { id: "pines", _flushPending: vi.fn(), _emitWire: vi.fn(), _markRegistered: vi.fn() };
        const ctx = makeCtx({}, agent);
        new ConnectionHandler().handle({ event: "agent.resumed", agent_id: "pines" } as any, ctx);
        expect(ctx.registration.clear).toHaveBeenCalledWith("pines");
    });
});

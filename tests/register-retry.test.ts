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

function makeCtx(overrides: Partial<DispatchContext["client"]> = {}, agent: any = null): DispatchContext {
    return {
        agent: () => agent,
        call: () => undefined,
        logger: noopLogger,
        send: () => {},
        onConnected: () => {},
        client: {
            _emitWire: vi.fn(),
            _getAgent: () => undefined,
            _allAgents: () => [],
            _scheduleRegisterRetry: vi.fn(),
            _clearRegisterRetry: vi.fn(),
            _failRegisterRetry: vi.fn(),
            ...overrides,
        },
    };
}

describe("ErrorHandler — registration conflicts", () => {
    it("schedules a retry on AGENT_CONFLICT", () => {
        const ctx = makeCtx();
        const handled = new ErrorHandler().handle(
            { event: "error", code: "AGENT_CONFLICT", error: "Agent 'pines' is already connected.", agent_id: "pines" } as any,
            ctx,
        );
        expect(handled).toBe(true);
        expect(ctx.client._scheduleRegisterRetry).toHaveBeenCalledWith("pines", undefined);
        expect(ctx.client._emitWire).toHaveBeenCalled(); // still surfaces the error
    });

    it("schedules a retry on AGENT_IN_USE", () => {
        const ctx = makeCtx();
        new ErrorHandler().handle(
            { event: "error", code: "AGENT_IN_USE", error: "already connected", agent_id: "docs" } as any,
            ctx,
        );
        expect(ctx.client._scheduleRegisterRetry).toHaveBeenCalledWith("docs", undefined);
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
        expect(ctx.client._scheduleRegisterRetry).toHaveBeenCalledWith(
            "pines", { retryAfterS: 120, holderAlive: true },
        );
    });

    it("logs the conflict banner only on the FIRST rejection of an episode", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            // New client: returns true on the first conflict, false after.
            const ctx = makeCtx({ _scheduleRegisterRetry: vi.fn()
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

    it("keeps the banner for an old client returning void (no worse than today)", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const ctx = makeCtx({ _scheduleRegisterRetry: vi.fn() }); // returns undefined
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
        expect(ctx.client._scheduleRegisterRetry).not.toHaveBeenCalled();
    });

    it("survives a client facade without the retry hook (older ctx)", () => {
        const ctx = makeCtx({ _scheduleRegisterRetry: undefined });
        expect(() =>
            new ErrorHandler().handle(
                { event: "error", code: "AGENT_CONFLICT", error: "conflict", agent_id: "pines" } as any,
                ctx,
            ),
        ).not.toThrow();
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
            expect(ctx.client._scheduleRegisterRetry).not.toHaveBeenCalled();
            expect(ctx.client._failRegisterRetry).toHaveBeenCalledWith("pines");
            // The banner names both ways out.
            const banner = spy.mock.calls.map((c) => String(c[0])).join("\n");
            expect(banner).toContain("pinecall kick pines");
            expect(banner).toContain("different id");
        } finally {
            spy.mockRestore();
        }
    });

    it("falls back to a plain error event when the fatal hook is missing", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const ctx = makeCtx({ _failRegisterRetry: undefined });
            new ErrorHandler().handle(
                { event: "error", code: "AGENT_CONFLICT_FATAL", agent_id: "pines", error: "held" } as any,
                ctx,
            );
            expect(ctx.client._emitWire).toHaveBeenCalled();
            expect(ctx.client._scheduleRegisterRetry).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });
});

describe("ConnectionHandler — retry state reset", () => {
    it("clears the retry on agent.created", () => {
        const agent = { id: "pines", _flushPending: vi.fn(), _emitWire: vi.fn() };
        const ctx = makeCtx({}, agent);
        new ConnectionHandler().handle({ event: "agent.created", agent_id: "pines" } as any, ctx);
        expect(ctx.client._clearRegisterRetry).toHaveBeenCalledWith("pines");
        expect(agent._flushPending).toHaveBeenCalled();
    });

    it("clears the retry on agent.resumed", () => {
        const agent = { id: "pines", _flushPending: vi.fn(), _emitWire: vi.fn() };
        const ctx = makeCtx({}, agent);
        new ConnectionHandler().handle({ event: "agent.resumed", agent_id: "pines" } as any, ctx);
        expect(ctx.client._clearRegisterRetry).toHaveBeenCalledWith("pines");
    });
});

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
        expect(ctx.client._scheduleRegisterRetry).toHaveBeenCalledWith("pines");
        expect(ctx.client._emitWire).toHaveBeenCalled(); // still surfaces the error
    });

    it("schedules a retry on AGENT_IN_USE", () => {
        const ctx = makeCtx();
        new ErrorHandler().handle(
            { event: "error", code: "AGENT_IN_USE", error: "already connected", agent_id: "docs" } as any,
            ctx,
        );
        expect(ctx.client._scheduleRegisterRetry).toHaveBeenCalledWith("docs");
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

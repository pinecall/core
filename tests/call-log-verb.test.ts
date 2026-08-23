/**
 * `call.log()` — the custom-entry verb and its refusal path.
 *
 *   - frame shape: `{event:"call.log", call_id, name, value, id?, ephemeral?}`
 *     with the optional keys ABSENT (not undefined / false) when not asked for
 *   - a server `{event:"error", code:"CALL_LOG_REJECTED", call_id, reason, error}`
 *     reaches the call as `log.rejected` AND the client `error`, like every
 *     other call-verb refusal
 *   - `tool.execute(args, call)` hands a tool the Call, so `call.log` is
 *     reachable from a tool
 */

import { describe, it, expect, vi } from "vitest";
import { Call } from "../src/domain/call.js";
import type { CallLogRejectedEvent } from "../src/domain/call.js";
import { tool } from "../src/tool.js";
import { ErrorHandler } from "../src/dispatch/handlers/error.js";
import type { DispatchContext } from "../src/dispatch/handler.js";
import type { WireEvent } from "../src/protocol/wire.js";

function createCall() {
    const send = vi.fn();
    const call = new Call(
        { call_id: "CA_log_1", from: "+1555", to: "+1666", direction: "inbound", transport: "phone" } as any,
        send,
    );
    return { call, send };
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} } as any;

function makeCtx(call: Call | undefined): DispatchContext {
    const agent = call
        ? { _getCall: (id: string) => (id === call.id ? call : undefined) }
        : null;
    return {
        agent: () => null,                 // the frame carries no agent_id
        call: () => undefined,
        logger: noopLogger,
        send: () => {},
        onConnected: () => {},
        registration: { scheduleRetry: vi.fn(() => false), clear: vi.fn(), fail: vi.fn() },
        emitClientEvent: vi.fn(),
        allAgents: () => (agent ? [agent as any] : []),
        whatsappSession: () => undefined,
        lines: () => [],
    } as unknown as DispatchContext;
}

describe("call.log() — frame", () => {
    it("sends the minimal frame with no optional keys", () => {
        const { call, send } = createCall();
        call.log("crm.lookup", { customer: "c_42", tier: "gold" });
        expect(send).toHaveBeenCalledTimes(1);
        const frame = send.mock.calls[0][0];
        expect(frame).toEqual({
            event: "call.log",
            call_id: "CA_log_1",
            name: "crm.lookup",
            value: { customer: "c_42", tier: "gold" },
        });
        expect("id" in frame).toBe(false);
        expect("ephemeral" in frame).toBe(false);
    });

    it("carries id and ephemeral when asked for", () => {
        const { call, send } = createCall();
        call.log("booking.slot", "10:30", { id: "slot", ephemeral: true });
        expect(send.mock.calls[0][0]).toEqual({
            event: "call.log",
            call_id: "CA_log_1",
            name: "booking.slot",
            value: "10:30",
            id: "slot",
            ephemeral: true,
        });
    });

    it("ephemeral:false and id:undefined leave the keys out", () => {
        const { call, send } = createCall();
        call.log("x", null, { ephemeral: false, id: undefined });
        const frame = send.mock.calls[0][0];
        expect("id" in frame).toBe(false);
        expect("ephemeral" in frame).toBe(false);
        expect(frame.value).toBeNull();
    });

    it("is reachable from a tool through the call parameter", async () => {
        const { call, send } = createCall();
        const t = tool({
            name: "book",
            description: "book",
            schema: { parse: (x: unknown) => x as { when: string }, _def: { typeName: "ZodObject" } } as any,
            execute: async ({ when }: { when: string }, c: Call) => {
                c.log("booking.confirmed", { when }, { id: "booking" });
                return { ok: true };
            },
        });
        await t.execute({ when: "tomorrow" }, call);
        expect(send).toHaveBeenCalledWith(
            expect.objectContaining({ event: "call.log", call_id: "CA_log_1", name: "booking.confirmed", id: "booking" }),
        );
    });
});

describe("call.log() — CALL_LOG_REJECTED", () => {
    const wire: WireEvent = {
        event: "error",
        code: "CALL_LOG_REJECTED",
        call_id: "CA_log_1",
        reason: "invalid name",
        error: "call.log: invalid name",
    } as any;

    it("reaches the call as log.rejected and the client as error", () => {
        const { call } = createCall();
        const seen: CallLogRejectedEvent[] = [];
        call.on("log.rejected", (e) => seen.push(e));
        const ctx = makeCtx(call);

        expect(new ErrorHandler().handle(wire, ctx)).toBe(true);
        expect(seen).toEqual([{ callId: "CA_log_1", reason: "invalid name", error: "call.log: invalid name" }]);
        expect(ctx.emitClientEvent).toHaveBeenCalledWith("error", expect.any(Error));
        expect((ctx.emitClientEvent as any).mock.calls[0][1].message).toBe("call.log: invalid name");
    });

    it("derives reason from the error text when the server omits it", () => {
        const { call } = createCall();
        const seen: CallLogRejectedEvent[] = [];
        call.on("log.rejected", (e) => seen.push(e));
        new ErrorHandler().handle({ ...wire, reason: undefined } as any, makeCtx(call));
        expect(seen[0].reason).toBe("invalid name");
    });

    it("still surfaces the client error when the call is unknown locally", () => {
        const ctx = makeCtx(undefined);
        expect(new ErrorHandler().handle(wire, ctx)).toBe(true);
        expect(ctx.emitClientEvent).toHaveBeenCalledWith("error", expect.any(Error));
    });
});

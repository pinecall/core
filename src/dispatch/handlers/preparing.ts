/**
 * Pre-LLM handler — the app's half of the pre-turn barrier.
 *
 * Handles: llm.before, llm.preparing_timeout
 *
 * `llm.before` means "I am about to generate, and I am holding the turn open
 * for you". The developer's `call.preparing` handler runs, and the moment it
 * settles we answer `llm.ready` so the server stops waiting. That answer is the
 * whole point: without it the server can only burn its entire budget on every
 * turn, so the budget has to stay small, so an app on the far side of a WAN can
 * never win the race. With it, a fast handler costs one round trip and a slow
 * one costs exactly what it costs — up to the budget the agent asked for.
 *
 * `llm.preparing_timeout` is the server admitting it gave up. It used to be a
 * bare `pass` with no log and no event, which is why apps shipped for months
 * rendering prompts with stale values and never found out.
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";
import type { Call, PreparingTimeoutEvent } from "../../domain/call.js";

export class PreparingHandler implements EventHandler {
    readonly events = ["llm.before", "llm.preparing_timeout"] as const;

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        const agent = wire.agent_id ? ctx.agent(wire.agent_id) : null;
        if (!agent) return false;

        const callId = wire.call_id as string;
        if (!callId) return false;

        const call = agent._getCall(callId);
        if (!call) return false;

        if (wire.event === "llm.preparing_timeout") {
            const event: PreparingTimeoutEvent = {
                callId,
                turn: Number(wire.turn ?? 0),
                waitedMs: Number(wire.waited_ms ?? 0),
                budgetMs: Number(wire.budget_ms ?? 0),
            };
            ctx.logger.warn(
                `call.preparing did not answer in time on ${callId} ` +
                `(turn ${event.turn}, waited ${event.waitedMs}ms of ${event.budgetMs}ms). ` +
                `The server generated with the previous prompt variables.`,
            );
            call._emitWire("call.preparingTimeout" as any, event);
            agent._emitWire("call.preparingTimeout" as any, event, call);
            return true;
        }

        const turn = wire.turn as number | undefined;
        void this.#runPreparing(call, agent, callId, turn, ctx);
        return true;
    }

    /**
     * Run the developer's handlers, then release the turn.
     *
     * Handlers that return a promise (any `async` one) are awaited — so an
     * `await call.setPromptVars(...)` inside them is on THIS generation. A
     * handler that throws or hangs must not wedge the turn: the server's budget
     * is the backstop, and we release regardless.
     */
    async #runPreparing(
        call: Call,
        agent: { id: string; _emitPreparing?(call: Call): unknown[]; _emitWire(e: any, ...a: any[]): void },
        callId: string,
        turn: number | undefined,
        ctx: DispatchContext,
    ): Promise<void> {
        const results = [
            ...call._emitPreparing(),
            ...(agent._emitPreparing?.(call) ?? []),
        ];
        const pending = results.filter(
            (r): r is Promise<unknown> => !!r && typeof (r as Promise<unknown>).then === "function",
        );
        if (pending.length > 0) {
            try {
                await Promise.allSettled(pending);
            } catch {
                /* allSettled never rejects; belt and braces */
            }
        }
        // Tell the server we're done. A server that predates llm.ready simply
        // ignores the frame and falls back to its timeout, exactly as today.
        try {
            ctx.send({
                event: "llm.ready",
                call_id: callId,
                agent_id: agent.id,
                ...(turn !== undefined ? { turn } : {}),
            });
        } catch {
            /* socket gone — the server's budget covers it */
        }
    }
}

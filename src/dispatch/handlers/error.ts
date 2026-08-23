/**
 * Error handler — server error events.
 *
 * Business logic ported from client.ts:
 *   - PHONE_IN_USE: warn + remove channel from agent
 *   - AGENT_IN_USE: warn (agent removed by server)
 *   - CALL_LOG_REJECTED: emit `log.rejected` on the call, then on client
 *   - All other errors: emit on client
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";
import { ServerAtCapacityError } from "../../kernel/errors.js";
import type { CallLogRejectedEvent } from "../../domain/call-events.js";

export class ErrorHandler implements EventHandler {
    readonly events = ["error"] as const;

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        const errorMsg = (wire.error ?? wire.message ?? "Unknown error") as string;
        const code = wire.code as string | undefined;

        // PHONE_IN_USE — a phone number is already claimed by another agent
        if (code === "PHONE_IN_USE" || errorMsg.includes("PHONE_IN_USE")) {
            const phone = wire.phone as string | undefined;
            const agentId = wire.agent_id as string | undefined;
            console.warn(
                `[pinecall] Phone ${phone || "?"} is already in use by another agent. ` +
                `Removing from ${agentId || "this agent"}.`,
            );
            // Remove the channel from the local agent if we can identify it
            if (agentId) {
                const agent = ctx.agent(agentId);
                if (agent && phone) {
                    agent._getChannels().delete(phone);
                }
            }
            return true;
        }

        // SERVER_AT_CAPACITY — the server's max_clients ceiling refused this
        // registration. NOT a conflict, NOT a bad config, and above all NOT an
        // offline agent: retrying the same call cannot help until a slot frees.
        // It reached us as a generic REGISTRATION_ERROR before, and the only
        // symptom a consumer saw afterwards was the token mint answering
        // "Agent 'x' is not online" — which is why this gets its own type and
        // its own words, verbatim from the server.
        if (code === "SERVER_AT_CAPACITY" || errorMsg.startsWith("SERVER_AT_CAPACITY:")) {
            const agentId = (wire.agent_id as string | undefined) ?? "";
            const used = wire.used as number | undefined;
            const limit = wire.limit as number | undefined;
            const err = new ServerAtCapacityError(errorMsg, agentId, used, limit);
            console.error(
                `\n  \x1b[91m✗\x1b[0m Server at capacity — agent "${agentId || "?"}" was NOT registered` +
                (used != null && limit != null ? ` (${used}/${limit} client slots used)` : "") + `.\n` +
                `    The agent is not offline: the server refused it a slot.\n` +
                `    Free slots (\x1b[96mpinecall agents\x1b[0m shows the holders) or raise the server cap.\n`,
            );
            if (agentId) ctx.agent(agentId)?._failRegistration(err);
            ctx.emitClientEvent("error", err);
            return true;
        }

        // AGENT_IN_USE / AGENT_CONFLICT — the agent slug is already registered
        // by another connection. This is often TRANSIENT: after a network blip
        // or process restart, the server may still hold our own dead socket as
        // "alive" for a short window. Giving up permanently here turned a
        // 1-minute blip into an hours-long outage — so we retry with backoff
        // until the server frees the stale registration (or forever, if a real
        // second instance owns the slug — then `pinecall kick` resolves it).
        // AGENT_CONFLICT_FATAL is the exception: the server's liveness probe
        // just CONFIRMED the holder alive. That is a terminal state — retrying
        // it is a storm, so we stop immediately and say what to do instead.
        if (
            code === "AGENT_IN_USE" || code === "AGENT_CONFLICT" ||
            code === "AGENT_CONFLICT_FATAL" || errorMsg.includes("AGENT_IN_USE")
        ) {
            const agentId = wire.agent_id as string | undefined;

            if (code === "AGENT_CONFLICT_FATAL") {
                console.error(
                    `\n  \x1b[91m✗\x1b[0m Agent "${agentId || "?"}" is held by a LIVE process — not retrying.\n` +
                    `    Run \x1b[96mpinecall kick ${agentId || "<agent>"}\x1b[0m to disconnect the current holder,\n` +
                    `    or register this agent under a different id.\n`,
                );
                // The coordinator emits the typed AgentConflictError itself;
                // without an agent id there is nothing to fail, so the plain
                // error is all we can surface.
                if (agentId) {
                    ctx.registration.fail(agentId);
                } else {
                    ctx.emitClientEvent("error", new Error(errorMsg));
                }
                return true;
            }

            // Structured guidance from a new server (old servers omit both).
            const retryAfterS = wire.retry_after_s as number | undefined;
            const holderAlive = wire.holder_alive as boolean | undefined;
            const hint = retryAfterS != null || holderAlive != null
                ? { retryAfterS, holderAlive }
                : undefined;

            // No agent id means no episode to track — banner it once and move on.
            const first = agentId ? ctx.registration.scheduleRetry(agentId, hint) : true;
            // Log the human-facing banner ONCE per conflict episode — a name
            // actively held elsewhere used to spam this every attempt for hours.
            if (first) {
                console.error(
                    `\n  \x1b[91m✗\x1b[0m Agent "${agentId || "?"}" is already connected` +
                    (holderAlive ? " (held by a LIVE process)" : "") + `.\n` +
                    `    Retrying registration automatically with backoff` +
                    (holderAlive ? " (up to 10 min between attempts)" : " (stale registrations clear in ~1 min)") + `.\n` +
                    `    If another live instance owns it, run \x1b[96mpinecall kick ${agentId || "<agent>"}\x1b[0m.\n`,
                );
            }
            ctx.emitClientEvent("error", new Error(errorMsg));
            return true;
        }

        // CALL_LOG_REJECTED — a `call.log()` the server did not append (bad
        // name, value too large, sealed call, over the durable cap, …). The
        // frame carries `call_id`, so it also reaches the call itself as
        // `log.rejected`; the client `error` below still fires, like every
        // other call-verb refusal.
        if (code === "CALL_LOG_REJECTED") {
            const callId = wire.call_id as string | undefined;
            if (callId) {
                const event: CallLogRejectedEvent = {
                    callId,
                    reason: (wire.reason as string | undefined) ?? errorMsg.replace(/^call\.log:\s*/, ""),
                    error: errorMsg,
                };
                let agent = wire.agent_id ? ctx.agent(wire.agent_id as string) : null;
                if (!agent) {
                    for (const a of ctx.allAgents()) {
                        if (a._getCall(callId)) { agent = a; break; }
                    }
                }
                agent?._getCall(callId)?._emitWire("log.rejected", event);
            }
            ctx.emitClientEvent("error", new Error(errorMsg));
            return true;
        }

        // REGISTRATION_ERROR — the server refused this agent for a reason that
        // no retry can fix (bad config). The client cap used to land here too;
        // it has its own code now, above. Fail anyone awaiting
        // `agent.ready` right away instead of letting them wait out a deadline.
        if (code === "REGISTRATION_ERROR") {
            const agentId = wire.agent_id as string | undefined;
            if (agentId) ctx.agent(agentId)?._failRegistration(new Error(errorMsg));
        }

        // Generic error — emit on client
        ctx.emitClientEvent("error", new Error(errorMsg));
        return true;
    }
}

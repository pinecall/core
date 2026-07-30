/**
 * EventHandler — strategy interface for wire event handling.
 *
 * Each handler is responsible for one concern (lifecycle, speech, bot, etc).
 */

import type { Agent } from "../domain/agent.js";
import type { Call } from "../domain/call.js";
import type { WireEvent } from "../protocol/wire.js";
import type { Logger } from "../kernel/logger.js";

/** Server guidance attached to an AGENT_CONFLICT/AGENT_IN_USE rejection. */
export interface RegisterRetryHint {
    /** Server-suggested delay before the next attempt (escalates server-side). */
    retryAfterS?: number;
    /** true = the name is held by a LIVE process (back off hard);
     *  false = the holder is known dead (retry fast). */
    holderAlive?: boolean;
}

export interface DispatchContext {
    /** Resolve an agent by wire ID. Returns null if no match. */
    agent(wireId: string): Agent | null;
    /** Get an active call by ID from the resolved agent. */
    call(agent: Agent, callId: string): Call | undefined;
    /** Logger instance. */
    logger: Logger;
    /** Send raw message to server. */
    send(data: Record<string, unknown>): void;
    /** Called when server confirms authentication. */
    onConnected(): void;
    /** The Pinecall client instance (for emitting client-level events). */
    client: {
        _emitWire(event: string, ...args: unknown[]): void;
        _getAgent(id: string): Agent | undefined;
        _allAgents(): Agent[];
        _getWhatsAppHandler?(): { getSession(id: string): any };
        /**
         * Schedule a registration retry after AGENT_CONFLICT/AGENT_IN_USE.
         * `hint` carries the server's structured guidance (retry_after_s,
         * holder_alive) when present. Returns true when this was the FIRST
         * conflict for the agent (callers use it to log the banner once);
         * older implementations return void — treat that as "first".
         */
        _scheduleRegisterRetry?(agentId: string, hint?: RegisterRetryHint): boolean | void;
        /**
         * Terminal conflict: the server proved the name is held by a LIVE
         * process (AGENT_CONFLICT_FATAL). Stop retrying and surface a typed
         * error the developer can catch.
         */
        _failRegisterRetry?(agentId: string): void;
        /** Clear retry state once the server confirms the registration. */
        _clearRegisterRetry?(agentId: string): void;
    };
}

export interface EventHandler {
    /** List of event names this handler processes. */
    readonly events: ReadonlyArray<string>;
    /** Handle a wire event. Return true if handled, false to pass to next handler. */
    handle(wire: WireEvent, ctx: DispatchContext): boolean;
}

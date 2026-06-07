/**
 * EventHandler — strategy interface for wire event handling.
 *
 * Each handler is responsible for one concern (lifecycle, speech, bot, etc).
 */

import type { Agent } from "../domain/agent.js";
import type { Call } from "../domain/call.js";
import type { WireEvent } from "../protocol/wire.js";
import type { Logger } from "../kernel/logger.js";

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
    };
}

export interface EventHandler {
    /** List of event names this handler processes. */
    readonly events: ReadonlyArray<string>;
    /** Handle a wire event. Return true if handled, false to pass to next handler. */
    handle(wire: WireEvent, ctx: DispatchContext): boolean;
}

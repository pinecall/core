/**
 * EventHandler — strategy interface for wire event handling.
 *
 * Each handler is responsible for one concern (lifecycle, speech, bot, etc).
 */

import type { Agent } from "../domain/agent.js";
import type { Call } from "../domain/call.js";
import type { WhatsAppSession } from "../domain/wa-session.js";
import type { PhoneLine } from "../domain/line.js";
import type { WireEvent } from "../protocol/wire.js";
import type { Logger } from "../kernel/logger.js";
import type { RegistrationCoordinator } from "./registration.js";

// Re-exported so importers of `RegisterRetryHint` from this module keep
// working; the type itself belongs next to the coordinator that takes it.
export type { RegistrationCoordinator, RegisterRetryHint } from "./registration.js";

/**
 * Everything a handler is allowed to know about the world.
 *
 * Every member is REQUIRED and named for what it does, not for the private
 * client method it happens to call. Handlers get capabilities, never the
 * client object itself — that direction of the dependency is what kept
 * `error.ts` importing the orchestrator that dispatches it.
 */
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
    /** Registration retry/conflict state machine (owned by the client). */
    registration: RegistrationCoordinator;
    /** Emit a client-level event (the `Pinecall` instance's own emitter). */
    emitClientEvent(event: string, ...args: unknown[]): void;
    /** Every agent registered on this client — the fallback when the server omits `agent_id`. */
    allAgents(): Agent[];
    /** A live WhatsApp session by id, for `wa-` prefixed call ids. */
    whatsappSession(sessionId: string): WhatsAppSession | undefined;
    /** Every phone line on this client — how `line.*` and `call.route*` find their owner. */
    lines(): PhoneLine[];
}

export interface EventHandler {
    /** List of event names this handler processes. */
    readonly events: ReadonlyArray<string>;
    /** Handle a wire event. Return true if handled, false to pass to next handler. */
    handle(wire: WireEvent, ctx: DispatchContext): boolean;
}

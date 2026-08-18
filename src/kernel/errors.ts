/**
 * Base error type.
 *
 * Lives in kernel/ rather than client.ts so the domain layer (Call, Agent) can
 * throw it without importing the client — client.ts already imports the domain,
 * and the cycle would bite at module-evaluation time.
 *
 * `client.ts` re-exports it, so `import { PinecallError } from "@pinecall/sdk"`
 * keeps working exactly as before.
 */
export class PinecallError extends Error {
    constructor(message: string, public code?: string) {
        super(message);
        this.name = "PinecallError";
    }
}

/**
 * Terminal registration conflict — the agent id is held by another LIVE
 * process and retrying cannot change that.
 *
 * Emitted on the client's `error` event (so it is catchable programmatically,
 * not just a log line) when either:
 *   - the server answered `AGENT_CONFLICT_FATAL` (its liveness probe confirmed
 *     the holder alive), or
 *   - the retry budget (2× the server's stale-registration window) ran out.
 *
 * Lives here, not in client.ts, so a dispatch handler can construct one
 * without importing the orchestrator that dispatches it. `client.ts` and
 * `index.ts` re-export it, so both existing import paths keep working.
 */
export class AgentConflictError extends PinecallError {
    constructor(
        message: string,
        /** The agent id that could not be registered. */
        public readonly agentId: string,
        /** How the terminal state was reached. */
        public readonly reason: "server_fatal" | "retry_budget_exhausted",
    ) {
        super(message, "AGENT_CONFLICT_FATAL");
        this.name = "AgentConflictError";
    }
}

/**
 * The server ran out of client slots — it refused to register this agent.
 *
 * A distinct type because it is a distinct fact with a distinct remedy. The
 * server used to report the refusal as a nondescript REGISTRATION_ERROR, and
 * the token-mint endpoints — which only see that the agent never appeared —
 * answered `Agent 'x' is not online`. Nothing about the agent is wrong: the
 * SERVER is full. Surface the server's own words verbatim.
 */
export class ServerAtCapacityError extends PinecallError {
    constructor(
        message: string,
        /** The agent id that could not be registered. */
        public readonly agentId: string,
        /** Client slots in use, as reported by the server (if provided). */
        public readonly used?: number,
        /** The server's max_clients ceiling (if provided). */
        public readonly limit?: number,
    ) {
        super(message, "SERVER_AT_CAPACITY");
        this.name = "ServerAtCapacityError";
    }
}

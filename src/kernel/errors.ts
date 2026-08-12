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

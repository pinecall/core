/**
 * Agent ID resolver — extracts the local agent slug from server-provided agent_id.
 *
 * The server sends agent_id in four shapes; SDK stores by plain slug.
 * This was previously a 30-line inline block in client.ts._onMessage().
 * Now it's independently testable.
 */

export interface AgentIdResolver {
    /**
     * Resolve a server-provided agent_id (potentially compound, prefixed,
     * or wrong-case) to a local agent slug. Returns null if no local
     * agent matches.
     */
    resolve(rawId: string, localAgents: ReadonlySet<string>): string | null;
}

export class StandardAgentIdResolver implements AgentIdResolver {
    readonly #mode: string;
    readonly #devId: string;
    readonly #wirePrefix: string;

    constructor(mode: string, devId: string) {
        this.#mode = mode;
        this.#devId = devId;

        // Pre-compute the wire prefix once
        if (mode === "dev" && devId) {
            this.#wirePrefix = `dev-${devId}-`;
        } else if (mode) {
            this.#wirePrefix = `${mode}-`;
        } else {
            this.#wirePrefix = "";
        }
    }

    resolve(rawId: string, localAgents: ReadonlySet<string>): string | null {
        // 1. Direct match
        if (localAgents.has(rawId)) return rawId;

        let slug = rawId;

        // 2. Strip compound key prefix (org_id:slug)
        if (rawId.includes(":")) {
            slug = rawId.split(":").pop()!;
            if (localAgents.has(slug)) return slug;
        }

        // 3. Strip dev/staging prefix
        if (this.#wirePrefix && slug.startsWith(this.#wirePrefix)) {
            const stripped = slug.slice(this.#wirePrefix.length);
            if (localAgents.has(stripped)) return stripped;
        }

        // 4. Case-insensitive fallback
        const lower = slug.toLowerCase();
        if (localAgents.has(lower)) return lower;

        return null;
    }
}

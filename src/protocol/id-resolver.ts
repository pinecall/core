/**
 * Agent ID resolver — maps server-provided agent_id to a local agent slug.
 *
 * The server sends agent_id in two shapes:
 *   1. Plain slug:         "florencia"
 *   2. Compound key:       "org_id:florencia"
 *
 * Since agent IDs are now fully user-controlled (no magic prefixing),
 * resolution is straightforward.
 */

export interface AgentIdResolver {
    resolve(rawId: string, localAgents: ReadonlySet<string>): string | null;
}

export class StandardAgentIdResolver implements AgentIdResolver {
    resolve(rawId: string, localAgents: ReadonlySet<string>): string | null {
        // 1. Direct match
        if (localAgents.has(rawId)) return rawId;

        // 2. Strip compound key prefix (org_id:slug)
        if (rawId.includes(":")) {
            const slug = rawId.split(":").pop()!;
            if (localAgents.has(slug)) return slug;
        }

        // 3. Case-insensitive fallback
        const lower = rawId.toLowerCase();
        if (localAgents.has(lower)) return lower;

        return null;
    }
}

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

/**
 * Slugify a value the SAME way the server does (lowercase, underscores/spaces
 * → hyphens, strip non-alphanumeric, collapse/trim hyphens). Used to match a
 * server-provided slug back to a user-supplied agent id like "futbolAgent" or
 * "My Agent", which the server stores as "futbolagent" / "my-agent".
 */
function slugify(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[_\s]+/g, "-")     // underscores + whitespace → hyphen
        .replace(/[^a-z0-9-]/g, "")  // drop everything else
        .replace(/-+/g, "-")          // collapse repeats
        .replace(/^-+|-+$/g, "");     // trim leading/trailing
}

export class StandardAgentIdResolver implements AgentIdResolver {
    resolve(rawId: string, localAgents: ReadonlySet<string>): string | null {
        // 1. Direct match
        if (localAgents.has(rawId)) return rawId;

        // 2. Strip compound key prefix (org_id:slug)
        let candidate = rawId;
        if (rawId.includes(":")) {
            candidate = rawId.split(":").pop()!;
            if (localAgents.has(candidate)) return candidate;
        }

        // 3. Slug match — the server lowercases + hyphenates agent ids, so a
        //    local "futbolAgent" / "My Agent" must be compared by its slug.
        //    (toLowerCase() alone misses spaces/underscores; matching against
        //    the local set's slugs is what makes camelCase ids work.)
        const target = slugify(candidate);
        for (const local of localAgents) {
            if (local === candidate || slugify(local) === target) return local;
        }

        return null;
    }
}

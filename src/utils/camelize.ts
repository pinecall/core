/**
 * Wire → SDK transform utilities.
 *
 * Converts snake_case wire protocol fields to camelCase SDK fields.
 * Shared by call.ts (call-scoped events) and agent.ts (agent-scoped events).
 */

/** Convert a snake_case string to camelCase. */
export function snakeToCamel(s: string): string {
    return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Transform a raw wire event (snake_case) into a camelCase SDK event.
 * Only converts top-level keys — nested objects are passed through.
 */
export function camelizeEvent<T>(raw: Record<string, unknown>): T {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
        out[snakeToCamel(k)] = v;
    }
    return out as T;
}

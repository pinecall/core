/**
 * Wire → SDK transform utilities.
 *
 * The boundary between snake_case wire protocol and camelCase SDK types.
 * This is the ONLY place that touches wire key names.
 */

/** Convert a single snake_case key to camelCase. */
export function snakeToCamel(s: string): string {
    return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Convert a single camelCase key to snake_case. */
export function camelToSnake(s: string): string {
    return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * Camelize the top-level keys of a wire event into a typed domain event.
 * Does NOT recurse — nested objects (e.g. provider configs) are pass-through.
 */
export function decodeEvent<T>(wire: Record<string, unknown>): T {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(wire)) {
        out[snakeToCamel(k)] = v;
    }
    return out as T;
}

/**
 * Snakeize the top-level keys of an outgoing command.
 * Used only at the transport boundary.
 */
export function encodeCommand(cmd: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cmd)) {
        out[camelToSnake(k)] = v;
    }
    return out;
}

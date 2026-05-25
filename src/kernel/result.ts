/**
 * Result type — for operations that can fail predictably.
 *
 * Used sparingly in REST helpers. Not for unexpected exceptions.
 */

export type Result<T, E = Error> =
    | { ok: true; value: T }
    | { ok: false; error: E };

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error });

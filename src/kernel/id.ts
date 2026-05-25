/**
 * ID generation — Stripe-style prefixed IDs.
 *
 *   generateId()        → "msg_a1b2c3d4e5f6"
 *   generateId("greet") → "greet_a1b2c3d4e5f6"
 *
 * Uses crypto.getRandomValues() for proper randomness (browser-safe).
 */

const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomSuffix(len = 12): string {
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    let result = "";
    for (let i = 0; i < len; i++) {
        result += CHARS[bytes[i] % CHARS.length];
    }
    return result;
}

export function generateId(prefix = "msg"): string {
    return `${prefix}_${randomSuffix()}`;
}

// ─── Branded types ───────────────────────────────────────────────────────

/** Nominal typing via brand tag. Compile-time only — zero runtime cost. */
export type Brand<T, B> = T & { readonly __brand: B };

export type CallId = Brand<string, "CallId">;
export type AgentId = Brand<string, "AgentId">;
export type MessageId = Brand<string, "MessageId">;
export type WireId = Brand<string, "WireId">;

export const CallId = (s: string): CallId => s as CallId;
export const AgentId = (s: string): AgentId => s as AgentId;
export const MessageId = (s: string): MessageId => s as MessageId;
export const WireId = (s: string): WireId => s as WireId;

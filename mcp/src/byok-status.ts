/**
 * The org's BYOK credentials — fetched ONCE per tool call, shared by every
 * tool that needs to answer "can THIS org actually run that?".
 *
 * `managed: false` is a property of the model, not of the org: it says a row
 * would need your own provider key, not whether you have one. The answer only
 * exists after a join with GET /api/credentials — the same listing `byok`
 * shows. That fetch lives here so the two catalog tools and `byok` itself
 * share one client instead of three copies of the same endpoint knowledge.
 *
 * Tolerance is deliberate: a credentials endpoint that 500s must degrade the
 * ANSWER, not fail the catalog. `fetchByokStatus` never throws — it comes back
 * `ok: false`, and `usability()` then reports `byokUnknown: true` next to a
 * conservative `usable = managed`, so an agent is told the join is missing
 * rather than being handed a confident wrong value.
 */

import type { Session } from "./session.js";

/**
 * The providers the server's `upsertCredentialSchema` accepts, verbatim.
 * Kept here only so a typo is answered locally with the list instead of a
 * zod validation dump from the API. Note what is absent: `twilio`, `polly`
 * and `transcribe` are NOT provider-key providers — telephony is configured
 * per-number, and the AWS services run on Pinecall's own account. Same for
 * `pinecall` itself. That absence is load-bearing below: a provider you
 * CANNOT hand a key to is never "unusable for want of a key".
 */
export const BYOK_PROVIDERS = [
    "deepgram", "gladia", "cartesia", "elevenlabs", "assemblyai",
    "rime", "soniox",
    "openai", "anthropic", "google", "mistral",
    "xai", "groq", "cerebras", "deepseek", "openrouter",
] as const;

export type ByokProvider = (typeof BYOK_PROVIDERS)[number];

const BYOK_CONFIGURABLE = new Set<string>(BYOK_PROVIDERS);

export interface CredentialRow {
    provider: string;
    /** The server's leading-8 preview. Read, never forwarded. */
    apiKeyPreview?: string;
    createdAt?: string;
}

export interface ByokEntry {
    provider: string;
    configured: boolean;
    addedAt?: string;
}

/** The server's rows → key-free rows. The preview never survives this function. */
export function toEntries(credentials: CredentialRow[]): ByokEntry[] {
    return credentials
        .filter((c) => !!c.provider)
        .map((c) => ({
            provider: c.provider,
            configured: true,
            ...(c.createdAt ? { addedAt: c.createdAt } : {}),
        }))
        .sort((a, b) => a.provider.localeCompare(b.provider));
}

/** The one caller of GET /api/credentials. Throws — for `byok('list')`. */
export async function fetchCredentials(session: Session): Promise<CredentialRow[]> {
    const res = await session.playground<{ credentials?: CredentialRow[] }>("/credentials");
    return res.credentials ?? [];
}

export interface ByokStatus {
    /** False when the lookup failed — the join is unknown, not empty. */
    ok: boolean;
    /** Lower-cased provider names the org has a key for. Empty when !ok. */
    configured: Set<string>;
    error?: string;
}

/** Never throws. One call per tool invocation, never per row. */
export async function fetchByokStatus(session: Session): Promise<ByokStatus> {
    try {
        const rows = await fetchCredentials(session);
        return {
            ok: true,
            configured: new Set(
                rows.map((c) => (c.provider ?? "").trim().toLowerCase()).filter(Boolean),
            ),
        };
    } catch (err) {
        return {
            ok: false,
            configured: new Set(),
            error: session.redact(err instanceof Error ? err.message : String(err)),
        };
    }
}

export interface Usability {
    usable: boolean;
    unusableReason?: "needs-byok";
    /** Present only when the credentials lookup failed — `usable` is a guess. */
    byokUnknown?: true;
}

/**
 * managed OR the org has that provider's key.
 *
 * Two subtleties, both learned from real rows:
 *
 *   · `managed === null` — the catalog knows the provider but not its billing
 *     mode (e.g. `pinecall/gpt-realtime`). Unknown is not the same as BYOK.
 *   · A provider that is not in BYOK_PROVIDERS has no key to give it, so
 *     `usable: false, needs-byok` would be advice nobody can follow: `byok`
 *     itself would reject the provider name. Those run on Pinecall's own
 *     accounts and are reported usable.
 *
 * So only a provider you COULD hand a key to is ever blocked for want of one.
 */
export function usability(
    provider: string,
    managed: boolean | null | undefined,
    status: ByokStatus,
): Usability {
    const name = (provider ?? "").trim().toLowerCase();
    if (managed === true) return { usable: true };
    if (status.configured.has(name)) return { usable: true };
    if (managed !== false && !BYOK_CONFIGURABLE.has(name)) return { usable: true };
    return {
        usable: false,
        unusableReason: "needs-byok",
        ...(status.ok ? {} : { byokUnknown: true as const }),
    };
}

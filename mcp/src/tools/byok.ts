/**
 * byok — bring your own provider key.
 *
 * The store already exists server-side; this tool is a thin, redacting mouth
 * onto it (playground `src/modules/credentials/`, mounted at `/api/credentials`,
 * authenticated by the same `pk_…` the rest of this server uses):
 *
 *   GET    /api/credentials            → the org's saved provider keys
 *   PUT    /api/credentials            → upsert `{provider, apiKey}`
 *   DELETE /api/credentials/:provider  → remove one
 *
 * Two things this tool deliberately does NOT pass through:
 *
 *   1. `apiKeyPreview`. The server's list returns `key.slice(0,8) + '****'` —
 *      the LEADING eight characters, which is real key material (and for most
 *      providers the highest-entropy part after the vendor prefix). A `configured`
 *      boolean answers the only question the caller has, so the preview is dropped
 *      rather than forwarded. There is no `last4` on the wire to offer instead.
 *   2. The submitted key on `set`. It transits once, inside `session.withSecret`,
 *      which registers it with `redact()` for exactly the duration of the call —
 *      so an upstream 4xx body quoting it comes back scrubbed — and the result is
 *      itself passed through `redact()` before it is returned.
 */

import { z } from "zod";
import { defineTool } from "./types.js";
import type { Session } from "../session.js";

/**
 * The providers the server's `upsertCredentialSchema` accepts, verbatim.
 * Kept here only so a typo is answered locally with the list instead of a
 * zod validation dump from the API. Note what is absent: `twilio`, `polly`
 * and `transcribe` are NOT provider-key providers — telephony is configured
 * per-number, and the AWS services run on Pinecall's own account.
 */
export const BYOK_PROVIDERS = [
    "deepgram", "gladia", "cartesia", "elevenlabs", "assemblyai",
    "rime", "soniox",
    "openai", "anthropic", "google", "mistral",
    "xai", "groq", "cerebras", "deepseek", "openrouter",
] as const;

export type ByokProvider = (typeof BYOK_PROVIDERS)[number];

interface CredentialRow {
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

/** Normalize + validate a provider name, answering with the list on a miss. */
export function requireProvider(provider: string | undefined): ByokProvider {
    const name = (provider ?? "").trim().toLowerCase();
    if (!name) {
        throw new Error(`byok needs a \`provider\`. One of: ${BYOK_PROVIDERS.join(", ")}.`);
    }
    if (!(BYOK_PROVIDERS as readonly string[]).includes(name)) {
        throw new Error(
            `"${name}" is not a provider Pinecall stores a key for. One of: ${BYOK_PROVIDERS.join(", ")}. ` +
            "(Telephony is configured per phone number, not here.)",
        );
    }
    return name as ByokProvider;
}

/** JSON round-trip through redact() — the last gate before anything leaves. */
function scrub<T>(session: Session, value: T): T {
    return JSON.parse(session.redact(JSON.stringify(value))) as T;
}

export default defineTool({
    name: "byok",
    description:
        "Bring your own provider key: list which providers the org has a key for, set one, or remove one. Keys are never returned.",
    schema: {
        action: z
            .enum(["list", "set", "remove"])
            .describe("`list` (default) · `set` needs provider+key · `remove` needs provider")
            .optional(),
        provider: z
            .string()
            .optional()
            .describe(`Provider name, e.g. ${BYOK_PROVIDERS.slice(0, 4).join(", ")}, xai, groq…`),
        key: z
            .string()
            .optional()
            .describe("The provider's own API key. Sent to Pinecall once and never echoed back."),
    },
    manual:
        "Bring-your-own provider keys: `list` (never key material), `set`, `remove`. BYOK bills the org's OWN provider account and flips `managed: false` models on — tradeoffs: get_doc('reference/managed-vs-byok'). The submitted key transits once and is scrubbed from every output.",
    async handler(
        args: { action?: "list" | "set" | "remove"; provider?: string; key?: string },
        { session },
    ) {
        const action = args.action ?? "list";

        if (action === "list") {
            const res = await session.playground<{ credentials?: CredentialRow[] }>("/credentials");
            const providers = toEntries(res.credentials ?? []);
            return {
                providers,
                total: providers.length,
                note:
                    "Only providers with a saved key are listed. Key material is never returned — " +
                    "billing for these goes to your own provider account, not your Pinecall credits.",
            };
        }

        const provider = requireProvider(args.provider);

        if (action === "remove") {
            await session.playground<unknown>(`/credentials/${encodeURIComponent(provider)}`, {
                method: "DELETE",
            });
            return {
                provider,
                configured: false,
                removed: true,
                note:
                    `Pinecall no longer holds your ${provider} key. Models that provider serves fall back ` +
                    "to Pinecall's managed key if it has one, and are rejected with PROVIDER_KEY_REQUIRED if not.",
            };
        }

        // action === "set" — the one path a secret travels.
        const key = (args.key ?? "").trim();
        if (!key) {
            throw new Error(
                `byok('set') needs the ${provider} API key in \`key\`. It is sent to Pinecall once ` +
                "and is never returned by any tool.",
            );
        }

        return session.withSecret(key, async () => {
            await session.playground<unknown>("/credentials", {
                method: "PUT",
                body: JSON.stringify({ provider, apiKey: key }),
            });
            return scrub(session, {
                provider,
                configured: true,
                note:
                    `Saved. ${provider} usage is now billed by ${provider} to your own account and no longer ` +
                    "deducts Pinecall credits. Reconnect the agent for it to take effect. The key is not " +
                    "readable back from Pinecall — byok('list') only reports that it is configured.",
            });
        });
    },
});

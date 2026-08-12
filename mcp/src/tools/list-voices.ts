/**
 * list_voices — the TTS voices, with the exact `provider/alias` string a
 * `voice` field takes.
 *
 * LIVE: it is the SDK's own `fetchVoices` against GET /api/sdk/voices on the
 * voice server, the same call the CLI's `pinecall voices` makes. No second
 * HTTP client, and no static voice list to go stale — voices change per org.
 *
 * With no `provider`, it fans out over the MANAGED providers only: the BYOK
 * ones (rime, xai) need the org's own key, so listing them by default would
 * hand back voices that a config cannot actually use.
 *
 * Naming one of those BYOK providers explicitly is allowed, and then the same
 * join `list_models` does decides the row: ONE GET /api/credentials for the
 * whole call says whether THIS org holds that provider's key, and every row
 * carries `usable` (+ `unusableReason: "needs-byok"`) accordingly.
 */

import { z } from "zod";
import { defineTool } from "./types.js";
import { fetchVoices, type Voice } from "../../../src/api/voices.js";
import { CATALOG } from "../catalog.generated.js";
import { fetchByokStatus, usability, type ByokStatus } from "../byok-status.js";

const TTS = CATALOG.kinds.tts;
const ALL_PROVIDERS = TTS.providers.map((p) => p.name);
const MANAGED_PROVIDERS = TTS.providers.filter((p) => p.managed).map((p) => p.name);
/**
 * provider → managed, from the catalog. `list_models` refreshes this from the
 * live rate table; the voice listing does not, because it would be a second
 * round-trip to re-derive a flag the TTS catalog is generated from.
 */
const MANAGED_BY_PROVIDER = new Map(TTS.providers.map((p) => [p.name, p.managed]));

const DEFAULT_LIMIT = 40;

/**
 * Only an ALIASED voice yields a usable config string.
 *
 * `?provider=polly` has no live listing on the server: it answers with the
 * built-in fallback catalog, whose rows are ElevenLabs ids with no alias. The
 * SDK stamps the requested provider onto them, so passing them through would
 * produce `polly/EXAVITQu4vr4xnSDxMaL` — a string that is wrong twice (wrong
 * vendor, raw id). A row without an alias is dropped and the provider is
 * reported in `unlistedProviders` instead.
 */
function hasAlias(v: Voice): boolean {
    return typeof v.alias === "string" && v.alias.length > 0;
}

function row(v: Voice, byok: ByokStatus) {
    const languages = v.languages.map((l) => l.code).filter(Boolean);
    return {
        /** The EXACT string for the `voice` field. */
        voice: `${v.provider}/${v.alias ?? v.id}`,
        name: v.name,
        provider: v.provider,
        languages,
        ...(v.gender ? { gender: v.gender } : {}),
        ...(v.style ? { style: v.style } : {}),
        ...usability(v.provider, MANAGED_BY_PROVIDER.get(v.provider) ?? null, byok),
    };
}

export default defineTool({
    name: "list_voices",
    description:
        "TTS voices with the exact `voice` config string (e.g. \"elevenlabs/sarah\"), filterable by provider and language.",
    schema: {
        provider: z
            .enum(ALL_PROVIDERS as [string, ...string[]])
            .optional()
            .describe("One TTS provider. Omitted: every managed provider is queried."),
        language: z
            .string()
            .optional()
            .describe("ISO language code prefix, e.g. \"es\" — matches es, es-ES, es-419."),
        limit: z.number().int().min(1).max(200).optional().describe(`Max voices returned (default ${DEFAULT_LIMIT}).`),
    },
    manual: "Use the `voice` string verbatim — the alias is not the provider's raw id. Filter by `language`/`provider`; BYOK ones must be named. Prefer `usable: true` — a `usable: false` row needs `byok('set', provider, key)` first.",
    async handler(
        args: { provider?: string; language?: string; limit?: number },
        { session },
    ) {
        const providers = args.provider ? [args.provider] : MANAGED_PROVIDERS;
        const limit = args.limit ?? DEFAULT_LIMIT;
        const language = args.language?.trim().toLowerCase();

        // ONE credentials fetch for the whole call, alongside the voice fan-out.
        const byokPromise = fetchByokStatus(session);

        const results = await Promise.all(
            providers.map(async (provider) => {
                try {
                    const voices = await fetchVoices({ provider, language, apiUrl: session.serverUrl });
                    return { provider, voices, error: null as string | null };
                } catch (err) {
                    return {
                        provider,
                        voices: [] as Voice[],
                        error: err instanceof Error ? err.message : String(err),
                    };
                }
            }),
        );

        const byok = await byokPromise;

        const kept = results.map((r) => ({
            ...r,
            aliased: r.voices
                .filter(hasAlias)
                // Defensive: the filter is server-side AND client-side in fetchVoices,
                // but a provider that ignores the query param must not leak through.
                .filter((v) => !language || v.languages.some((l) => l.code.toLowerCase().startsWith(language))),
        }));

        const all = kept.flatMap((r) => r.aliased.map((v) => row(v, byok)));

        const failed = results.filter((r) => r.error).map((r) => ({ provider: r.provider, error: r.error }));
        const unlisted = kept
            .filter((r) => !r.error && r.aliased.length === 0 && r.voices.length > 0)
            .map((r) => ({
                provider: r.provider,
                reason: "the server returns no aliased voices for this provider — it has no live voice listing, so there is no exact config string to give you",
            }));

        return {
            filter: { provider: args.provider ?? null, language: args.language ?? null },
            providersQueried: providers,
            total: all.length,
            truncated: all.length > limit,
            voices: all.slice(0, limit),
            ...(failed.length ? { failedProviders: failed } : {}),
            ...(unlisted.length ? { unlistedProviders: unlisted } : {}),
            byok: {
                known: byok.ok,
                configuredProviders: [...byok.configured].sort(),
                ...(byok.error ? { error: byok.error } : {}),
                note: byok.ok
                    ? "`usable: false` means this org has no key for that provider — call byok('set', provider, key) first."
                    : "The credentials lookup failed, so `usable` is `managed` alone and rows carry `byokUnknown: true`.",
            },
            configFormat: "provider/alias — e.g. voice: \"elevenlabs/sarah\"",
            source: `${session.serverUrl}/api/sdk/voices`,
        };
    },
});

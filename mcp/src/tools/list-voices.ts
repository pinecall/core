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
 */

import { z } from "zod";
import { defineTool } from "./types.js";
import { fetchVoices, type Voice } from "../../../src/api/voices.js";
import { CATALOG } from "../catalog.generated.js";

const TTS = CATALOG.kinds.tts;
const ALL_PROVIDERS = TTS.providers.map((p) => p.name);
const MANAGED_PROVIDERS = TTS.providers.filter((p) => p.managed).map((p) => p.name);

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
function usable(v: Voice): boolean {
    return typeof v.alias === "string" && v.alias.length > 0;
}

function row(v: Voice) {
    const languages = v.languages.map((l) => l.code).filter(Boolean);
    return {
        /** The EXACT string for the `voice` field. */
        voice: `${v.provider}/${v.alias ?? v.id}`,
        name: v.name,
        provider: v.provider,
        languages,
        ...(v.gender ? { gender: v.gender } : {}),
        ...(v.style ? { style: v.style } : {}),
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
    manual: [
        "**`list_voices`** — the voices behind a `voice` string. Each row's `voice` is the EXACT",
        "value to put in the config: `voice: \"elevenlabs/sarah\"`. The format is",
        "`provider/friendly-alias`, always lowercase; the alias is NOT the provider's raw voice id.",
        "",
        "Filter by `language` (an ISO prefix — `\"es\"` matches `es`, `es-ES`, `es-419`) and/or",
        "`provider`. With no provider it queries every MANAGED provider; ask for `rime` or `xai`",
        "explicitly, they are BYOK and need the org's own key. Results are live from the server,",
        "so they reflect what this org can actually use — and they are truncated: raise `limit`",
        "or narrow the filter when `truncated` is true.",
        "",
        "A provider in `unlistedProviders` has no live voice listing on the server (today: `polly`),",
        "so no exact string can be given for it — pick another provider rather than guessing an id.",
        "",
        "Language lives on the AGENT (`language: \"es\"`), not in the voice string — pick a voice",
        "that speaks the language, then set `language` alongside it.",
    ].join("\n"),
    async handler(
        args: { provider?: string; language?: string; limit?: number },
        { session },
    ) {
        const providers = args.provider ? [args.provider] : MANAGED_PROVIDERS;
        const limit = args.limit ?? DEFAULT_LIMIT;
        const language = args.language?.trim().toLowerCase();

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

        const kept = results.map((r) => ({
            ...r,
            usable: r.voices
                .filter(usable)
                // Defensive: the filter is server-side AND client-side in fetchVoices,
                // but a provider that ignores the query param must not leak through.
                .filter((v) => !language || v.languages.some((l) => l.code.toLowerCase().startsWith(language))),
        }));

        const all = kept.flatMap((r) => r.usable.map(row));

        const failed = results.filter((r) => r.error).map((r) => ({ provider: r.provider, error: r.error }));
        const unlisted = kept
            .filter((r) => !r.error && r.usable.length === 0 && r.voices.length > 0)
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
            configFormat: "provider/alias — e.g. voice: \"elevenlabs/sarah\"",
            source: `${session.serverUrl}/api/sdk/voices`,
        };
    },
});

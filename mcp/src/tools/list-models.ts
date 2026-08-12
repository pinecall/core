/**
 * list_models — what the server accepts for `llm` / `stt` / `voice`, each row
 * carrying the EXACT string a config uses.
 *
 * Two sources, deliberately:
 *   · the shortcut table is STATIC, generated from docs/reference at build time
 *     (`scripts/gen-catalog.mjs`) and stamped with `staleAsOf` — the server has
 *     no endpoint that returns config shortcuts, only billing ids.
 *   · `managed` is refreshed LIVE from the rate table, which is authoritative
 *     about what needs your own key. The join is provider-level, an exact match
 *     on both sides — no fuzzy model-id matching.
 *
 * And `managed` alone is not an answer: it describes the MODEL, not this org.
 * A third join — ONE GET /api/credentials for the whole call — turns it into
 * `usable`, the field a caller should actually filter on.
 */

import { z } from "zod";
import { defineTool } from "./types.js";
import { CATALOG } from "../catalog.generated.js";
import { fetchByokStatus, usability } from "../byok-status.js";

const KINDS = ["llm", "stt", "tts"] as const;
type Kind = (typeof KINDS)[number];

interface LiveRates {
    ok: boolean;
    /** provider → managed, for this kind only. */
    managed: Map<string, boolean>;
    error?: string;
}

/** GET {playground}/api/rates/models — public, no key, best-effort. */
export async function fetchLiveRates(playgroundUrl: string, kind: Kind): Promise<LiveRates> {
    const service = kind; // the rate table names the services llm | stt | tts
    try {
        const res = await fetch(`${playgroundUrl}/api/rates/models`, {
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return { ok: false, managed: new Map(), error: `HTTP ${res.status}` };
        const data: any = await res.json();
        const managed = new Map<string, boolean>();
        for (const m of data?.models ?? []) {
            if (m?.service !== service || !m?.provider) continue;
            managed.set(m.provider, (managed.get(m.provider) ?? false) || !!m.managed);
        }
        for (const p of data?.managedProviders?.[service] ?? []) managed.set(p, true);
        return { ok: managed.size > 0, managed };
    } catch (err) {
        return { ok: false, managed: new Map(), error: err instanceof Error ? err.message : String(err) };
    }
}

export default defineTool({
    name: "list_models",
    description:
        "The models the server accepts for a kind (llm | stt | tts), each with the exact config shortcut string and notes (languages, managed vs BYOK, realtime).",
    schema: {
        kind: z.enum(KINDS).describe("llm, stt or tts — which agent-config field you are filling."),
    },
    manual: "Paste `shortcut` verbatim (`provider/model`; bare = OpenAI). Pick STT by language: `deepgram/flux` is the default but ~20 languages (no Arabic, Hindi, Thai, Urdu) — else `nova-3`/`soniox/realtime`. Pick only `usable: true`: `managed: false` = BYOK, and a `usable: false` row needs `byok('set', provider, key)` before it will run.",
    async handler(args: { kind: Kind }, { session }) {
        const kind = args.kind;
        const entry = CATALOG.kinds[kind];
        // Two independent lookups, one round-trip each, in parallel — never per row.
        const [live, byok] = await Promise.all([
            fetchLiveRates(session.playgroundUrl, kind),
            fetchByokStatus(session),
        ]);

        const models = entry.models.map((m) => {
            const managed = live.managed.has(m.provider) ? live.managed.get(m.provider)! : m.managed;
            return {
                shortcut: m.shortcut,
                provider: m.provider,
                model: m.model,
                managed,
                byokKeyRequired: managed === null ? null : !managed,
                ...usability(m.provider, managed, byok),
                ...(m.aliasForms.length ? { aliasForms: m.aliasForms } : {}),
                ...(m.examples.length ? { exampleVoices: m.examples } : {}),
                notes: m.notes,
            };
        });

        return {
            kind,
            configField: entry.field,
            count: models.length,
            models,
            providers: entry.providers.map((p) => {
                const managed = live.managed.has(p.name) ? live.managed.get(p.name)! : p.managed;
                return { ...p, managed, ...usability(p.name, managed, byok) };
            }),
            byok: {
                known: byok.ok,
                configuredProviders: [...byok.configured].sort(),
                ...(byok.error ? { error: byok.error } : {}),
                note: byok.ok
                    ? "`usable: false` means this org has no key for that provider — call byok('set', provider, key) first."
                    : "The credentials lookup failed, so `usable` is `managed` alone and rows carry `byokUnknown: true`.",
            },
            managedSource: live.ok ? "live rate table" : "docs snapshot (live rate table unreachable)",
            liveRates: live.ok
                ? { ok: true, url: `${session.playgroundUrl}/api/rates/models` }
                : { ok: false, url: `${session.playgroundUrl}/api/rates/models`, error: live.error ?? null },
            staleAsOf: CATALOG.staleAsOf,
            source: entry.source,
            ...(kind === "tts" ? { next: "Call list_voices for the exact voice strings." } : {}),
        };
    },
});

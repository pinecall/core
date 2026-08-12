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
 */

import { z } from "zod";
import { defineTool } from "./types.js";
import { CATALOG } from "../catalog.generated.js";

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
    manual: [
        "**`list_models`** — the catalog of accepted models. `kind: \"llm\" | \"stt\" | \"tts\"`.",
        "Every row's `shortcut` is the EXACT string to paste into a config: `stt: \"deepgram/flux\"`,",
        "`llm: \"openai/gpt-5.3-chat-latest\"`. The format is `provider/model`; the bare form",
        "(`llm: \"gpt-5.3-chat-latest\"`) means OpenAI, and `aliasForms` lists equivalent spellings",
        "(`claude/…` = `anthropic/…`, `gemini/…` = `google/…`).",
        "",
        "**Pick STT by language, not by taste.** `deepgram/flux` is the default — lowest latency,",
        "native turn detection — but it covers ~20 languages and does NOT include Arabic, Hindi,",
        "Thai or Urdu. For those use `deepgram/nova-3` (60+ languages), or `soniox/realtime`",
        "(one model, 60 languages, detects mid-sentence switches). Read each row's `notes`: they",
        "carry the language coverage verbatim from the docs.",
        "",
        "`managed: false` means BYOK — the org must have saved that provider's key or agent",
        "registration is rejected with `PROVIDER_KEY_REQUIRED`. `managed` is refreshed from the",
        "live rate table on every call; the rest of the row is a build-time snapshot of the docs,",
        "dated in `staleAsOf`.",
        "",
        "For `kind: \"tts\"` the rows are PROVIDERS — a TTS shortcut names a voice",
        "(`elevenlabs/sarah`), so use `list_voices` to get the actual strings.",
    ].join("\n"),
    async handler(args: { kind: Kind }, { session }) {
        const kind = args.kind;
        const entry = CATALOG.kinds[kind];
        const live = await fetchLiveRates(session.playgroundUrl, kind);

        const models = entry.models.map((m) => {
            const managed = live.managed.has(m.provider) ? live.managed.get(m.provider)! : m.managed;
            return {
                shortcut: m.shortcut,
                provider: m.provider,
                model: m.model,
                managed,
                byokKeyRequired: managed === null ? null : !managed,
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
            providers: entry.providers.map((p) => ({
                ...p,
                managed: live.managed.has(p.name) ? live.managed.get(p.name)! : p.managed,
            })),
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

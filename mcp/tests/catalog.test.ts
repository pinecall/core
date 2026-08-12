/**
 * The catalog tools, against the REAL endpoints (voice.pinecall.io and the
 * playground rate table — both public reads, no key needed). Nothing is
 * mocked: if the shortcut strings or the voice format drift, this fails.
 */

import { describe, it, expect } from "vitest";
import listModels from "../src/tools/list-models.js";
import listVoices from "../src/tools/list-voices.js";
import { CATALOG } from "../src/catalog.generated.js";
import { Session } from "../src/session.js";

const ctx = { session: new Session({} as NodeJS.ProcessEnv) };

const call = <T = any>(tool: any, args: any = {}) => tool.handler(args, ctx) as Promise<T>;

describe("list_models", () => {
    it("stt: has deepgram/flux and soniox/realtime, each with language notes", async () => {
        const res = await call(listModels, { kind: "stt" });
        const by = new Map<string, any>(res.models.map((m: any) => [m.shortcut, m]));

        const flux = by.get("deepgram/flux");
        expect(flux, "deepgram/flux missing").toBeTruthy();
        expect(flux.provider).toBe("deepgram");
        expect(flux.notes.join(" ")).toMatch(/languages?/i);
        // The coverage claim is the point: Flux is the default but not universal.
        expect(flux.notes.join(" ")).toMatch(/Spanish|~20 languages/i);

        const soniox = by.get("soniox/realtime");
        expect(soniox, "soniox/realtime missing").toBeTruthy();
        expect(soniox.provider).toBe("soniox");
        expect(soniox.notes.join(" ")).toMatch(/60 languages/i);

        // The row that answers "what about Arabic?" — Flux does not cover it.
        expect(by.get("deepgram/nova-3").notes.join(" ")).toMatch(/Arabic/i);
        expect(flux.notes.join(" ")).not.toMatch(/Arabic/i);
    });

    it("every shortcut is a literal config string, and managed comes from the live rate table", async () => {
        const res = await call(listModels, { kind: "stt" });
        expect(res.configField).toBe("stt");
        expect(res.staleAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(res.liveRates.ok, `rate table unreachable: ${res.liveRates.error}`).toBe(true);
        expect(res.managedSource).toBe("live rate table");

        for (const m of res.models) {
            expect(m.shortcut).toMatch(/^[a-z0-9]+(\/[a-z0-9.\-\/]+)?$/);
            expect(m.shortcut).not.toContain(":");
            expect(m.shortcut).not.toContain(" ");
        }
        // BYOK is a real distinction the live table must still be making.
        const byok = res.models.filter((m: any) => m.byokKeyRequired === true).map((m: any) => m.shortcut);
        expect(byok).toContain("assemblyai/universal");
        expect(byok).toContain("xai/grok-stt");
    });

    it("llm: canonical provider/model rows, alias spellings folded in", async () => {
        const res = await call(listModels, { kind: "llm" });
        const shortcuts = res.models.map((m: any) => m.shortcut);
        expect(shortcuts).toContain("openai/gpt-5.3-chat-latest");
        expect(shortcuts).toContain("anthropic/claude-sonnet-4-6");
        expect(shortcuts).not.toContain("claude/claude-sonnet-4-6");

        const sonnet = res.models.find((m: any) => m.shortcut === "anthropic/claude-sonnet-4-6");
        expect(sonnet.aliasForms).toContain("claude/claude-sonnet-4-6");

        const realtime = res.models.find((m: any) => m.shortcut === "pinecall/gpt-realtime");
        expect(realtime.notes.join(" ")).toMatch(/speech-to-speech/i);
    });

    it("tts: rows are providers and it points at list_voices", async () => {
        const res = await call(listModels, { kind: "tts" });
        expect(res.configField).toBe("voice");
        expect(res.next).toMatch(/list_voices/);
        const eleven = res.models.find((m: any) => m.provider === "elevenlabs");
        expect(eleven.shortcut).toBe("elevenlabs/<voice-alias>");
        expect(eleven.exampleVoices).toContain("elevenlabs/sarah");
    });

    it("survives an unreachable rate table by falling back to the docs snapshot", async () => {
        const offline = {
            session: new Session({ PINECALL_PLAYGROUND_URL: "http://127.0.0.1:1" } as NodeJS.ProcessEnv),
        };
        const res: any = await listModels.handler({ kind: "stt" }, offline as any);
        expect(res.liveRates.ok).toBe(false);
        expect(res.managedSource).toMatch(/docs snapshot/);
        expect(res.models.find((m: any) => m.shortcut === "deepgram/flux").managed).toBe(true);
    });
});

describe("list_voices (live)", () => {
    it("language:'es' returns ONLY es voices, each with an exact config string", async () => {
        const res = await call(listVoices, { language: "es", limit: 200 });
        expect(res.total).toBeGreaterThan(0);
        expect(res.filter).toEqual({ provider: null, language: "es" });

        for (const v of res.voices) {
            expect(v.languages.length, `${v.voice} has no language`).toBeGreaterThan(0);
            expect(
                v.languages.some((l: string) => l.toLowerCase().startsWith("es")),
                `${v.voice} is not Spanish: ${v.languages.join(",")}`,
            ).toBe(true);
            // The exact string a `voice` field takes: provider/alias, lowercase.
            expect(v.voice).toMatch(/^[a-z0-9]+\/[a-z0-9][a-z0-9._-]*$/);
            expect(v.voice.split("/")[0]).toBe(v.provider);
        }
    });

    it("drops a provider with no aliased voices instead of inventing a config string", async () => {
        // polly has no live listing: the server answers with the ElevenLabs
        // fallback catalog, un-aliased. Those must never surface as polly/<id>.
        const res = await call(listVoices, { provider: "polly", limit: 50 });
        expect(res.voices).toEqual([]);
        expect(res.unlistedProviders?.[0]?.provider).toBe("polly");
    });

    it("a provider filter only queries that provider", async () => {
        const res = await call(listVoices, { provider: "elevenlabs", limit: 5 });
        expect(res.providersQueried).toEqual(["elevenlabs"]);
        expect(res.voices.every((v: any) => v.provider === "elevenlabs")).toBe(true);
        expect(res.voices.length).toBe(5);
        expect(res.truncated).toBe(true);
    });

    it("defaults to the managed providers only — BYOK ones are opt-in", async () => {
        const res = await call(listVoices, { limit: 1 });
        const managed = CATALOG.kinds.tts.providers.filter((p) => p.managed).map((p) => p.name);
        expect(res.providersQueried).toEqual(managed);
        expect(res.providersQueried).not.toContain("rime");
    });
});

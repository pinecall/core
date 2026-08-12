/**
 * The usable-without-BYOK join.
 *
 * `managed: false` is a fact about the MODEL; `usable` is a fact about THIS
 * org. These pin the three answers that differ: managed, keyed, and unknown.
 */

import { describe, it, expect, vi } from "vitest";
import { fetchByokStatus, usability, type ByokStatus } from "../src/byok-status.js";
import type { Session } from "../src/session.js";

const status = (providers: string[], ok = true): ByokStatus => ({
    ok,
    configured: new Set(providers),
});

/** A Session stub: only `playground` and `redact` are reached from here. */
function fakeSession(playground: () => Promise<any>): Session {
    return {
        playground,
        redact: (t: string) => t,
    } as unknown as Session;
}

describe("usability", () => {
    it("a managed provider is usable with no key at all", () => {
        expect(usability("openai", true, status([]))).toEqual({ usable: true });
    });

    it("a BYOK provider with no key is not usable, and says why", () => {
        expect(usability("rime", false, status(["openrouter"]))).toEqual({
            usable: false,
            unusableReason: "needs-byok",
        });
    });

    it("the same provider flips once its key is configured", () => {
        expect(usability("rime", false, status(["rime"]))).toEqual({ usable: true });
    });

    it("matches the provider case-insensitively on both sides", () => {
        expect(usability("  Rime ", false, status(["rime"]))).toEqual({ usable: true });
    });

    /**
     * `pinecall/gpt-realtime` has `managed: null`. Reporting needs-byok there
     * would be advice nobody can take: `byok('set', 'pinecall')` is refused —
     * pinecall is not a provider you can hold a key for.
     */
    it("does not blame BYOK for a provider no key can be set on", () => {
        expect(usability("pinecall", null, status([]))).toEqual({ usable: true });
        expect(usability("polly", null, status([]))).toEqual({ usable: true });
    });

    it("still blocks a KNOWN-unmanaged provider even when its mode is unknown", () => {
        expect(usability("xai", null, status([]))).toEqual({
            usable: false,
            unusableReason: "needs-byok",
        });
    });

    /**
     * A credentials endpoint that fails must degrade the ANSWER, not the
     * catalog: the row falls back to `usable = managed` and is flagged so the
     * caller knows the join did not happen.
     */
    it("flags the fallback when the credentials lookup failed", () => {
        expect(usability("rime", false, status([], false))).toEqual({
            usable: false,
            unusableReason: "needs-byok",
            byokUnknown: true,
        });
        expect(usability("elevenlabs", true, status([], false))).toEqual({ usable: true });
    });
});

describe("fetchByokStatus", () => {
    it("reads GET /credentials exactly once and lower-cases the providers", async () => {
        const playground = vi.fn().mockResolvedValue({
            credentials: [{ provider: "OpenRouter", apiKeyPreview: "sk-abc12***" }, { provider: "rime" }],
        });
        const s = await fetchByokStatus(fakeSession(playground));
        expect(playground).toHaveBeenCalledTimes(1);
        expect(playground).toHaveBeenCalledWith("/credentials");
        expect(s.ok).toBe(true);
        expect([...s.configured].sort()).toEqual(["openrouter", "rime"]);
    });

    it("never throws — a broken endpoint comes back as ok:false", async () => {
        const s = await fetchByokStatus(fakeSession(() => Promise.reject(new Error("Playground 500"))));
        expect(s.ok).toBe(false);
        expect(s.configured.size).toBe(0);
        expect(s.error).toContain("500");
    });

    it("carries no key material out of the credentials rows", async () => {
        const s = await fetchByokStatus(
            fakeSession(async () => ({ credentials: [{ provider: "rime", apiKeyPreview: "sk-secre***" }] })),
        );
        expect(JSON.stringify([...s.configured])).not.toContain("sk-secre");
    });
});

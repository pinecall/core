/**
 * byok — the contract is what does NOT come out.
 *
 * The server's list endpoint hands back `apiKeyPreview` = the LEADING eight
 * characters of the stored key. These tests pin that it never reaches a tool
 * result, and that the key submitted to `set` appears nowhere: not in the
 * result, not in an error raised while it is in flight.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import byok, { toEntries, requireProvider, BYOK_PROVIDERS } from "../src/tools/byok.js";
import { Session } from "../src/session.js";

const PROVIDER_KEY = "xai-9f3c1b7e4d2a8c6f0b5e1d7a3c9f2b8e";

function session(): Session {
    return new Session({ PINECALL_API_KEY: "pk_test_key" } as NodeJS.ProcessEnv, "/pinecall-tests-no-home");
}

function mockFetch(handler: (url: string, init: any) => { status?: number; body: any }) {
    const calls: Array<{ url: string; init: any }> = [];
    vi.stubGlobal("fetch", async (url: string, init: any) => {
        calls.push({ url, init });
        const { status = 200, body } = handler(url, init);
        return {
            ok: status < 400,
            status,
            json: async () => body,
            text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
        } as any;
    });
    return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("toEntries", () => {
    it("drops the server's apiKeyPreview — leading key characters are key material", () => {
        const rows = [
            { provider: "xai", apiKeyPreview: "xai-9f3c****", createdAt: "2026-08-01T00:00:00.000Z" },
            { provider: "elevenlabs", apiKeyPreview: "sk_abc12****" },
        ];
        const entries = toEntries(rows);
        expect(entries).toEqual([
            { provider: "elevenlabs", configured: true },
            { provider: "xai", configured: true, addedAt: "2026-08-01T00:00:00.000Z" },
        ]);
        expect(JSON.stringify(entries)).not.toContain("xai-9f3c");
        expect(JSON.stringify(entries)).not.toContain("****");
    });
});

describe("requireProvider", () => {
    it("accepts every provider the server's schema accepts, case-insensitively", () => {
        for (const p of BYOK_PROVIDERS) expect(requireProvider(p.toUpperCase())).toBe(p);
    });

    it("refuses an unknown provider with the list, and names telephony as not being one", () => {
        expect(() => requireProvider("twilio")).toThrow(/openrouter/);
        expect(() => requireProvider("twilio")).toThrow(/phone number/);
        expect(() => requireProvider(undefined)).toThrow(/needs a `provider`/);
    });
});

describe("byok handler", () => {
    it("list returns providers without any key material", async () => {
        mockFetch(() => ({
            body: {
                credentials: [
                    { provider: "xai", apiKeyPreview: "xai-9f3c****", createdAt: "2026-08-01T00:00:00.000Z" },
                ],
            },
        }));
        const result: any = await byok.handler({ action: "list" }, { session: session() });
        expect(result.total).toBe(1);
        expect(result.providers[0]).toEqual({
            provider: "xai",
            configured: true,
            addedAt: "2026-08-01T00:00:00.000Z",
        });
        expect(JSON.stringify(result)).not.toContain("xai-9f3c");
    });

    it("set PUTs the key once and returns nothing containing it", async () => {
        const calls = mockFetch(() => ({ body: { provider: "xai", apiKeyPreview: "xai-9f3c****" } }));
        const result: any = await byok.handler(
            { action: "set", provider: "xai", key: PROVIDER_KEY },
            { session: session() },
        );

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("https://playground.pinecall.io/api/credentials");
        expect(calls[0].init.method).toBe("PUT");
        expect(JSON.parse(calls[0].init.body)).toEqual({ provider: "xai", apiKey: PROVIDER_KEY });

        expect(result.provider).toBe("xai");
        expect(result.configured).toBe(true);
        expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
        expect(JSON.stringify(result)).not.toContain("xai-9f3c");
    });

    it("scrubs the submitted key out of an upstream error that quotes it", async () => {
        mockFetch(() => ({ status: 400, body: `invalid apiKey "${PROVIDER_KEY}"` }));
        const s = session();
        await expect(
            byok.handler({ action: "set", provider: "xai", key: PROVIDER_KEY }, { session: s }),
        ).rejects.toThrow(/\[redacted\]/);

        try {
            await byok.handler({ action: "set", provider: "xai", key: PROVIDER_KEY }, { session: s });
        } catch (err) {
            const text = s.redact(err instanceof Error ? err.message : String(err));
            expect(text).not.toContain(PROVIDER_KEY);
        }
    });

    it("does not leave the provider key registered after the call", async () => {
        mockFetch(() => ({ body: { provider: "xai" } }));
        const s = session();
        await byok.handler({ action: "set", provider: "xai", key: PROVIDER_KEY }, { session: s });
        // The secret is scoped to the call: an unrelated later string is untouched.
        expect(s.redact(`later mention of ${PROVIDER_KEY}`)).toContain(PROVIDER_KEY);
    });

    it("set without a key refuses instead of storing an empty credential", async () => {
        const calls = mockFetch(() => ({ body: {} }));
        await expect(
            byok.handler({ action: "set", provider: "xai" }, { session: session() }),
        ).rejects.toThrow(/needs the xai API key/);
        expect(calls).toHaveLength(0);
    });

    it("remove DELETEs the provider and reports it unconfigured", async () => {
        const calls = mockFetch(() => ({ body: { provider: "xai", removed: true } }));
        const result: any = await byok.handler(
            { action: "remove", provider: "xai" },
            { session: session() },
        );
        expect(calls[0].url).toBe("https://playground.pinecall.io/api/credentials/xai");
        expect(calls[0].init.method).toBe("DELETE");
        expect(result).toMatchObject({ provider: "xai", configured: false, removed: true });
    });
});

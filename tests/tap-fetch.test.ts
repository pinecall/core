/**
 * Fetching — the politeness contract, and the refusals.
 *
 * The user-agent and the timeout are not decoration: they are what makes this
 * crawler identifiable and bounded. If either regresses, a site owner's only
 * remedy is to block the whole SDK.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
    fetchPage,
    mapWithConcurrency,
    TapFetchError,
    USER_AGENT,
    TAP_VERSION,
    DEFAULT_TIMEOUT_MS,
} from "../src/tap/fetch.js";
import type { TapProgress } from "../src/tap/types.js";

function res(init: {
    ok?: boolean;
    status?: number;
    contentType?: string;
    body?: string;
    url?: string;
    etag?: string;
    lastModified?: string;
}): Response {
    const headers = new Headers();
    if (init.contentType) headers.set("content-type", init.contentType);
    if (init.etag) headers.set("etag", init.etag);
    if (init.lastModified) headers.set("last-modified", init.lastModified);
    return {
        ok: init.ok ?? true,
        status: init.status ?? 200,
        url: init.url ?? "",
        headers,
        text: async () => init.body ?? "",
    } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("USER_AGENT", () => {
    it("identifies the crawler and where to complain", () => {
        expect(USER_AGENT).toBe(`pinecall-tap/${TAP_VERSION} (+https://pinecall.io)`);
        expect(USER_AGENT).toMatch(/^pinecall-tap\/\d+\.\d+\.\d+ \(\+https:\/\/pinecall\.io\)$/);
    });

    it("defaults to a 15s per-page timeout", () => {
        expect(DEFAULT_TIMEOUT_MS).toBe(15_000);
    });
});

describe("fetchPage", () => {
    it("returns body, validators and the post-redirect URL", async () => {
        fetchMock.mockResolvedValue(
            res({
                contentType: "text/html; charset=utf-8",
                body: "<html><body>hi</body></html>",
                url: "https://ex.com/final",
                etag: 'W/"abc"',
                lastModified: "Wed, 21 Oct 2026 07:28:00 GMT",
            }),
        );

        const page = await fetchPage("https://ex.com/start");
        expect(page.finalUrl).toBe("https://ex.com/final");
        expect(page.etag).toBe('W/"abc"');
        expect(page.lastModified).toBe("Wed, 21 Oct 2026 07:28:00 GMT");
        expect(page.bytes).toBe(28);

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(init.redirect).toBe("follow");
        expect((init.headers as Record<string, string>)["user-agent"]).toBe(USER_AGENT);
        expect(init.signal).toBeDefined();
    });

    it("refuses a non-HTML response when HTML was asked for", async () => {
        fetchMock.mockResolvedValue(res({ contentType: "application/pdf", body: "%PDF" }));
        await expect(fetchPage("https://ex.com/a.pdf")).rejects.toThrow(TapFetchError);
    });

    it("accepts any content type when the caller asks for XML", async () => {
        fetchMock.mockResolvedValue(res({ contentType: "text/plain", body: "<urlset/>" }));
        const page = await fetchPage("https://ex.com/sitemap.xml", { accept: "application/xml" });
        expect(page.body).toBe("<urlset/>");
    });

    it("turns a non-2xx into a typed error carrying the status", async () => {
        fetchMock.mockResolvedValue(res({ ok: false, status: 503 }));
        await expect(fetchPage("https://ex.com/x")).rejects.toMatchObject({
            name: "TapFetchError",
            status: 503,
            url: "https://ex.com/x",
        });
    });

    it("emits start then page, and an error event when it fails", async () => {
        fetchMock.mockResolvedValue(res({ contentType: "text/html", body: "<p>ok</p>" }));
        const ok: TapProgress[] = [];
        await fetchPage("https://ex.com/a", { onProgress: (ev) => ok.push(ev), done: 2, total: 5 });
        expect(ok).toEqual([
            { phase: "fetch", event: "start", url: "https://ex.com/a", done: 2, total: 5 },
            { phase: "fetch", event: "page", url: "https://ex.com/a", done: 3, total: 5 },
        ]);

        fetchMock.mockResolvedValue(res({ ok: false, status: 404 }));
        const bad: TapProgress[] = [];
        await expect(
            fetchPage("https://ex.com/b", { onProgress: (ev) => bad.push(ev) }),
        ).rejects.toThrow();
        expect(bad.at(-1)).toMatchObject({ phase: "fetch", event: "error", done: 0, total: 1 });
    });

    it("survives a listener that throws", async () => {
        fetchMock.mockResolvedValue(res({ contentType: "text/html", body: "<p>ok</p>" }));
        await expect(
            fetchPage("https://ex.com/a", {
                onProgress: () => {
                    throw new Error("consumer bug");
                },
            }),
        ).resolves.toBeDefined();
    });
});

describe("mapWithConcurrency", () => {
    it("keeps results in input order", async () => {
        const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 2);
        expect(out).toEqual([2, 4, 6, 8, 10]);
    });

    it("never exceeds the cap", async () => {
        let inFlight = 0;
        let peak = 0;
        await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 4, async (n) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 1));
            inFlight--;
            return n;
        });
        expect(peak).toBeLessThanOrEqual(4);
    });

    it("handles an empty list", async () => {
        expect(await mapWithConcurrency([], 4, async (n) => n)).toEqual([]);
    });
});

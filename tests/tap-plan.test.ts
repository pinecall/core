/**
 * planTap — the preview.
 *
 * Every request is mocked: a plan that reaches the network is a test that
 * fails on a train. What is pinned hardest here is what the preview PROMISES —
 * that nothing is written, that an excluded page is listed without being
 * fetched, and that a broken page costs one row and not the whole run.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { planTap, docPath, isExcluded } from "../src/tap/plan.js";
import type { TapProgress } from "../src/tap/types.js";

function res(body: string, contentType: string, url = ""): Response {
    return {
        ok: true,
        status: 200,
        url,
        headers: new Headers({ "content-type": contentType }),
        text: async () => body,
    } as unknown as Response;
}

const html = (body: string, url = "") => res(body, "text/html; charset=utf-8", url);
const xml = (body: string) => res(body, "application/xml");
const text = (body: string) => res(body, "text/plain");

function notFound(): Response {
    return {
        ok: false,
        status: 404,
        url: "",
        headers: new Headers(),
        text: async () => "",
    } as unknown as Response;
}

function routes(table: Record<string, Response | (() => Response)>) {
    return vi.fn(async (input: unknown) => {
        const url = String(input);
        const hit = table[url];
        if (!hit) return notFound();
        return typeof hit === "function" ? hit() : hit;
    });
}

/** A page with enough prose that defuddle keeps it and it is not "thin". */
function page(title: string, words: number): string {
    const body = Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
    return `<!doctype html><html><head><title>${title}</title></head><body>
        <article><h1>${title}</h1><p>${body}</p></article>
    </body></html>`;
}

const SITE = "https://ex.com";

const SITEMAP = `<?xml version="1.0"?><urlset>
    <url><loc>https://ex.com/</loc></url>
    <url><loc>https://ex.com/about</loc></url>
    <url><loc>https://ex.com/news/foo</loc></url>
</urlset>`;

function threePageSite(overrides: Record<string, Response | (() => Response)> = {}) {
    return routes({
        "https://ex.com/robots.txt": () => text("User-agent: *\nAllow: /\n"),
        "https://ex.com/sitemap.xml": () => xml(SITEMAP),
        "https://ex.com/": () => html(page("Home", 400), "https://ex.com/"),
        "https://ex.com/about": () => html(page("About", 400), "https://ex.com/about"),
        "https://ex.com/news/foo": () =>
            html(page("Foo", 400), "https://ex.com/news/foo"),
        ...overrides,
    });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn(async () => notFound());
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("docPath", () => {
    const table: Array<[string, string]> = [
        ["https://ex.com/", "index.md"],
        ["https://ex.com", "index.md"],
        ["https://ex.com/about", "about.md"],
        ["https://ex.com/news/foo", "news__foo.md"],
        ["https://ex.com/a/b/c/", "a__b__c.md"],
        ["https://ex.com/about.html", "about.md"],
    ];
    for (const [url, expected] of table) {
        it(`${url} -> ${expected}`, () => {
            expect(docPath(url)).toBe(expected);
        });
    }
});

describe("isExcluded", () => {
    it("treats include as an allow-list", () => {
        expect(isExcluded("https://ex.com/blog/a", [/\/blog\//])).toBe(false);
        expect(isExcluded("https://ex.com/about", [/\/blog\//])).toBe(true);
    });

    it("lets exclude win over include", () => {
        expect(isExcluded("https://ex.com/blog/draft", [/\/blog\//], [/draft/])).toBe(true);
    });

    it("includes everything with neither list", () => {
        expect(isExcluded("https://ex.com/anything")).toBe(false);
    });
});

describe("planTap", () => {
    it("returns the whole page table for a three-page site", async () => {
        fetchMock = threePageSite();
        vi.stubGlobal("fetch", fetchMock);

        const plan = await planTap(`${SITE}/`);

        expect(plan.startUrl).toBe(`${SITE}/`);
        expect(plan.source).toBe("sitemap");
        expect(plan.pages.map((p) => p.path).sort()).toEqual([
            "about.md",
            "index.md",
            "news__foo.md",
        ]);
        expect(plan.totals).toMatchObject({ pages: 3, included: 3, excluded: 0, failed: 0 });
        for (const p of plan.pages) {
            expect(p.hash).toMatch(/^[0-9a-f]{16}$/);
            expect(p.words).toBeGreaterThan(0);
            expect(p.tokens).toBeGreaterThan(0);
            expect(p.error).toBeUndefined();
        }
        expect(plan.totals.words).toBe(
            plan.pages.reduce((n, p) => n + p.words, 0),
        );
    });

    it("makes no knowledge-base call", async () => {
        fetchMock = threePageSite();
        vi.stubGlobal("fetch", fetchMock);

        await planTap(`${SITE}/`);

        const called = fetchMock.mock.calls.map((c) => String(c[0]));
        expect(called.some((u) => u.includes("/api/knowledge"))).toBe(false);
        expect(called.every((u) => u.startsWith(SITE))).toBe(true);
    });

    it("marks excluded pages without fetching them", async () => {
        fetchMock = threePageSite();
        vi.stubGlobal("fetch", fetchMock);

        const plan = await planTap(`${SITE}/`, { exclude: [/\/news\//] });

        const excluded = plan.pages.filter((p) => p.excluded);
        expect(excluded).toHaveLength(1);
        expect(excluded[0]!.url).toBe("https://ex.com/news/foo");
        expect(excluded[0]!.path).toBe("news__foo.md");
        expect(plan.totals).toMatchObject({ pages: 3, included: 2, excluded: 1 });

        const called = fetchMock.mock.calls.map((c) => String(c[0]));
        expect(called).not.toContain("https://ex.com/news/foo");
    });

    it("honours include as an allow-list", async () => {
        fetchMock = threePageSite();
        vi.stubGlobal("fetch", fetchMock);

        const plan = await planTap(`${SITE}/`, { include: [/\/news\//] });

        expect(plan.totals).toMatchObject({ included: 1, excluded: 2 });
        expect(plan.pages.find((p) => !p.excluded)!.url).toBe("https://ex.com/news/foo");
    });

    it("keeps a failed page as a row carrying its error", async () => {
        fetchMock = threePageSite({ "https://ex.com/about": () => notFound() });
        vi.stubGlobal("fetch", fetchMock);

        const plan = await planTap(`${SITE}/`);

        expect(plan.pages).toHaveLength(3);
        const bad = plan.pages.find((p) => p.url === "https://ex.com/about")!;
        expect(bad.error).toMatch(/404/);
        expect(bad.hash).toBe("");
        expect(plan.totals).toMatchObject({ included: 2, failed: 1 });
    });

    it("omits markdown by default and retains it with keepContent", async () => {
        fetchMock = threePageSite();
        vi.stubGlobal("fetch", fetchMock);

        const lean = await planTap(`${SITE}/`);
        expect(lean.pages.every((p) => p.markdown === undefined)).toBe(true);

        fetchMock = threePageSite();
        vi.stubGlobal("fetch", fetchMock);

        const full = await planTap(`${SITE}/`, { keepContent: true });
        expect(full.pages.every((p) => typeof p.markdown === "string")).toBe(true);
        expect(full.pages.every((p) => p.markdown!.length > 0)).toBe(true);
    });

    it("emits progress with monotonic done/total on every event", async () => {
        fetchMock = threePageSite();
        vi.stubGlobal("fetch", fetchMock);

        const events: TapProgress[] = [];
        await planTap(`${SITE}/`, { onProgress: (ev) => events.push(ev) });

        expect(events.length).toBeGreaterThan(0);
        for (const ev of events) {
            expect(typeof ev.done).toBe("number");
            expect(typeof ev.total).toBe("number");
            expect(ev.done).toBeLessThanOrEqual(ev.total);
        }

        const phases = new Set(events.map((e) => e.phase));
        expect(phases.has("discover")).toBe(true);
        expect(phases.has("fetch")).toBe(true);
        expect(phases.has("extract")).toBe(true);

        // Per phase the counter only ever moves forward.
        for (const phase of ["discover", "extract"] as const) {
            const seq = events.filter((e) => e.phase === phase).map((e) => e.done);
            for (let i = 1; i < seq.length; i++) {
                expect(seq[i]!).toBeGreaterThanOrEqual(seq[i - 1]!);
            }
        }

        const last = events.at(-1)!;
        expect(last).toMatchObject({ phase: "extract", event: "done", done: 3, total: 3 });
    });

    it("returns an empty plan when robots refuses the crawl", async () => {
        fetchMock = routes({
            "https://ex.com/robots.txt": () => text("User-agent: *\nDisallow: /\n"),
        });
        vi.stubGlobal("fetch", fetchMock);

        const plan = await planTap(`${SITE}/`);

        expect(plan.pages).toEqual([]);
        expect(plan.source).toBe("links");
        expect(plan.startUrl).toBe(`${SITE}/`);
        expect(plan.totals).toMatchObject({ pages: 0, included: 0, excluded: 0, failed: 0 });
    });

    it("respects the page limit", async () => {
        fetchMock = threePageSite();
        vi.stubGlobal("fetch", fetchMock);

        const plan = await planTap(`${SITE}/`, { limit: 2 });
        expect(plan.pages).toHaveLength(2);
    });
});

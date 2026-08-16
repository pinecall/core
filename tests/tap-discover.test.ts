/**
 * Discovery — robots, sitemaps, the link fallback, and URL normalization.
 *
 * Every request here is mocked: a unit test that reaches the network is a test
 * that fails on a train. The normalization table is the part worth pinning
 * hardest — it is what decides whether a re-tap matches what the last one
 * pushed, or duplicates the whole site under `?utm_source=`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
    discover,
    readRobots,
    readSitemap,
    normalizeUrl,
    sameSite,
    isIndexable,
    allowedByRobots,
    extractLinks,
} from "../src/tap/discover.js";
import { USER_AGENT } from "../src/tap/fetch.js";
import type { TapProgress } from "../src/tap/types.js";

function html(body: string): Response {
    return {
        ok: true,
        status: 200,
        url: "",
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        text: async () => body,
    } as unknown as Response;
}

function xml(body: string): Response {
    return {
        ok: true,
        status: 200,
        url: "",
        headers: new Headers({ "content-type": "application/xml" }),
        text: async () => body,
    } as unknown as Response;
}

function text(body: string): Response {
    return {
        ok: true,
        status: 200,
        url: "",
        headers: new Headers({ "content-type": "text/plain" }),
        text: async () => body,
    } as unknown as Response;
}

function notFound(): Response {
    return {
        ok: false,
        status: 404,
        url: "",
        headers: new Headers(),
        text: async () => "",
    } as unknown as Response;
}

/** Route mocked fetches by URL — the crawler makes several per run. */
function routes(table: Record<string, Response | (() => Response)>) {
    return vi.fn(async (input: unknown) => {
        const url = String(input);
        const hit = table[url];
        if (!hit) return notFound();
        return typeof hit === "function" ? hit() : hit;
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

describe("normalizeUrl", () => {
    const table: Array<[string, string | null, string?]> = [
        ["https://ex.com/a#section", "https://ex.com/a"],
        ["https://ex.com/a?utm_source=x&id=7", "https://ex.com/a?id=7"],
        ["https://ex.com/a?utm_medium=x&utm_campaign=y", "https://ex.com/a"],
        ["https://ex.com/a?fbclid=abc", "https://ex.com/a"],
        ["https://ex.com/a?gclid=abc", "https://ex.com/a"],
        ["https://ex.com/a?ref=twitter", "https://ex.com/a"],
        ["https://ex.com/a/", "https://ex.com/a"],
        ["https://ex.com/", "https://ex.com/"],
        ["/relative/page", "https://ex.com/relative/page", "https://ex.com/start"],
        ["mailto:hi@ex.com", null],
        ["javascript:void(0)", null],
        ["not a url", null],
    ];

    for (const [input, expected, base] of table) {
        it(`${input} -> ${expected}`, () => {
            expect(normalizeUrl(input, base)).toBe(expected);
        });
    }

    it("keeps a real query parameter that merely starts with a tracking word", () => {
        // `referrer` is not `ref`; the rule is anchored on purpose.
        expect(normalizeUrl("https://ex.com/a?referrer=x")).toBe("https://ex.com/a?referrer=x");
    });
});

describe("sameSite / isIndexable", () => {
    it("is host-scoped, not domain-scoped", () => {
        expect(sameSite("https://ex.com/a", "https://ex.com")).toBe(true);
        expect(sameSite("https://blog.ex.com/a", "https://ex.com")).toBe(false);
        expect(sameSite("https://other.com/a", "https://ex.com")).toBe(false);
    });

    it("skips assets and keeps pages", () => {
        expect(isIndexable("https://ex.com/docs")).toBe(true);
        expect(isIndexable("https://ex.com/a.html")).toBe(true);
        for (const asset of ["a.pdf", "b.png", "c.JPG", "d.css", "e.js", "f.xml", "g.zip", "h.mp4"]) {
            expect(isIndexable(`https://ex.com/${asset}`)).toBe(false);
        }
    });
});

describe("allowedByRobots", () => {
    it("matches by path prefix", () => {
        expect(allowedByRobots("https://ex.com/admin/x", ["/admin"])).toBe(false);
        expect(allowedByRobots("https://ex.com/docs", ["/admin"])).toBe(true);
    });

    it("allows everything when there are no rules", () => {
        expect(allowedByRobots("https://ex.com/anything", [])).toBe(true);
    });

    it("honours a blanket disallow like any other rule", () => {
        expect(allowedByRobots("https://ex.com/a", ["/"])).toBe(false);
        expect(allowedByRobots("https://ex.com/", ["/"])).toBe(false);
    });
});

describe("readRobots", () => {
    it("collects sitemaps and the rules for User-agent: *", async () => {
        fetchMock.mockImplementation(
            routes({
                "https://ex.com/robots.txt": text(
                    [
                        "Sitemap: https://ex.com/sitemap.xml",
                        "Sitemap: https://ex.com/news.xml",
                        "User-agent: *",
                        "Disallow: /admin",
                        "Disallow: /cart",
                        "User-agent: BadBot",
                        "Disallow: /everything",
                    ].join("\n"),
                ),
            }),
        );

        const robots = await readRobots("https://ex.com");
        expect(robots.sitemaps).toEqual(["https://ex.com/sitemap.xml", "https://ex.com/news.xml"]);
        expect(robots.disallow).toEqual(["/admin", "/cart"]);
        expect(fetchMock.mock.calls[0]![1].headers["user-agent"]).toBe(USER_AGENT);
    });

    it("treats a missing robots.txt as no rules", async () => {
        const robots = await readRobots("https://ex.com");
        expect(robots).toEqual({ sitemaps: [], disallow: [] });
    });
});

describe("readSitemap", () => {
    it("recurses through a sitemapindex", async () => {
        fetchMock.mockImplementation(
            routes({
                "https://ex.com/sitemap.xml": xml(`<?xml version="1.0"?>
                    <sitemapindex>
                      <sitemap><loc>https://ex.com/sm-1.xml</loc></sitemap>
                      <sitemap><loc>https://ex.com/sm-2.xml</loc></sitemap>
                    </sitemapindex>`),
                "https://ex.com/sm-1.xml": xml(`<urlset>
                      <url><loc>https://ex.com/a</loc></url>
                      <url><loc>https://ex.com/b</loc></url>
                    </urlset>`),
                "https://ex.com/sm-2.xml": xml(`<urlset>
                      <url><loc>https://ex.com/c?x=1&amp;y=2</loc></url>
                    </urlset>`),
            }),
        );

        const urls = await readSitemap("https://ex.com/sitemap.xml");
        expect(urls).toEqual(["https://ex.com/a", "https://ex.com/b", "https://ex.com/c?x=1&y=2"]);
    });

    it("does not loop on a self-referencing index", async () => {
        fetchMock.mockImplementation(
            routes({
                "https://ex.com/sitemap.xml": xml(`<sitemapindex>
                      <sitemap><loc>https://ex.com/sitemap.xml</loc></sitemap>
                      <sitemap><loc>https://ex.com/sm.xml</loc></sitemap>
                    </sitemapindex>`),
                "https://ex.com/sm.xml": xml(`<urlset><url><loc>https://ex.com/a</loc></url></urlset>`),
            }),
        );

        const urls = await readSitemap("https://ex.com/sitemap.xml");
        expect(urls).toEqual(["https://ex.com/a"]);
    });

    it("honours the limit", async () => {
        fetchMock.mockImplementation(
            routes({
                "https://ex.com/sitemap.xml": xml(`<urlset>
                      <url><loc>https://ex.com/a</loc></url>
                      <url><loc>https://ex.com/b</loc></url>
                      <url><loc>https://ex.com/c</loc></url>
                    </urlset>`),
            }),
        );

        expect(await readSitemap("https://ex.com/sitemap.xml", { limit: 2 })).toHaveLength(2);
    });

    it("returns nothing when the sitemap does not exist", async () => {
        expect(await readSitemap("https://ex.com/sitemap.xml")).toEqual([]);
    });
});

describe("extractLinks", () => {
    it("normalizes, dedupes and drops non-http hrefs", () => {
        const links = extractLinks(
            `<a href="/a">a</a><a href="/a/">again</a><a href="/b#top">b</a>
             <a href="mailto:x@y.z">mail</a><a href="https://other.com/c">off</a>`,
            "https://ex.com/start",
        );
        expect(links).toEqual(["https://ex.com/a", "https://ex.com/b", "https://other.com/c"]);
    });
});

describe("discover", () => {
    it("prefers the sitemap and filters it by host, extension and robots", async () => {
        fetchMock.mockImplementation(
            routes({
                "https://ex.com/robots.txt": text("Sitemap: https://ex.com/sitemap.xml\nUser-agent: *\nDisallow: /admin"),
                "https://ex.com/sitemap.xml": xml(`<urlset>
                      <url><loc>https://ex.com/a/</loc></url>
                      <url><loc>https://ex.com/a?utm_source=nl</loc></url>
                      <url><loc>https://ex.com/admin/secret</loc></url>
                      <url><loc>https://ex.com/brochure.pdf</loc></url>
                      <url><loc>https://other.com/b</loc></url>
                      <url><loc>https://ex.com/b</loc></url>
                    </urlset>`),
            }),
        );

        const result = await discover("https://ex.com");
        expect(result.source).toBe("sitemap");
        expect(result.urls).toEqual(["https://ex.com/a", "https://ex.com/b"]);
        expect(result.disallow).toEqual(["/admin"]);
    });

    it("falls back to a one-hop link crawl when there is no sitemap", async () => {
        fetchMock.mockImplementation(
            routes({
                "https://ex.com/robots.txt": notFound(),
                "https://ex.com/sitemap.xml": notFound(),
                "https://ex.com/": html(
                    `<a href="/docs">docs</a><a href="/pricing">pricing</a>
                     <a href="/logo.png">logo</a><a href="https://x.com/pinecall">x</a>`,
                ),
            }),
        );

        const result = await discover("https://ex.com/");
        expect(result.source).toBe("links");
        expect(result.urls).toEqual([
            "https://ex.com/",
            "https://ex.com/docs",
            "https://ex.com/pricing",
        ]);
    });

    it("still returns the entry URL when the entry page cannot be fetched", async () => {
        const result = await discover("https://ex.com/start");
        expect(result.urls).toEqual(["https://ex.com/start"]);
        expect(result.source).toBe("links");
    });

    it("returns nothing when robots refuses crawlers outright", async () => {
        fetchMock.mockImplementation(
            routes({
                "https://ex.com/robots.txt": text("User-agent: *\nDisallow: /"),
                "https://ex.com/sitemap.xml": xml(
                    `<urlset><url><loc>https://ex.com/a</loc></url></urlset>`,
                ),
                "https://ex.com/": html(`<a href="/docs">docs</a>`),
            }),
        );

        const events: TapProgress[] = [];
        const result = await discover("https://ex.com/", {
            onProgress: (ev) => events.push(ev),
        });
        expect(result.urls).toEqual([]);
        expect(result.source).toBe("links");
        expect(result.disallow).toEqual(["/"]);
        expect(events.at(-1)).toMatchObject({ event: "done", done: 0, total: 0 });
        // The entry page is never fetched: robots said no before we knocked.
        expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain("https://ex.com/");
    });

    it("caps the list at the limit", async () => {
        fetchMock.mockImplementation(
            routes({
                "https://ex.com/robots.txt": text("Sitemap: https://ex.com/sitemap.xml"),
                "https://ex.com/sitemap.xml": xml(
                    `<urlset>${["a", "b", "c", "d"]
                        .map((p) => `<url><loc>https://ex.com/${p}</loc></url>`)
                        .join("")}</urlset>`,
                ),
            }),
        );

        const result = await discover("https://ex.com", { limit: 2 });
        expect(result.urls).toEqual(["https://ex.com/a", "https://ex.com/b"]);
    });

    it("emits progress that starts, counts and finishes", async () => {
        fetchMock.mockImplementation(
            routes({
                "https://ex.com/robots.txt": text("Sitemap: https://ex.com/sitemap.xml"),
                "https://ex.com/sitemap.xml": xml(
                    `<urlset><url><loc>https://ex.com/a</loc></url><url><loc>https://ex.com/b</loc></url></urlset>`,
                ),
            }),
        );

        const events: TapProgress[] = [];
        await discover("https://ex.com", { onProgress: (ev) => events.push(ev) });

        expect(events[0]).toMatchObject({ phase: "discover", event: "start", done: 0 });
        expect(events.at(-1)).toMatchObject({ phase: "discover", event: "done", done: 2, total: 2 });
        expect(events.filter((e) => e.event === "page").map((e) => e.done)).toEqual([1, 2]);
        // Every event carries the counters — that is what draws the bar.
        for (const ev of events) {
            expect(typeof ev.done).toBe("number");
            expect(typeof ev.total).toBe("number");
        }
    });
});

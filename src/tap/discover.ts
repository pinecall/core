/**
 * Which URLs make up "a website".
 *
 * Sitemap first — it is authoritative, costs one request and needs no HTML
 * parsing. The link crawl is the fallback, and it is deliberately one hop: a
 * preview that takes a minute to compute is a preview nobody waits for.
 *
 * Normalization is the other half of the job. Without it the same page lands
 * in the knowledge base once per tracking parameter, and a re-tap never
 * matches what the previous one pushed.
 */

import { parseHTML } from "linkedom";

import { fetchPage, USER_AGENT } from "./fetch.js";
import { emit, type DiscoverResult, type OnProgress } from "./types.js";

/** Things that are not pages: fetching them wastes the budget and the host's. */
const SKIP_EXTENSIONS =
    /\.(pdf|zip|gz|tar|png|jpe?g|gif|svg|webp|avif|ico|mp4|webm|mp3|wav|css|js|json|xml|rss|atom)$/i;

/** Parameters that identify a visit, never a page. */
const TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_|ref$|source$)/i;

/** A sitemapindex may point at a sitemapindex; three levels is already unusual. */
const MAX_SITEMAP_DEPTH = 3;

export const DEFAULT_PAGE_LIMIT = 100;
export const DEFAULT_CONCURRENCY = 4;

/**
 * Canonical form of a URL: absolute, http(s), no fragment, no tracking noise,
 * no trailing slash (except the root). Returns null for anything unusable.
 */
export function normalizeUrl(raw: string, base?: string): string | null {
    let u: URL;
    try {
        u = new URL(raw, base);
    } catch {
        return null;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
        if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    }
    if (u.pathname !== "/" && u.pathname.endsWith("/")) {
        u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
}

/** Same host — not merely same registrable domain: a subdomain is a site. */
export function sameSite(url: string, origin: string): boolean {
    try {
        return new URL(url).host === new URL(origin).host;
    } catch {
        return false;
    }
}

export function isIndexable(url: string): boolean {
    try {
        return !SKIP_EXTENSIONS.test(new URL(url).pathname);
    } catch {
        return false;
    }
}

export interface RobotsInfo {
    sitemaps: string[];
    disallow: string[];
}

/** robots.txt: the sitemap pointers and the disallow list for `User-agent: *`. */
export async function readRobots(
    origin: string,
    opts: { timeoutMs?: number } = {},
): Promise<RobotsInfo> {
    const out: RobotsInfo = { sitemaps: [], disallow: [] };
    try {
        const res = await fetch(new URL("/robots.txt", origin).toString(), {
            headers: { "user-agent": USER_AGENT },
            signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
        });
        if (!res.ok) return out;
        const text = await res.text();
        let applies = false;
        for (const line of text.split("\n")) {
            const [rawKey, ...rest] = line.split(":");
            const key = (rawKey ?? "").trim().toLowerCase();
            const value = rest.join(":").trim();
            if (!value) continue;
            if (key === "sitemap") out.sitemaps.push(value);
            else if (key === "user-agent") applies = value === "*";
            else if (key === "disallow" && applies) out.disallow.push(value);
        }
    } catch {
        /* no robots.txt is a valid answer, and so is a broken one */
    }
    return out;
}

/**
 * A prefix match, which is what the robots.txt convention actually specifies.
 * A blanket `Disallow: /` is honoured like any other rule: tap is not
 * necessarily run by the site's owner — the first consumer lets any visitor
 * tap any third-party site — so a stranger's crawl must not enter a site that
 * refuses crawlers. Discovery then yields nothing and the caller can report
 * "this site refuses crawlers" honestly.
 */
export function allowedByRobots(url: string, disallow: readonly string[]): boolean {
    if (!disallow.length) return true;
    let path: string;
    try {
        path = new URL(url).pathname;
    } catch {
        return false;
    }
    return !disallow.some((rule) => path.startsWith(rule));
}

function decodeEntities(s: string): string {
    return s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");
}

export interface ReadSitemapOptions {
    limit?: number;
    depth?: number;
    seen?: Set<string>;
    timeoutMs?: number;
}

/** Follow sitemap indexes recursively, bounded in both depth and count. */
export async function readSitemap(
    sitemapUrl: string,
    opts: ReadSitemapOptions = {},
): Promise<string[]> {
    const { limit = 500, depth = 0, seen = new Set<string>(), timeoutMs } = opts;
    if (depth > MAX_SITEMAP_DEPTH || seen.has(sitemapUrl) || limit <= 0) return [];
    seen.add(sitemapUrl);

    let body: string;
    try {
        ({ body } = await fetchPage(sitemapUrl, {
            accept: "application/xml",
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }));
    } catch {
        return [];
    }

    const locs = [...body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) =>
        decodeEntities(m[1]!),
    );
    if (!/<sitemapindex/i.test(body)) return locs.slice(0, limit);

    const urls: string[] = [];
    for (const child of locs) {
        if (urls.length >= limit) break;
        urls.push(
            ...(await readSitemap(child, {
                limit: limit - urls.length,
                depth: depth + 1,
                seen,
                ...(timeoutMs === undefined ? {} : { timeoutMs }),
            })),
        );
    }
    return urls;
}

/** Every same-document link on a page, normalized and deduped. */
export function extractLinks(html: string, baseUrl: string): string[] {
    const { document } = parseHTML(html);
    const out = new Set<string>();
    for (const a of document.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href");
        if (!href) continue;
        const normalized = normalizeUrl(href, baseUrl);
        if (normalized) out.add(normalized);
    }
    return [...out];
}

export interface DiscoverOptions {
    limit?: number;
    timeoutMs?: number;
    onProgress?: OnProgress;
}

/**
 * The URL list for a site: sitemap when there is one, one hop of links
 * otherwise. Reports which path it took so the caller can say so out loud —
 * "found 12 links off the homepage" and "read your sitemap" are very
 * different promises about coverage.
 */
export async function discover(
    startUrl: string,
    opts: DiscoverOptions = {},
): Promise<DiscoverResult> {
    const { limit = DEFAULT_PAGE_LIMIT, timeoutMs, onProgress } = opts;
    const origin = new URL(startUrl).origin;

    emit(onProgress, {
        phase: "discover",
        event: "start",
        url: startUrl,
        done: 0,
        total: limit,
    });

    const robots = await readRobots(origin, timeoutMs === undefined ? {} : { timeoutMs });
    const candidates = robots.sitemaps.length
        ? robots.sitemaps
        : [new URL("/sitemap.xml", origin).toString()];

    const found = new Set<string>();
    for (const sitemap of candidates) {
        const locs = await readSitemap(sitemap, {
            limit: limit * 4,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
        for (const loc of locs) {
            const n = normalizeUrl(loc, origin);
            if (!n) continue;
            if (!sameSite(n, origin)) continue;
            if (!isIndexable(n)) continue;
            if (!allowedByRobots(n, robots.disallow)) continue;
            if (found.has(n)) continue;
            found.add(n);
            emit(onProgress, {
                phase: "discover",
                event: "page",
                url: n,
                done: found.size,
                total: Math.max(limit, found.size),
            });
        }
        if (found.size >= limit) break;
    }

    if (found.size > 0) {
        const urls = [...found].slice(0, limit);
        emit(onProgress, {
            phase: "discover",
            event: "done",
            done: urls.length,
            total: urls.length,
            message: "sitemap",
        });
        return { source: "sitemap", urls, disallow: robots.disallow, sitemaps: robots.sitemaps };
    }

    // Fallback: one hop off the entry page. The start URL stays in the list
    // whatever happens — a site of one page is still a site — UNLESS robots
    // forbids it, in which case discovery returns nothing and the caller can
    // say the site refuses crawlers.
    const start = normalizeUrl(startUrl, origin) ?? startUrl;
    if (!allowedByRobots(start, robots.disallow)) {
        emit(onProgress, {
            phase: "discover",
            event: "done",
            done: 0,
            total: 0,
            message: "robots",
        });
        return {
            source: "links",
            urls: [],
            disallow: robots.disallow,
            sitemaps: robots.sitemaps,
        };
    }
    const urls = new Set<string>([start]);
    try {
        const { body, finalUrl } = await fetchPage(start, {
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
        for (const link of extractLinks(body, finalUrl)) {
            if (urls.size >= limit) break;
            if (!sameSite(link, origin)) continue;
            if (!isIndexable(link)) continue;
            if (!allowedByRobots(link, robots.disallow)) continue;
            if (urls.has(link)) continue;
            urls.add(link);
            emit(onProgress, {
                phase: "discover",
                event: "page",
                url: link,
                done: urls.size,
                total: Math.max(limit, urls.size),
            });
        }
    } catch (err) {
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        emit(onProgress, {
            phase: "discover",
            event: "error",
            url: start,
            done: urls.size,
            total: urls.size,
            message,
        });
    }

    const list = [...urls].slice(0, limit);
    emit(onProgress, {
        phase: "discover",
        event: "done",
        done: list.length,
        total: list.length,
        message: "links",
    });
    return { source: "links", urls: list, disallow: robots.disallow, sitemaps: robots.sitemaps };
}

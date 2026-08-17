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

/**
 * One `<url>` element's worth of sitemap: the location, plus the `<priority>`
 * the site declared for it when it declared one. Priority is optional in the
 * protocol and most sitemaps omit it, so it stays `undefined` rather than
 * defaulting to the spec's 0.5 — "no opinion" and "middling" rank differently.
 */
export interface SitemapEntry {
    url: string;
    priority?: number;
}

const LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/i;
const PRIORITY_RE = /<priority>\s*([0-9.]+)\s*<\/priority>/i;

/**
 * Locations with their priorities, read from the SAME `<url>` element so a
 * priority can never be attributed to a neighbouring loc. Falls back to a flat
 * scan of `<loc>` for documents that carry no `<url>` wrappers (a sitemapindex,
 * or a hand-written file).
 */
function parseSitemapEntries(body: string): SitemapEntry[] {
    const blocks = [...body.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)];
    const out: SitemapEntry[] = [];
    for (const block of blocks) {
        const inner = block[1]!;
        const loc = LOC_RE.exec(inner);
        if (!loc) continue;
        const prio = PRIORITY_RE.exec(inner);
        const value = prio ? Number.parseFloat(prio[1]!) : Number.NaN;
        out.push({
            url: decodeEntities(loc[1]!),
            ...(Number.isFinite(value) ? { priority: value } : {}),
        });
    }
    if (out.length) return out;
    return [...body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => ({
        url: decodeEntities(m[1]!),
    }));
}

/**
 * Follow sitemap indexes recursively, bounded in both depth and count, keeping
 * each location's declared priority.
 */
export async function readSitemapEntries(
    sitemapUrl: string,
    opts: ReadSitemapOptions = {},
): Promise<SitemapEntry[]> {
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

    const entries = parseSitemapEntries(body);
    if (!/<sitemapindex/i.test(body)) return entries.slice(0, limit);

    const urls: SitemapEntry[] = [];
    for (const child of entries) {
        if (urls.length >= limit) break;
        urls.push(
            ...(await readSitemapEntries(child.url, {
                limit: limit - urls.length,
                depth: depth + 1,
                seen,
                ...(timeoutMs === undefined ? {} : { timeoutMs }),
            })),
        );
    }
    return urls;
}

/** The locations alone, for callers that do not care about priority. */
export async function readSitemap(
    sitemapUrl: string,
    opts: ReadSitemapOptions = {},
): Promise<string[]> {
    return (await readSitemapEntries(sitemapUrl, opts)).map((e) => e.url);
}

/** Path segments below the root: `/` is 0, `/docs` is 1, `/docs/a/b` is 3. */
function pathDepth(url: string): number {
    try {
        return new URL(url).pathname.split("/").filter(Boolean).length;
    } catch {
        return Number.MAX_SAFE_INTEGER;
    }
}

/**
 * The order pages are offered to the limit, and the whole point of it: a
 * sitemap's own order is EXPORT order, not a ranking — linear.app's puts a few
 * hundred changelog posts ahead of the homepage, so a `limit=40` tap used to
 * index the changelog and miss what the site IS. So, before the cut:
 *
 *   1. path depth ascending — the homepage first, then `/docs`, `/pricing`,
 *      then their children. Shallow paths are the pages that explain the site.
 *   2. `<priority>` descending when the sitemap declares it — the site's own
 *      opinion, used to break depth ties. A page without one sorts after any
 *      page with one at the same depth: silence is not a claim.
 *   3. the original document index — a stable tiebreak, so the same sitemap
 *      always yields the same list.
 */
function rankBySitemapShape(entries: readonly SitemapEntry[]): SitemapEntry[] {
    return entries
        .map((entry, index) => ({ entry, index, depth: pathDepth(entry.url) }))
        .sort((a, b) => {
            if (a.depth !== b.depth) return a.depth - b.depth;
            const ap = a.entry.priority ?? -1;
            const bp = b.entry.priority ?? -1;
            if (ap !== bp) return bp - ap;
            return a.index - b.index;
        })
        .map((r) => r.entry);
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

    // Collect the whole readable sitemap first — the same filters, the same
    // internal read bound as before — because the cut can only pick well once
    // it can see everything it is choosing between. The bound is at least
    // `readSitemap`'s own default of 500: with a small limit, `limit * 4` alone
    // would stop reading inside the changelog and never see the homepage the
    // ranking exists to find.
    const readBound = Math.max(limit * 4, 500);
    const found = new Map<string, SitemapEntry>();
    for (const sitemap of candidates) {
        const entries = await readSitemapEntries(sitemap, {
            limit: readBound,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
        for (const entry of entries) {
            const n = normalizeUrl(entry.url, origin);
            if (!n) continue;
            if (!sameSite(n, origin)) continue;
            if (!isIndexable(n)) continue;
            if (!allowedByRobots(n, robots.disallow)) continue;
            if (found.has(n)) continue;
            found.set(n, {
                url: n,
                ...(entry.priority === undefined ? {} : { priority: entry.priority }),
            });
        }
        if (found.size >= readBound) break;
    }

    if (found.size > 0) {
        const urls = rankBySitemapShape([...found.values()])
            .slice(0, limit)
            .map((e) => e.url);
        for (const [i, url] of urls.entries()) {
            emit(onProgress, {
                phase: "discover",
                event: "page",
                url,
                done: i + 1,
                total: Math.max(limit, urls.length),
            });
        }
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

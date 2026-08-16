/**
 * planTap — the preview that touches nothing.
 *
 * The whole point of a plan is that it is safe to run: it discovers, fetches
 * and extracts, and then hands back a table the caller can show a human before
 * anything is written anywhere. There is not a single knowledge-base call in
 * this module, by design — `tap` is the verb that writes.
 *
 * Two decisions worth knowing about:
 *
 * - **Excluded pages are marked, not dropped.** A preview that silently omits
 *   half a site cannot be checked. They carry `excluded: true` and are never
 *   fetched, so an exclusion also saves the requests.
 * - **A bad page is a row, not an exception.** One 404 in a hundred URLs must
 *   not lose the other ninety-nine, so failures land as pages with `error`.
 */

import { discover, DEFAULT_CONCURRENCY, DEFAULT_PAGE_LIMIT } from "./discover.js";
import { fetchPage, mapWithConcurrency } from "./fetch.js";
import { extract, countWords, estimateTokens } from "./extract.js";
import { contentHash } from "./hash.js";
import { emit, type DiscoverySource, type OnProgress } from "./types.js";

export interface TapPage {
    url: string;
    /** Knowledge-base document path: `/news/foo` -> `news__foo.md`. */
    path: string;
    title: string;
    words: number;
    /** Rough estimate (characters / 4) — enough to budget an index. */
    tokens: number;
    thin: boolean;
    needsJs: boolean;
    /** Hash of the extracted markdown; empty for excluded or failed pages. */
    hash: string;
    /** Filtered out by `include`/`exclude` — listed, never fetched. */
    excluded?: true;
    /** Why this page has no content. Its presence is what "failed" means. */
    error?: string;
    /**
     * Only present when `keepContent` was requested. See {@link PlanTapOptions.keepContent}.
     */
    markdown?: string;
}

export interface TapPlanTotals {
    pages: number;
    included: number;
    excluded: number;
    failed: number;
    thin: number;
    needsJs: number;
    words: number;
    tokens: number;
}

export interface TapPlan {
    startUrl: string;
    source: DiscoverySource;
    pages: TapPage[];
    totals: TapPlanTotals;
}

export interface PlanTapOptions {
    /** Maximum pages to consider. Politeness default: 100. */
    limit?: number;
    /** In-flight requests. Politeness default: 4 — a browser's worth of load. */
    concurrency?: number;
    /** If given, a URL must match one of these to be included. */
    include?: RegExp[];
    /** A URL matching any of these is excluded, even if `include` matched. */
    exclude?: RegExp[];
    /** Preferred content language, passed to fetch and extraction. */
    language?: string;
    /** Per-page timeout override, in milliseconds. */
    timeoutMs?: number;
    /**
     * Retain each page's markdown on the returned plan.
     *
     * Off by default and deliberately so: a 200-page site is several megabytes
     * of prose, and a preview that a UI holds while a human reads it should not
     * pin that. Turn it on when the caller is about to `tap` the plan straight
     * away and wants to reuse the text instead of re-fetching the site.
     */
    keepContent?: boolean;
    onProgress?: OnProgress;
}

/**
 * Knowledge-base document path for a URL: the pathname with `/` as separator
 * flattened to `__`, `index` for the root, and a `.md` suffix. Flat because a
 * knowledge base is a flat namespace, and reversible enough to read.
 */
export function docPath(url: string): string {
    let pathname: string;
    try {
        pathname = new URL(url).pathname;
    } catch {
        pathname = url;
    }
    const trimmed = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!trimmed) return "index.md";
    const base = trimmed.replace(/\.(html?|php)$/i, "");
    return `${base.replace(/\//g, "__")}.md`;
}

/** `include` is an allow-list when present; `exclude` always wins. */
export function isExcluded(
    url: string,
    include?: readonly RegExp[],
    exclude?: readonly RegExp[],
): boolean {
    if (include?.length && !include.some((re) => re.test(url))) return true;
    if (exclude?.length && exclude.some((re) => re.test(url))) return true;
    return false;
}

function totalsOf(pages: readonly TapPage[]): TapPlanTotals {
    const totals: TapPlanTotals = {
        pages: pages.length,
        included: 0,
        excluded: 0,
        failed: 0,
        thin: 0,
        needsJs: 0,
        words: 0,
        tokens: 0,
    };
    for (const p of pages) {
        if (p.excluded) {
            totals.excluded++;
            continue;
        }
        if (p.error) {
            totals.failed++;
            continue;
        }
        totals.included++;
        if (p.thin) totals.thin++;
        if (p.needsJs) totals.needsJs++;
        totals.words += p.words;
        totals.tokens += p.tokens;
    }
    return totals;
}

/**
 * Preview what tapping a site would index — without writing anything.
 *
 * Discovers the URL list (sitemap first, one hop of links as fallback), then
 * fetches and extracts every page that survived the include/exclude filter,
 * with a bounded worker pool. Progress is emitted for discovery, fetch and
 * extract with monotonic `done`/`total`.
 *
 * A site whose robots.txt refuses crawlers yields a plan with no pages rather
 * than an exception — "this site refuses crawlers" is an answer, not a crash.
 */
export async function planTap(
    startUrl: string,
    opts: PlanTapOptions = {},
): Promise<TapPlan> {
    const {
        limit = DEFAULT_PAGE_LIMIT,
        concurrency = DEFAULT_CONCURRENCY,
        include,
        exclude,
        language,
        timeoutMs,
        keepContent = false,
        onProgress,
    } = opts;

    const found = await discover(startUrl, {
        limit,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(onProgress ? { onProgress } : {}),
    });

    const excludedPages: TapPage[] = [];
    const targets: string[] = [];
    for (const url of found.urls) {
        if (isExcluded(url, include, exclude)) {
            excludedPages.push({
                url,
                path: docPath(url),
                title: "",
                words: 0,
                tokens: 0,
                thin: false,
                needsJs: false,
                hash: "",
                excluded: true,
            });
        } else {
            targets.push(url);
        }
    }

    const total = targets.length;
    // One shared counter for both phases: the bar the consumer draws must move
    // forward only, whichever worker finished first.
    let done = 0;

    emit(onProgress, { phase: "fetch", event: "start", url: startUrl, done: 0, total });

    const fetched = await mapWithConcurrency(targets, concurrency, async (url) => {
        try {
            const page = await fetchPage(url, {
                ...(timeoutMs === undefined ? {} : { timeoutMs }),
                ...(language === undefined ? {} : { language }),
            });
            const extracted = await extract(page.body, page.finalUrl, {
                ...(language === undefined ? {} : { language }),
            });
            const markdown = extracted.markdown;
            const row: TapPage = {
                url,
                path: docPath(url),
                title: extracted.title,
                words: extracted.wordCount || countWords(markdown),
                tokens: estimateTokens(markdown),
                thin: extracted.thin,
                needsJs: extracted.needsJs,
                hash: contentHash(markdown),
            };
            if (keepContent) row.markdown = markdown;
            done++;
            emit(onProgress, {
                phase: "extract",
                event: "page",
                url,
                path: row.path,
                done,
                total,
            });
            return row;
        } catch (err) {
            const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
            done++;
            emit(onProgress, {
                phase: "fetch",
                event: "error",
                url,
                done,
                total,
                message,
            });
            return {
                url,
                path: docPath(url),
                title: "",
                words: 0,
                tokens: 0,
                thin: false,
                needsJs: false,
                hash: "",
                error: message,
            } satisfies TapPage;
        }
    });

    emit(onProgress, { phase: "extract", event: "done", done, total });

    const pages = [...fetched, ...excludedPages];
    return {
        startUrl,
        source: found.source,
        pages,
        totals: totalsOf(pages),
    };
}

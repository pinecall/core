/**
 * Plain HTTP fetching — the cheap path that covers every server-rendered site.
 *
 * No browser here by design: headless rendering is out of scope for tap, and a
 * page that needs it is reported honestly (`needsJs`) rather than rendered.
 * What this module does owe the site is politeness: an identifying user-agent,
 * a hard per-page timeout, and a refusal to download anything that is not HTML.
 */

import { emit, type FetchedPage, type OnProgress } from "./types.js";
import { VERSION } from "../version.js";

/** The tap identifies itself with the SDK's own version — see src/version.ts. */
export const TAP_VERSION = VERSION;

export const USER_AGENT = `pinecall-tap/${TAP_VERSION} (+https://pinecall.io)`;

/** A page must answer within this, or it is not worth the crawl budget. */
export const DEFAULT_TIMEOUT_MS = 15_000;

export class TapFetchError extends Error {
    readonly url: string;
    readonly status?: number;

    constructor(message: string, info: { url: string; status?: number }) {
        super(message);
        this.name = "TapFetchError";
        this.url = info.url;
        this.status = info.status;
    }
}

export interface FetchPageOptions {
    timeoutMs?: number;
    /** `text/html` enforces the HTML check; use `application/xml` for sitemaps. */
    accept?: string;
    language?: string;
    onProgress?: OnProgress;
    /** Counters to stamp on the emitted events. */
    done?: number;
    total?: number;
}

/**
 * Fetch a URL as text, following redirects, refusing anything that is not HTML.
 * Returns the caching validators too — they are what makes a re-index free.
 */
export async function fetchPage(
    url: string,
    opts: FetchPageOptions = {},
): Promise<FetchedPage> {
    const {
        timeoutMs = DEFAULT_TIMEOUT_MS,
        accept = "text/html",
        language,
        onProgress,
        done = 0,
        total = 1,
    } = opts;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();

    emit(onProgress, { phase: "fetch", event: "start", url, done, total });

    try {
        const res = await fetch(url, {
            redirect: "follow",
            signal: controller.signal,
            headers: {
                "user-agent": USER_AGENT,
                accept: `${accept},*/*;q=0.5`,
                "accept-language": language ? `${language},en;q=0.8` : "en,es;q=0.8",
            },
        });

        if (!res.ok) {
            throw new TapFetchError(`HTTP ${res.status} for ${url}`, {
                url,
                status: res.status,
            });
        }

        const contentType = res.headers.get("content-type") ?? "";
        if (accept === "text/html" && !/text\/html|application\/xhtml/i.test(contentType)) {
            throw new TapFetchError(
                `not HTML (${contentType || "no content-type"}) for ${url}`,
                { url, status: res.status },
            );
        }

        const body = await res.text();
        const page: FetchedPage = {
            url,
            finalUrl: res.url || url,
            status: res.status,
            contentType,
            etag: res.headers.get("etag"),
            lastModified: res.headers.get("last-modified"),
            body,
            bytes: byteLength(body),
            ms: Date.now() - started,
        };

        emit(onProgress, {
            phase: "fetch",
            event: "page",
            url: page.finalUrl,
            done: done + 1,
            total,
        });
        return page;
    } catch (err) {
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        emit(onProgress, { phase: "fetch", event: "error", url, done, total, message });
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/** UTF-8 byte length without depending on Buffer being present. */
export function byteLength(text: string): number {
    return new TextEncoder().encode(text).length;
}

/**
 * Run `fn` over the items with a bounded number of in-flight requests. The cap
 * is the politeness knob: four concurrent requests is a browser's worth of
 * load, not a scrape.
 */
export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const width = Math.max(1, Math.min(limit, items.length));
    const workers = Array.from({ length: width }, async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            results[i] = await fn(items[i]!, i);
        }
    });
    await Promise.all(workers);
    return results;
}

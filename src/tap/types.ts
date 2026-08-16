/**
 * Tap — shared types.
 *
 * `TapProgress` is the seam of the whole chapter: every long-running function
 * takes an `onProgress` and emits these events. `done`/`total` are present on
 * EVERY event (not just `page`) because the consumer draws a bar from them and
 * a bar that only moves on some events stutters.
 */

export type TapPhase =
    | "discover"
    | "fetch"
    | "extract"
    | "push"
    | "delete"
    | "reindex";

export type TapEvent = "start" | "page" | "done" | "error";

export interface TapProgress {
    phase: TapPhase;
    event: TapEvent;
    url?: string;
    path?: string;
    done: number;
    total: number;
    message?: string;
}

export type OnProgress = (ev: TapProgress) => void;

/** Emit helper — tolerates a missing callback and never lets a bad one throw. */
export function emit(onProgress: OnProgress | undefined, ev: TapProgress): void {
    if (!onProgress) return;
    try {
        onProgress(ev);
    } catch {
        /* a progress listener must never break a crawl */
    }
}

/** How the URL list was found. */
export type DiscoverySource = "sitemap" | "links";

export interface DiscoverResult {
    source: DiscoverySource;
    urls: string[];
    /** Disallow rules read from robots.txt for `User-agent: *`. */
    disallow: string[];
    sitemaps: string[];
}

export interface FetchedPage {
    /** The URL as requested. */
    url: string;
    /** Where the redirects landed — this is what extraction resolves against. */
    finalUrl: string;
    status: number;
    contentType: string;
    etag: string | null;
    lastModified: string | null;
    body: string;
    bytes: number;
    ms: number;
}

export interface ExtractedPage {
    url: string;
    title: string;
    description: string;
    author: string;
    published: string;
    site: string;
    language: string;
    wordCount: number;
    extractorType: string;
    markdown: string;
    /** Visible text bytes / HTML bytes, rounded to 4 decimals. */
    textRatio: number;
    /** Fewer than `THIN_CONTENT_WORDS` words — short, not necessarily broken. */
    thin: boolean;
    /** Ratio below `SPA_TEXT_RATIO`: almost certainly a client-rendered shell. */
    needsJs: boolean;
    ms: number;
}

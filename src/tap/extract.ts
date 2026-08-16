/**
 * HTML -> clean Markdown.
 *
 * Defuddle does both halves of the job: it isolates the main content (the
 * Readability role) and standardizes code blocks, math and footnotes before
 * converting — which is exactly where readability+turndown produces garbage.
 *
 * The two thresholds below were calibrated against real sites; see each one.
 */

import { parseHTML } from "linkedom";
import { Defuddle } from "defuddle/node";

import { emit, type ExtractedPage, type OnProgress } from "./types.js";
import { byteLength } from "./fetch.js";

/** A page that yields less than this is short — not necessarily broken. */
export const THIN_CONTENT_WORDS = 120;

/**
 * Visible-text-to-HTML ratio below which the page is almost certainly rendered
 * by JavaScript. Measured: vercel.com 0.0055 and stripe.com/docs/api 0.0065
 * (both client-rendered) against hono.dev 0.023 and bernardocastro.dev 0.195
 * (both server-rendered, one of them genuinely short). Word count alone
 * confuses "short page" with "empty shell"; this ratio separates them.
 */
export const SPA_TEXT_RATIO = 0.012;

/** Ratio of visible text to raw HTML, with script/style/noscript discounted. */
export function textRatio(document: Document, htmlBytes: number): number {
    const body = document.body;
    if (!body) return 0;
    let text = body.textContent ?? "";
    for (const el of document.querySelectorAll("script,style,noscript")) {
        const inner = el.textContent ?? "";
        if (inner) text = text.replace(inner, "");
    }
    return text.replace(/\s+/g, " ").trim().length / Math.max(htmlBytes, 1);
}

export function countWords(text: string): number {
    const m = text.match(/\S+/g);
    return m ? m.length : 0;
}

/** Rough token estimate — good enough to budget an index without a tokenizer. */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

export interface ExtractOptions {
    language?: string;
    removeImages?: boolean;
    onProgress?: OnProgress;
    done?: number;
    total?: number;
}

export async function extract(
    html: string,
    url: string,
    opts: ExtractOptions = {},
): Promise<ExtractedPage> {
    const {
        language,
        removeImages = true,
        onProgress,
        done = 0,
        total = 1,
    } = opts;

    const started = Date.now();
    emit(onProgress, { phase: "extract", event: "start", url, done, total });

    try {
        const { document } = parseHTML(html);
        const ratio = textRatio(document as unknown as Document, byteLength(html));

        const result = await Defuddle(document, url, {
            markdown: true,
            removeImages,
            language,
            // No third-party API calls during extraction: an indexer must not
            // fan out to YouTube/Reddit endpoints on behalf of a visitor.
            useAsync: false,
        });

        const markdown = (result.content ?? "").trim();
        const words = result.wordCount ?? countWords(markdown);

        const page: ExtractedPage = {
            url,
            title: result.title ?? "",
            description: result.description ?? "",
            author: result.author ?? "",
            published: result.published ?? "",
            site: result.site ?? "",
            language: result.language ?? "",
            wordCount: words,
            extractorType: result.extractorType ?? "generic",
            markdown,
            textRatio: Number(ratio.toFixed(4)),
            thin: countWords(markdown) < THIN_CONTENT_WORDS,
            // The only signal that should ever trigger a headless retry — and
            // tap does not do one, it just says so.
            needsJs: ratio < SPA_TEXT_RATIO,
            ms: Date.now() - started,
        };

        emit(onProgress, { phase: "extract", event: "page", url, done: done + 1, total });
        return page;
    } catch (err) {
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        emit(onProgress, { phase: "extract", event: "error", url, done, total, message });
        throw err;
    }
}

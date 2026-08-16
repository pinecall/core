/**
 * Extraction and hashing.
 *
 * Two committed fixtures stand in for the two shapes the crawler meets: a
 * server-rendered article, and a client-rendered shell. The `needsJs`
 * threshold has to separate them without a network call, because that flag is
 * the honest half of the preview — it says "I cannot read this page" instead
 * of pushing an empty document into a knowledge base.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import {
    extract,
    countWords,
    estimateTokens,
    SPA_TEXT_RATIO,
    THIN_CONTENT_WORDS,
} from "../src/tap/extract.js";
import { contentHash } from "../src/tap/hash.js";
import type { TapProgress } from "../src/tap/types.js";

const read = (name: string) =>
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

const ARTICLE = read("tap-article.html");
const SPA = read("tap-spa.html");

describe("extract", () => {
    it("turns a server-rendered article into markdown with its metadata", async () => {
        const page = await extract(ARTICLE, "https://ex.com/tapping-a-pine");

        expect(page.title).toContain("Tapping a pine");
        expect(page.description).toBe("How a knowledge tap turns a website into answers.");
        expect(page.author).toBe("Bernardo Castro");
        expect(page.markdown).toContain("Why markdown");
        expect(page.markdown).toContain("Why the hash");
        expect(page.wordCount).toBeGreaterThan(THIN_CONTENT_WORDS);
        expect(page.thin).toBe(false);
        expect(page.needsJs).toBe(false);
    });

    it("drops the furniture: nav, footer and script bodies do not reach the markdown", async () => {
        const page = await extract(ARTICLE, "https://ex.com/tapping-a-pine");
        expect(page.markdown).not.toContain("__DATA__");
        expect(page.markdown).not.toContain("Copyright Pinecall");
    });

    it("flags a client-rendered shell as needsJs and thin", async () => {
        const page = await extract(SPA, "https://ex.com/console");
        expect(page.textRatio).toBeLessThan(SPA_TEXT_RATIO);
        expect(page.needsJs).toBe(true);
        expect(page.thin).toBe(true);
    });

    it("puts the two fixtures on opposite sides of the threshold", async () => {
        const article = await extract(ARTICLE, "https://ex.com/a");
        const spa = await extract(SPA, "https://ex.com/b");
        expect(article.textRatio).toBeGreaterThan(SPA_TEXT_RATIO);
        expect(spa.textRatio).toBeLessThan(SPA_TEXT_RATIO);
        expect(article.needsJs).toBe(false);
        expect(spa.needsJs).toBe(true);
    });

    it("marks a short but readable page thin without calling it needsJs", async () => {
        const short = `<!doctype html><html><body><article>
            <h1>Contact</h1><p>Write to hello@pinecall.io. We answer on weekdays.</p>
        </article></body></html>`;
        const page = await extract(short, "https://ex.com/contact");
        expect(page.thin).toBe(true);
        expect(page.needsJs).toBe(false);
    });

    it("emits start and page with the counters it was given", async () => {
        const events: TapProgress[] = [];
        await extract(ARTICLE, "https://ex.com/a", {
            onProgress: (ev) => events.push(ev),
            done: 4,
            total: 10,
        });
        expect(events).toEqual([
            { phase: "extract", event: "start", url: "https://ex.com/a", done: 4, total: 10 },
            { phase: "extract", event: "page", url: "https://ex.com/a", done: 5, total: 10 },
        ]);
    });
});

describe("countWords / estimateTokens", () => {
    it("counts non-whitespace runs", () => {
        expect(countWords("")).toBe(0);
        expect(countWords("   ")).toBe(0);
        expect(countWords("one two  three\nfour")).toBe(4);
    });

    it("estimates four characters to a token", () => {
        expect(estimateTokens("")).toBe(0);
        expect(estimateTokens("abcd")).toBe(1);
        expect(estimateTokens("abcde")).toBe(2);
    });
});

describe("contentHash", () => {
    it("is stable, 16 hex characters, and sensitive to any change", () => {
        const a = contentHash("# Title\n\nSome body text.");
        expect(a).toMatch(/^[0-9a-f]{16}$/);
        expect(contentHash("# Title\n\nSome body text.")).toBe(a);
        expect(contentHash("# Title\n\nSome body text!")).not.toBe(a);
        expect(contentHash("")).not.toBe(a);
    });

    it("matches sha256's known prefix", () => {
        // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
        expect(contentHash("abc")).toBe("ba7816bf8f01cfea");
    });

    it("handles non-ASCII the same way twice", () => {
        expect(contentHash("piñón · café")).toBe(contentHash("piñón · café"));
    });

    it("gives the same page the same hash across two extractions", async () => {
        const a = await extract(ARTICLE, "https://ex.com/a");
        const b = await extract(ARTICLE, "https://ex.com/a");
        expect(contentHash(a.markdown)).toBe(contentHash(b.markdown));
    });
});

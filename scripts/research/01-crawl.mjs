/**
 * RESEARCH SPIKE — 01: crawl a site with the real planTap (keepContent) and
 * store the corpus locally, plus raw HTML bytes per page (second, polite fetch)
 * so the baseline can compare HTML → markdown → kept tokens.
 *
 *   node scripts/research/01-crawl.mjs <site-name> <url> [limit]
 */
import { join } from "node:path";
import { planTap } from "../../dist/tap.js";
import { siteDir, writeJson, estimateTokens, countWords } from "./lib.mjs";

const [site, url, limitArg] = process.argv.slice(2);
if (!site || !url) {
    console.error("usage: 01-crawl.mjs <site-name> <url> [limit]");
    process.exit(1);
}
const limit = Number(limitArg) || 60;
const t0 = Date.now();
const plan = await planTap(url, { limit, keepContent: true, concurrency: 4 });
const planMs = Date.now() - t0;

// HTML bytes — planTap does not expose them; one more GET per page, 4 wide.
const pages = plan.pages.filter((p) => !p.excluded && !p.error);
let i = 0;
async function worker() {
    for (;;) {
        const p = pages[i++];
        if (!p) return;
        try {
            const res = await fetch(p.url, {
                headers: { "user-agent": "pinecall-tap-research/0 (+https://pinecall.io)" },
                signal: AbortSignal.timeout(15000),
            });
            const body = await res.text();
            p.htmlBytes = new TextEncoder().encode(body).length;
        } catch {
            p.htmlBytes = null;
        }
        p.mdBytes = new TextEncoder().encode(p.markdown ?? "").length;
        p.words = countWords(p.markdown ?? "");
        p.tokens = estimateTokens(p.markdown ?? "");
    }
}
await Promise.all([worker(), worker(), worker(), worker()]);

const out = {
    site,
    startUrl: url,
    source: plan.source,
    limit,
    crawledAt: new Date().toISOString(),
    planMs,
    totals: plan.totals,
    pages: plan.pages,
};
writeJson(join(siteDir(site), "corpus.json"), out);
const html = pages.reduce((a, p) => a + (p.htmlBytes ?? 0), 0);
const md = pages.reduce((a, p) => a + p.mdBytes, 0);
console.log(
    `${site}: ${plan.totals.included} pages (${plan.totals.failed} failed, ${plan.totals.thin} thin, ${plan.totals.needsJs} needsJs) ` +
        `via ${plan.source} in ${(planMs / 1000).toFixed(1)}s — html ${(html / 1024).toFixed(0)} KB → md ${(md / 1024).toFixed(0)} KB ` +
        `(${plan.totals.words} words, ~${plan.totals.tokens} tokens)`,
);
for (const p of pages) console.log(`  ${String(p.words).padStart(6)} w  ${p.path}  ${p.thin ? "thin" : ""}`);

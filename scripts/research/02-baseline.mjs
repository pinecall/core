/**
 * RESEARCH SPIKE — 02: measure the noise in a crawled corpus. Pure local
 * analysis, no network. Prints a table and writes <site>/baseline.json.
 *
 *   node scripts/research/02-baseline.mjs <site> [<site>…]
 */
import { join } from "node:path";
import {
    loadCorpus, siteDir, writeJson, labelsFor, isJunkLabel, estimateTokens, countWords, pct,
    boilerplateLines, stripBoilerplate, residualHtml, nearDuplicates, junkByUrl, linesOf,
} from "./lib.mjs";

const sites = process.argv.slice(2);
if (!sites.length) { console.error("usage: 02-baseline.mjs <site>…"); process.exit(1); }

const rows = [];
for (const site of sites) {
    const corpus = loadCorpus(site);
    const pages = corpus.pages.filter((p) => !p.excluded && !p.error);
    const labelOf = labelsFor(site);
    const bp = boilerplateLines(pages);
    let tok = 0, bpTok = 0, htmlRes = 0, bpLinesTotal = 0, linesTotal = 0;
    const perPage = [];
    for (const p of pages) {
        const md = p.markdown ?? "";
        const { kept, dropped } = stripBoilerplate(md, bp.lines);
        const t = estimateTokens(md);
        const dt = estimateTokens(dropped.join("\n"));
        tok += t; bpTok += dt;
        linesTotal += linesOf(md).length; bpLinesTotal += dropped.length;
        htmlRes += residualHtml(md);
        perPage.push({
            path: p.path, url: p.url, title: p.title, words: p.words, tokens: t,
            bpTokens: dt, bpShare: t ? Number((dt / t).toFixed(3)) : 0,
            keptWords: countWords(kept), thin: p.thin, needsJs: p.needsJs,
            urlJunk: junkByUrl(p.url), label: labelOf(p.path), text: kept,
        });
    }
    const dups = nearDuplicates(perPage, 0.7);
    const dupPaths = new Set(dups.flatMap((d) => [d.a, d.b]));
    const labeled = perPage.filter((p) => p.label);
    const junkLabeled = labeled.filter((p) => isJunkLabel(p.label));
    const lowLabeled = labeled.filter((p) => p.label === "low");
    const emptyAfter = perPage.filter((p) => p.keptWords < 20).length;
    const thinAfter = perPage.filter((p) => p.keptWords < 120).length;
    const summary = {
        site, startUrl: corpus.startUrl, source: corpus.source,
        pages: pages.length, failed: corpus.totals.failed,
        htmlKB: Math.round(pages.reduce((a, p) => a + (p.htmlBytes ?? 0), 0) / 1024),
        mdKB: Math.round(pages.reduce((a, p) => a + (p.mdBytes ?? 0), 0) / 1024),
        tokens: tok, words: corpus.totals.words,
        bpThresholdPages: bp.threshold, bpLines: bp.lines.size,
        bpTokens: bpTok, bpShare: tok ? Number((bpTok / tok).toFixed(3)) : 0,
        bpLineShare: linesTotal ? Number((bpLinesTotal / linesTotal).toFixed(3)) : 0,
        residualHtmlKB: Number((htmlRes / 1024).toFixed(1)),
        thin: pages.filter((p) => p.thin).length, thinAfterStrip: thinAfter, emptyAfterStrip: emptyAfter,
        needsJs: pages.filter((p) => p.needsJs).length,
        nearDupPairs: dups.length, nearDupPages: dupPaths.size,
        urlJunk: perPage.filter((p) => p.urlJunk).length,
        labeled: labeled.length, junkLabeled: junkLabeled.length, lowLabeled: lowLabeled.length,
        junkShare: labeled.length ? Number((junkLabeled.length / labeled.length).toFixed(3)) : null,
        junkTokens: junkLabeled.reduce((a, p) => a + p.tokens, 0),
        topBoilerplate: [...bp.lines.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
        dups,
    };
    rows.push(summary);
    writeJson(join(siteDir(site), "baseline.json"), { summary, pages: perPage.map(({ text, ...r }) => r) });
}

const cols = ["site", "pages", "htmlKB", "mdKB", "tokens", "bpLines", "bpShare", "residualHtmlKB", "thin", "thinAfterStrip", "emptyAfterStrip", "nearDupPages", "urlJunk", "junkLabeled", "lowLabeled", "junkShare", "junkTokens"];
console.log(cols.join("\t"));
for (const r of rows) console.log(cols.map((c) => r[c] ?? "").join("\t"));
for (const r of rows) {
    console.log(`\n## ${r.site} — top boilerplate lines (pages/${r.pages}, threshold ${r.bpThresholdPages}):`);
    for (const [l, c] of r.topBoilerplate) console.log(`  ${String(c).padStart(3)}  ${l.slice(0, 90)}`);
    if (r.dups.length) console.log(`  near-dups: ${r.dups.map((d) => `${d.a}~${d.b}(${d.sim})`).join(", ")}`);
}

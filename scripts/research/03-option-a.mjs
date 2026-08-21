/**
 * RESEARCH SPIKE — 03: option A, deterministic cleanup — and the "raw" variant
 * (exactly what `tap` pushes today) for the retrieval comparison. No LLM.
 *
 *   node scripts/research/03-option-a.mjs <site>…
 *
 * Rules (each one is a candidate for src/tap, see the report):
 *   1. URL-shape junk (tag/category/author/pagination/auth/legal/search) → drop
 *   2. residual HTML (inline <svg>, <iframe>, stray tags) → stripped
 *   3. cross-page boilerplate: a line or a paragraph that repeats on >= max(3, 10%) pages,
 *      code fences excluded → stripped (nav/footer leftovers, "About the author", banners)
 *   4. empty after strip (< 20 words) → drop:empty; needsJs and < 50 words → drop:shell
 *   5. near-duplicate body (Jaccard of word 4-grams >= 0.7) → keep the shallowest, drop the rest
 *   6. link farm: fewer than 30 words outside links and > 5 links → drop:linkfarm
 *   7. empty title → first heading, else URL slug (deterministic title repair)
 */
import {
    loadCorpus, labelsFor, isJunkLabel, writeVariant, frontmatter, estimateTokens, countWords,
    boilerplateLines, stripBoilerplate, junkByUrl, normLine, shingles, jaccard, linesOf,
} from "./lib.mjs";

const sites = process.argv.slice(2);
if (!sites.length) { console.error("usage: 03-option-a.mjs <site>…"); process.exit(1); }

const RESIDUAL = /<svg[\s\S]*?<\/svg>|<iframe[\s\S]*?<\/iframe>|<\/?(?:div|span|img|picture|source|video|style|script|figure|figcaption|br|hr)\b[^>]*\/?>/gi;

/** Lines outside ``` fences only — code repeats legitimately across docs pages. */
function proseLines(markdown) {
    const out = [];
    let inFence = false;
    for (const raw of markdown.split("\n")) {
        const t = raw.trim();
        if (/^(```|~~~)/.test(t)) { inFence = !inFence; continue; }
        if (!inFence && t) out.push(t);
    }
    return out;
}
/** Paragraphs outside code fences (a fenced block is one paragraph, never matched). */
function paragraphs(markdown) {
    const out = [];
    let inFence = false;
    for (const b of markdown.split(/\n{2,}/)) {
        const t = b.trim();
        if (!t) continue;
        const fences = (t.match(/^(```|~~~)/gm) ?? []).length;
        if (inFence || /^(```|~~~)/.test(t)) { if (fences % 2 === 1) inFence = !inFence; continue; }
        out.push(t);
    }
    return out;
}
function cleanPage(markdown, bpLines, bpParas) {
    let md = markdown.replace(RESIDUAL, "");
    // paragraph-level first (multi-line blocks like a bio), then line-level
    const keptParas = [];
    const droppedParas = [];
    let fence = false;
    for (const p of md.split(/\n{2,}/)) {
        const fences = (p.match(/^(```|~~~)/gm) ?? []).length;
        const inCode = fence || /^\s*(```|~~~)/.test(p);
        if (fences % 2 === 1) fence = !fence;
        const n = inCode ? "" : normLine(p.replace(/\n/g, " "));
        if (n.length >= 40 && bpParas.has(n)) droppedParas.push(p);
        else keptParas.push(p);
    }
    md = keptParas.join("\n\n");
    const kept = [];
    const droppedLines = [];
    let inFence = false;
    for (const raw of md.split("\n")) {
        const t = raw.trim();
        if (/^(```|~~~)/.test(t)) inFence = !inFence;
        const n = inFence ? "" : normLine(t);
        if (n.length >= 12 && bpLines.has(n)) droppedLines.push(raw);
        else kept.push(raw);
    }
    const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return { text, dropped: [...droppedParas, ...droppedLines].join("\n") };
}
function linkStats(md) {
    const links = (md.match(/\]\([^)]*\)/g) ?? []).length;
    const outside = countWords(md.replace(/\[[^\]]*\]\([^)]*\)/g, " "));
    return { links, outside };
}
function titleFor(p, text) {
    if (p.title && p.title.trim()) return p.title.trim();
    const h = text.match(/^#{1,3}\s+(.+)$/m);
    if (h) return h[1].trim();
    try {
        const seg = new URL(p.url).pathname.split("/").filter(Boolean).pop() ?? "";
        return seg.replace(/[-_]+/g, " ").replace(/\.\w+$/, "") || new URL(p.url).hostname;
    } catch { return p.url; }
}
function depth(url) { try { return new URL(url).pathname.split("/").filter(Boolean).length; } catch { return 99; } }

const summary = [];
for (const site of sites) {
    const corpus = loadCorpus(site);
    const pages = corpus.pages.filter((p) => !p.excluded && !p.error);
    const labelOf = labelsFor(site);
    const fetchedAt = corpus.crawledAt;

    // raw variant — what tap pushes today (frontmatter + markdown + the manifest doc)
    const rawDocs = pages.map((p) => ({
        path: p.path, title: p.title,
        text: frontmatter({ url: p.url, title: p.title, hash: p.hash, fetchedAt }) + (p.markdown ?? ""),
    }));
    rawDocs.push({
        path: "_tap-manifest.json", title: "tap manifest",
        text: JSON.stringify({ version: 1, startUrl: corpus.startUrl, source: corpus.source, tappedAt: fetchedAt,
            pages: Object.fromEntries(pages.map((p) => [p.path, { url: p.url, hash: p.hash }])) }, null, 2),
    });
    writeVariant(site, "raw", rawDocs);

    // boilerplate sets at 10% (min 3), prose lines only
    const minPages = Math.max(3, Math.ceil(pages.length * 0.1));
    const lineCount = new Map();
    const paraCount = new Map();
    for (const p of pages) {
        const md = (p.markdown ?? "").replace(RESIDUAL, "");
        for (const l of new Set(proseLines(md).map(normLine).filter((l) => l.length >= 12))) lineCount.set(l, (lineCount.get(l) ?? 0) + 1);
        for (const b of new Set(paragraphs(md).map((b) => normLine(b.replace(/\n/g, " "))).filter((b) => b.length >= 40))) paraCount.set(b, (paraCount.get(b) ?? 0) + 1);
    }
    const bpLines = new Set([...lineCount].filter(([, c]) => c >= minPages).map(([l]) => l));
    const bpParas = new Set([...paraCount].filter(([, c]) => c >= minPages).map(([l]) => l));

    const rows = [];
    for (const p of pages) {
        const md = p.markdown ?? "";
        const residualBytes = (md.match(RESIDUAL) ?? []).reduce((a, m) => a + m.length, 0);
        const { text, dropped } = cleanPage(md, bpLines, bpParas);
        const words = countWords(text);
        const { links, outside } = linkStats(text);
        let decision = "keep";
        let why = null;
        const urlWhy = junkByUrl(p.url);
        if (urlWhy) { decision = "drop"; why = `url:${urlWhy}`; }
        else if (words < 20) { decision = "drop"; why = "empty"; }
        else if (p.needsJs && words < 50) { decision = "drop"; why = "shell"; }
        else if (outside < 30 && links > 5) { decision = "drop"; why = "linkfarm"; }
        rows.push({
            path: p.path, url: p.url, title: titleFor(p, text), origTitle: p.title, hash: p.hash,
            words, tokensBefore: estimateTokens(md), tokensAfter: estimateTokens(text),
            residualBytes, droppedTokens: estimateTokens(dropped), decision, why, text,
            label: labelOf(p.path), depth: depth(p.url), links, outside,
        });
    }
    // near-duplicates among survivors: keep the shallowest (then first), drop the rest
    const alive = rows.filter((r) => r.decision === "keep");
    const sets = new Map(alive.map((r) => [r.path, shingles(r.text)]));
    alive.sort((a, b) => a.depth - b.depth);
    for (let i = 0; i < alive.length; i++) {
        if (alive[i].decision !== "keep") continue;
        for (let j = i + 1; j < alive.length; j++) {
            if (alive[j].decision !== "keep") continue;
            const s = jaccard(sets.get(alive[i].path), sets.get(alive[j].path));
            if (s >= 0.7) { alive[j].decision = "drop"; alive[j].why = `dup:${alive[i].path}(${s.toFixed(2)})`; }
        }
    }

    const kept = rows.filter((r) => r.decision === "keep");
    const docs = kept.map((r) => ({
        path: r.path, title: r.title,
        text: frontmatter({ url: r.url, title: r.title, hash: r.hash, fetchedAt }) + r.text,
    }));
    docs.push(rawDocs[rawDocs.length - 1]); // the manifest travels with every variant
    writeVariant(site, "A", docs, {
        rules: { minPages, bpLines: bpLines.size, bpParas: bpParas.size },
        decisions: rows.map(({ text, ...r }) => r),
    });

    // precision / recall of the drop decision vs the manual labels
    const labeled = rows.filter((r) => r.label);
    const tp = labeled.filter((r) => r.decision === "drop" && isJunkLabel(r.label)).length;
    const fp = labeled.filter((r) => r.decision === "drop" && !isJunkLabel(r.label)).length;
    const fn = labeled.filter((r) => r.decision === "keep" && isJunkLabel(r.label)).length;
    const before = rows.reduce((a, r) => a + r.tokensBefore, 0);
    const after = kept.reduce((a, r) => a + r.tokensAfter, 0);
    const s = {
        site, pages: rows.length, kept: kept.length, dropped: rows.length - kept.length,
        tokensBefore: before, tokensAfter: after, tokenCut: `${((1 - after / before) * 100).toFixed(1)}%`,
        bpLines: bpLines.size, bpParas: bpParas.size, bpTokens: rows.reduce((a, r) => a + r.droppedTokens, 0),
        residualKB: (rows.reduce((a, r) => a + r.residualBytes, 0) / 1024).toFixed(1),
        titlesRepaired: rows.filter((r) => r.title !== r.origTitle).length,
        junkTP: tp, junkFP: fp, junkFN: fn,
        precision: tp + fp ? (tp / (tp + fp)).toFixed(2) : "n/a", recall: tp + fn ? (tp / (tp + fn)).toFixed(2) : "n/a",
    };
    summary.push(s);
    console.log(`\n## ${site}`);
    for (const r of rows.filter((r) => r.decision === "drop")) console.log(`  drop  ${r.path}  (${r.why})  label=${r.label}`);
    for (const r of labeled.filter((r) => r.decision === "keep" && isJunkLabel(r.label))) console.log(`  MISS  ${r.path}  label=${r.label}`);
    if (bpParas.size) console.log(`  boilerplate paragraphs: ${[...bpParas].map((b) => b.slice(0, 60)).join(" | ")}`);
    if (bpLines.size) console.log(`  boilerplate lines: ${[...bpLines].slice(0, 8).map((b) => b.slice(0, 50)).join(" | ")}`);
}
const cols = Object.keys(summary[0]);
console.log("\n" + cols.join("\t"));
for (const s of summary) console.log(cols.map((c) => s[c]).join("\t"));

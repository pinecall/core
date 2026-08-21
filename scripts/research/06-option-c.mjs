/**
 * RESEARCH SPIKE — 06: option C, LLM cleanup of the pages option A kept.
 * Two prompts on the same pages:
 *   clean     — remove leftover boilerplate / formatting noise, keep every fact, do NOT summarize
 *   summarize — rewrite into a compact knowledge doc (more compression, more risk)
 * Fidelity check (no-new-facts): every output sentence must be a near-copy of an
 * input sentence (word 4-gram containment >= 0.6, or a substring after
 * normalisation). Sentences that are not → "violations", listed per page.
 *
 *   node scripts/research/06-option-c.mjs <site>… [--mode=clean|summarize] [--model=haiku] [--max=N pages] [--cap=6000 tokens]
 * Writes variants/<site>/A+C/ (or A+Csum/) docs.json + cleanup.json
 */
import { join } from "node:path";
import {
    readVariant, writeVariant, variantDir, writeJson, llm, logCost, estimateTokens, countWords,
    sentencesOf, shingles, normLine,
} from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).slice(k.length + 3);
const mode = opt("mode", "clean");
const model = opt("model", "haiku");
const maxPages = Number(opt("max", "0")) || Infinity;
const cap = Number(opt("cap", "6000"));
const sites = args.filter((a) => !a.startsWith("--"));
if (!sites.length) { console.error("usage: 06-option-c.mjs <site>… [--mode=clean|summarize]"); process.exit(1); }

const SYSTEM_CLEAN = `You clean web pages that were converted to markdown, for a knowledge base a voice agent answers from.
Rules — follow them literally:
1. Remove ONLY noise: navigation menus, footers, cookie/browser banners, "share"/"subscribe"/CTA buttons, repeated product grids, broken markdown, stray HTML, empty headings, image-only lines, link lists that carry no information.
2. Keep EVERY fact, number, name, price, date, URL that is content. Do NOT summarize, paraphrase, reorder or translate. Keep the original sentences verbatim.
3. Keep headings and code blocks. If the page starts mid-sentence, leave it as is.
4. Output the cleaned markdown only — no preamble, no explanation, no fences around the whole document.`;

const SYSTEM_SUM = `You rewrite web pages into compact knowledge documents for a voice agent's knowledge base.
Write a well-structured markdown document that captures every fact, number, name, price, date and instruction on the page, in plain sentences a voice agent can read aloud. Drop navigation, marketing fluff, repeated blocks and calls to action. Do not invent anything that is not on the page. Output markdown only.`;

function fidelity(input, output) {
    const inSents = sentencesOf(input.replace(/```[\s\S]*?```/g, " "));
    const inNorm = normLine(input);
    const inShingles = shingles(input, 4);
    const outSents = sentencesOf(output.replace(/```[\s\S]*?```/g, " "));
    const violations = [];
    let checked = 0;
    for (const s of outSents) {
        const n = normLine(s);
        if (n.split(" ").length < 5) continue; // headings, labels — not a claim
        checked++;
        if (inNorm.includes(n)) continue;
        const sh = shingles(s, 4);
        let hit = 0;
        for (const x of sh) if (inShingles.has(x)) hit++;
        const containment = sh.size ? hit / sh.size : 1;
        if (containment < 0.6) violations.push({ sentence: s.slice(0, 160), containment: Number(containment.toFixed(2)) });
    }
    return { checked, violations, inSentences: inSents.length, outSentences: outSents.length };
}

for (const site of sites) {
    const A = readVariant(site, "A");
    const variant = mode === "clean" ? "A+C" : "A+Csum";
    const docs = [];
    const rows = [];
    let cost = 0, ms = 0, n = 0;
    for (const d of A.docs) {
        if (d.path === "_tap-manifest.json") { docs.push(d); continue; }
        const m = d.text.match(/^---[\s\S]*?---\n\n/);
        const fm = m ? m[0] : "";
        const body = d.text.slice(fm.length);
        const tokens = estimateTokens(body);
        if (n >= maxPages || tokens > cap || tokens < 40) {
            docs.push(d);
            rows.push({ path: d.path, skipped: tokens > cap ? `over cap (${tokens} tok)` : tokens < 40 ? "tiny" : "max pages", tokensIn: tokens });
            continue;
        }
        n++;
        let res;
        try {
            res = await llm({ system: mode === "clean" ? SYSTEM_CLEAN : SYSTEM_SUM, user: body, model, maxTokens: Math.min(8000, Math.ceil(tokens * 1.3) + 200) });
        } catch (e) { console.error(`  ${d.path}: ${e.message}`); docs.push(d); rows.push({ path: d.path, error: e.message }); continue; }
        cost += res.cost; ms += res.ms;
        logCost({ script: "06-option-c", mode, site, model, path: d.path, usage: res.usage, cost: res.cost, ms: res.ms });
        let out = res.text.trim().replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/m, "$1").trim();
        if (!out) { console.error(`  ${d.path}: empty output, kept original`); docs.push(d); rows.push({ path: d.path, error: "empty output" }); continue; }
        const fid = fidelity(body, out);
        const tokOut = estimateTokens(out);
        rows.push({
            path: d.path, tokensIn: tokens, tokensOut: tokOut, cut: Number((1 - tokOut / tokens).toFixed(3)),
            wordsIn: countWords(body), wordsOut: countWords(out), ms: res.ms, cost: Number(res.cost.toFixed(5)),
            checked: fid.checked, violations: fid.violations.length, samples: fid.violations.slice(0, 3),
        });
        docs.push({ path: d.path, title: d.title, text: fm + out });
        console.log(`  ${site}/${d.path}: ${tokens}→${tokOut} tok (${Math.round((1 - tokOut / tokens) * 100)}% cut), ${fid.violations.length}/${fid.checked} sentences not near-copies, ${res.ms} ms, $${res.cost.toFixed(4)}`);
    }
    const done = rows.filter((r) => r.tokensOut);
    const summary = {
        site, mode, model, pages: done.length, skipped: rows.length - done.length,
        tokensIn: done.reduce((a, r) => a + r.tokensIn, 0), tokensOut: done.reduce((a, r) => a + r.tokensOut, 0),
        sentencesChecked: done.reduce((a, r) => a + r.checked, 0), violations: done.reduce((a, r) => a + r.violations, 0),
        pagesWithViolations: done.filter((r) => r.violations > 0).length,
        costUSD: Number(cost.toFixed(4)), costPerPage: done.length ? Number((cost / done.length).toFixed(5)) : 0, msPerPage: done.length ? Math.round(ms / done.length) : 0,
    };
    summary.tokenCut = summary.tokensIn ? `${((1 - summary.tokensOut / summary.tokensIn) * 100).toFixed(1)}%` : "n/a";
    summary.violationRate = summary.sentencesChecked ? `${((100 * summary.violations) / summary.sentencesChecked).toFixed(1)}%` : "n/a";
    writeVariant(site, variant, docs, { base: "A", mode, model });
    writeJson(join(variantDir(site, variant), "cleanup.json"), { summary, rows });
    console.log(JSON.stringify(summary));
}

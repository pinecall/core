/**
 * RESEARCH SPIKE — 05: option B, LLM page triage. One gateway call per batch of
 * pages: url + title + word count + the first ~200 words → keep / low / drop with
 * a reason and a usefulness score. Compared with the manual labels; cost and
 * latency logged per page.
 *
 *   node scripts/research/05-option-b.mjs <site>… [--model=cheap|haiku|sonnet]   (cheap = the gateway default, the OpenRouter qwen3-30b) [--batch=8]
 */
import { join } from "node:path";
import {
    loadCorpus, labelsFor, isJunkLabel, llm, parseJson, logCost, writeJson, variantDir, countWords, MODEL_ID,
} from "./lib.mjs";

const args = process.argv.slice(2);
const model = (args.find((a) => a.startsWith("--model=")) ?? "--model=cheap").slice(8);
const batch = Number((args.find((a) => a.startsWith("--batch=")) ?? "--batch=8").slice(8)) || 8;
const sites = args.filter((a) => !a.startsWith("--"));
if (!sites.length) { console.error("usage: 05-option-b.mjs <site>… [--model=] [--batch=]"); process.exit(1); }

const SYSTEM = `You triage web pages for a knowledge base that a customer-facing voice/chat agent will answer from.
For EACH page decide:
- "keep": real informative content a user might ask about (products, services, prices, hours, contact, how-to, articles, docs)
- "low": real but weak — an index of links, a stub, a tiny teaser, a testimonials wall
- "drop": useless for answering users — empty or JS-only shell, login/signup/password pages, legal boilerplate (privacy, terms, cookies), newsletter forms, browser-not-supported banners, pure navigation, a duplicate of another listed page
Be conservative: when a page has any substantive facts, "keep".
Reply with ONLY a JSON array, one object per page, same order: {"i": <index>, "verdict": "keep"|"low"|"drop", "kind": "content"|"index"|"legal"|"auth"|"empty"|"duplicate"|"banner"|"other", "score": 0..1, "reason": "<= 12 words"}`;

const summaries = [];
for (const site of sites) {
    const corpus = loadCorpus(site);
    const pages = corpus.pages.filter((p) => !p.excluded && !p.error);
    const labelOf = labelsFor(site);
    const verdicts = new Map();
    let cost = 0, ms = 0, calls = 0, inTok = 0, outTok = 0, parseFails = 0;
    for (let b = 0; b < pages.length; b += batch) {
        const slice = pages.slice(b, b + batch);
        const user = slice.map((p, i) => {
            const words = (p.markdown ?? "").replace(/\s+/g, " ").split(" ").slice(0, 200).join(" ");
            return `[${i}] url: ${p.url}\ntitle: ${p.title || "(none)"}\nwords: ${countWords(p.markdown ?? "")}\ntext: ${words || "(empty)"}`;
        }).join("\n\n");
        let res;
        try {
            res = await llm({ system: SYSTEM, user, model, maxTokens: 80 * slice.length + 100 });
        } catch (e) { console.error(`  llm failed: ${e.message}`); continue; }
        calls++; cost += res.cost; ms += res.ms; inTok += res.usage.input_tokens; outTok += res.usage.output_tokens;
        logCost({ script: "05-option-b", site, model, usage: res.usage, cost: res.cost, ms: res.ms, pages: slice.length });
        let arr;
        try { arr = parseJson(res.text); } catch { parseFails++; continue; }
        for (const v of arr) {
            const p = slice[v.i];
            if (p) verdicts.set(p.path, { verdict: v.verdict, kind: v.kind, score: v.score, reason: v.reason });
        }
    }
    const rows = pages.map((p) => ({ path: p.path, label: labelOf(p.path), ...(verdicts.get(p.path) ?? { verdict: "keep", kind: "unanswered" }) }));
    const labeled = rows.filter((r) => r.label);
    const tp = labeled.filter((r) => r.verdict === "drop" && isJunkLabel(r.label)).length;
    const fp = labeled.filter((r) => r.verdict === "drop" && !isJunkLabel(r.label)).length;
    const fn = labeled.filter((r) => r.verdict !== "drop" && isJunkLabel(r.label)).length;
    const lowAgree = labeled.filter((r) => r.label === "low" && r.verdict !== "keep").length;
    const lowTotal = labeled.filter((r) => r.label === "low").length;
    const s = {
        site, model, modelId: MODEL_ID[model] ?? model, pages: pages.length, calls, parseFails,
        drop: rows.filter((r) => r.verdict === "drop").length, low: rows.filter((r) => r.verdict === "low").length,
        tp, fp, fn, precision: tp + fp ? (tp / (tp + fp)).toFixed(2) : "n/a", recall: tp + fn ? (tp / (tp + fn)).toFixed(2) : "n/a",
        lowCaught: `${lowAgree}/${lowTotal}`,
        costUSD: cost.toFixed(4), costPerPage: (cost / pages.length).toFixed(5), msPerPage: Math.round(ms / pages.length), inTok, outTok,
    };
    summaries.push(s);
    writeJson(join(variantDir(site, `B-${model}`), "triage.json"), { summary: s, rows });
    console.log(`\n## ${site} (${model})`);
    for (const r of rows.filter((r) => r.verdict !== "keep" || isJunkLabel(r.label))) {
        const flag = r.verdict === "drop" && !isJunkLabel(r.label) ? "FP" : r.verdict !== "drop" && isJunkLabel(r.label) ? "FN" : "  ";
        console.log(`  ${flag} ${r.verdict.padEnd(4)} ${String(r.score ?? "").padEnd(4)} ${r.path.padEnd(48)} label=${r.label}  ${r.kind}: ${r.reason ?? ""}`);
    }
}
const cols = Object.keys(summaries[0]);
console.log("\n" + cols.join("\t"));
for (const s of summaries) console.log(cols.map((c) => s[c]).join("\t"));

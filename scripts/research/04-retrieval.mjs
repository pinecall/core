/**
 * RESEARCH SPIKE — 04: the retrieval probe. Pushes one variant of one site into
 * a throw-away dev KB, reindexes, runs the site's questions (top-5), scores the
 * hits, writes variants/<site>/<variant>/retrieval.json and deletes the KB.
 *
 *   node scripts/research/04-retrieval.mjs <site> <variant> [--keep-kb] [--k=5]
 *
 * Scoring per hit: `junk` when the hit's doc is labelled drop:* (manual labels),
 * is the manifest, or carries < 15 words of text once the frontmatter is gone.
 * Per question: answered@k = any hit text matches `expect`; rank = first such hit.
 */
import { join } from "node:path";
import { kb, readVariant, variantDir, writeJson, labelsFor, isJunkLabel, questionsFor, countWords } from "./lib.mjs";

const [site, variant, ...rest] = process.argv.slice(2);
if (!site || !variant) { console.error("usage: 04-retrieval.mjs <site> <variant> [--keep-kb] [--k=5]"); process.exit(1); }
const keepKb = rest.includes("--keep-kb");
const K = Number((rest.find((a) => a.startsWith("--k=")) ?? "--k=5").slice(4)) || 5;

const v = readVariant(site, variant);
const labelOf = labelsFor(site);
const questions = questionsFor(site);
const name = `tap-research-2026-08-21/${site}/${variant}`;
const t0 = Date.now();
const { knowledgeBase } = await kb.create(name, "research spike — safe to delete");
const kbId = knowledgeBase.id;
console.log(`KB ${kbId} ← ${name} (${v.docs.length} docs)`);
let pushed = 0, failed = 0;
for (const d of v.docs) {
    try { await kb.push(kbId, d); pushed++; } catch (e) { failed++; console.error(`  push failed ${d.path}: ${e.message}`); }
}
const pushMs = Date.now() - t0;
await kb.reindex(kbId);
// wait until the index answers (push already triggers a reindex; this is belt and braces)
let ready = false;
const probe = questions[0]?.q ?? "hello";
for (let i = 0; i < 30 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try { ready = (await kb.query(kbId, probe, K)).length > 0; } catch {}
}
const indexMs = Date.now() - t0 - pushMs;

function hitText(h) { return String(h.text ?? "").replace(/^---[\s\S]*?---\s*/m, ""); }
function isJunkHit(h) {
    const p = h.doc_path ?? "";
    if (p === "_tap-manifest.json" || p.endsWith("_tap-manifest.json.md")) return "manifest";
    const lab = labelOf(p.replace(/\.md\.md$/, ".md"));
    if (isJunkLabel(lab)) return lab;
    if (countWords(hitText(h)) < 15) return "thin-chunk";
    return null;
}
const results = [];
for (const q of questions) {
    const hits = await kb.query(kbId, q.q, K);
    const re = new RegExp(q.expect, "i");
    const scored = hits.map((h, i) => ({
        rank: i + 1, score: h.score, doc: h.doc_path, heading: h.heading,
        junk: isJunkHit(h), match: re.test(h.text ?? "") || re.test(h.heading ?? "") || re.test(h.doc_title ?? ""),
        snippet: hitText(h).replace(/\s+/g, " ").slice(0, 140),
    }));
    const first = scored.find((s) => s.match);
    results.push({ q: q.q, list: !!q.list, answered: !!first, rank: first?.rank ?? null, junk: scored.filter((s) => s.junk).length, hits: scored });
}
const nq = results.length;
const summary = {
    site, variant, kbId, docs: v.docs.length, pushed, failed, pushMs, indexMs, k: K,
    questions: nq,
    answered: results.filter((r) => r.answered).length,
    answeredAt1: results.filter((r) => r.rank === 1).length,
    mrr: Number((results.reduce((a, r) => a + (r.rank ? 1 / r.rank : 0), 0) / nq).toFixed(3)),
    junkHits: results.reduce((a, r) => a + r.junk, 0),
    totalHits: results.reduce((a, r) => a + r.hits.length, 0),
    listAnswered: results.filter((r) => r.list && r.answered).length,
    listQuestions: results.filter((r) => r.list).length,
};
writeJson(join(variantDir(site, variant), "retrieval.json"), { summary, results });
console.log(JSON.stringify(summary));
for (const r of results) console.log(`  ${r.answered ? "✓" : "✗"}@${r.rank ?? "-"} junk=${r.junk}/${r.hits.length}  ${r.q}  → ${r.hits.map((h) => h.doc + (h.junk ? "!" : "")).join(", ")}`);
if (!keepKb) { await kb.del(kbId); console.log(`deleted ${kbId}`); }

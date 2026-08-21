/**
 * RESEARCH SPIKE — 07: option D, LLM enrichment for retrieval. Per kept page:
 * a short title, a breadcrumb, 3-5 questions the page answers, and a keyword
 * line — prepended as a header under the frontmatter (BM25 sees the words users
 * actually say; the dense lane sees the questions). Content untouched.
 *
 *   node scripts/research/07-option-d.mjs <site>… [--base=A|A+C] [--model=cheap|haiku]
 * Writes variants/<site>/<base>+D/ (haiku) or <base>+D.<model>/
 */
import { join } from "node:path";
import { readVariant, writeVariant, variantDir, writeJson, llm, parseJson, logCost, estimateTokens, MODEL_ID } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).slice(k.length + 3);
const base = opt("base", "A");
const model = opt("model", "cheap");
const sites = args.filter((a) => !a.startsWith("--"));
if (!sites.length) { console.error("usage: 07-option-d.mjs <site>…"); process.exit(1); }

const SYSTEM = `You index web pages for a voice agent's knowledge base. Given one page (url, title, markdown), return ONLY JSON:
{"title": "<clear descriptive title, <= 80 chars, no site name suffix>",
 "breadcrumb": "<Site > Section > Page, from the URL and content>",
 "summary": "<one sentence, <= 30 words, what this page tells a user>",
 "questions": ["<3 to 5 natural questions a customer would ask that THIS page answers, in the page's language>"],
 "keywords": ["<5 to 12 exact terms, names, product names, numbers, synonyms users would say>"]}
Use only what is on the page. Never invent facts.`;

const SCHEMA = { type: "object", properties: { title: { type: "string" }, breadcrumb: { type: "string" }, summary: { type: "string" }, questions: { type: "array", items: { type: "string" } }, keywords: { type: "array", items: { type: "string" } } }, required: ["title", "questions", "keywords"] };

for (const site of sites) {
    const B = readVariant(site, base);
    const docs = [];
    const rows = [];
    let cost = 0, ms = 0;
    for (const d of B.docs) {
        if (d.path === "_tap-manifest.json") { docs.push(d); continue; }
        const m = d.text.match(/^---[\s\S]*?---\n\n/);
        const fm = m ? m[0] : "";
        const body = d.text.slice(fm.length);
        const url = (fm.match(/^url: (.*)$/m) ?? [])[1] ?? "";
        const excerpt = body.length > 12000 ? body.slice(0, 12000) + "\n…(truncated)" : body;
        let res, j;
        try {
            res = await llm({ system: SYSTEM, user: `url: ${url}\ntitle: ${d.title}\n\n${excerpt}`, model, maxTokens: 400, format: SCHEMA });
            j = parseJson(res.text);
        } catch (e) { console.error(`  ${d.path}: ${e.message}`); docs.push(d); rows.push({ path: d.path, error: e.message }); continue; }
        cost += res.cost; ms += res.ms;
        logCost({ script: "07-option-d", site, model, path: d.path, usage: res.usage, cost: res.cost, ms: res.ms });
        const header =
            `# ${j.title || d.title}\n\n` +
            (j.breadcrumb ? `*${j.breadcrumb}*\n\n` : "") +
            (j.summary ? `${j.summary}\n\n` : "") +
            (j.questions?.length ? `**Questions this page answers:** ${j.questions.join(" · ")}\n\n` : "") +
            (j.keywords?.length ? `**Keywords:** ${j.keywords.join(", ")}\n\n` : "");
        const fm2 = fm.replace(/^title: .*$/m, `title: ${JSON.stringify(j.title || d.title)}`);
        docs.push({ path: d.path, title: j.title || d.title, text: fm2 + header + body });
        rows.push({ path: d.path, oldTitle: d.title, title: j.title, questions: j.questions, keywords: j.keywords, headerTokens: estimateTokens(header), ms: res.ms, cost: Number(res.cost.toFixed(5)), usage: res.usage });
        console.log(`  ${site}/${d.path}: "${j.title}" q=${j.questions?.length} kw=${j.keywords?.length} +${estimateTokens(header)} tok, ${res.ms} ms, $${res.cost.toFixed(4)}`);
    }
    const done = rows.filter((r) => r.title);
    const summary = {
        site, base, model, modelId: MODEL_ID[model] ?? model, pages: done.length, errors: rows.length - done.length,
        headerTokens: done.reduce((a, r) => a + r.headerTokens, 0),
        titlesChanged: done.filter((r) => r.title && r.title !== r.oldTitle).length,
        costUSD: Number(cost.toFixed(4)), costPerPage: done.length ? Number((cost / done.length).toFixed(5)) : 0, msPerPage: done.length ? Math.round(ms / done.length) : 0,
        inTok: done.reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0), outTok: done.reduce((a, r) => a + (r.usage?.output_tokens ?? 0), 0),
    };
    const variant = `${base}+D` + (model === "haiku" ? "" : `.${model}`);
    writeVariant(site, variant, docs, { base, model });
    writeJson(join(variantDir(site, variant), "enrich.json"), { summary, rows });
    console.log(JSON.stringify(summary));
}

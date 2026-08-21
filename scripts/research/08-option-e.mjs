/**
 * RESEARCH SPIKE — 08: option E, site-level overview synthesis. One LLM call
 * per site over the kept pages (title + url + the first ~250 words each, whole
 * page for the shallowest 6) → `_overview.md`, pushed next to the pages. Aimed
 * at the "list everything" questions the chunk retriever misses.
 *
 *   node scripts/research/08-option-e.mjs <site>… [--base=A+D] [--model=haiku|sonnet]
 * Writes variants/<site>/<base>+E/
 */
import { join } from "node:path";
import { readVariant, writeVariant, variantDir, writeJson, llm, logCost, estimateTokens, frontmatter } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).slice(k.length + 3);
const base = opt("base", "A+D");
const model = opt("model", "haiku");
const sites = args.filter((a) => !a.startsWith("--"));
if (!sites.length) { console.error("usage: 08-option-e.mjs <site>…"); process.exit(1); }

const SYSTEM = `You write the overview document of a website for a voice agent's knowledge base. From the page excerpts, write a markdown document with these sections when the site has them: What this is (1-3 sentences) · Products / services / main topics (a complete list, one line each, with prices or key numbers when stated) · Pricing · Contact, hours, locations · How to get started / sign up · Site map (every page: title — one line on what it answers). Use ONLY facts present in the excerpts; when something is not on the site, omit the section. Plain sentences, no marketing tone. Output markdown only.`;

for (const site of sites) {
    const B = readVariant(site, base);
    const pages = B.docs.filter((d) => d.path !== "_tap-manifest.json");
    const depth = (d) => { const u = (d.text.match(/^url: (.*)$/m) ?? [])[1] ?? ""; try { return new URL(u).pathname.split("/").filter(Boolean).length; } catch { return 9; } };
    const sorted = [...pages].sort((a, b) => depth(a) - depth(b));
    const parts = [];
    let budget = 40000 * 4; // ~40k tokens of input, in characters
    sorted.forEach((d, i) => {
        const url = (d.text.match(/^url: (.*)$/m) ?? [])[1] ?? "";
        const body = d.text.replace(/^---[\s\S]*?---\n\n/, "");
        const take = i < 6 ? body.slice(0, 12000) : body.split(/\s+/).slice(0, 250).join(" ");
        const chunk = `## ${d.title}\nurl: ${url}\n${take}\n`;
        if (budget - chunk.length < 0) return;
        budget -= chunk.length;
        parts.push(chunk);
    });
    const user = parts.join("\n");
    const res = await llm({ system: SYSTEM, user, model, maxTokens: 3000 });
    logCost({ script: "08-option-e", site, model, usage: res.usage, cost: res.cost, ms: res.ms });
    const startUrl = (pages[0]?.text.match(/^url: (https?:\/\/[^/\n]+)/m) ?? [])[1] ?? "";
    const text = frontmatter({ url: startUrl, title: "Site overview", hash: "overview", fetchedAt: new Date().toISOString() }) + res.text.trim();
    const docs = [...B.docs, { path: "_overview.md", title: "Site overview", text }];
    writeVariant(site, `${base}+E`, docs, { base, model });
    const summary = { site, base, model, pagesUsed: parts.length, inTok: res.usage.input_tokens, outTok: res.usage.output_tokens, overviewTokens: estimateTokens(res.text), ms: res.ms, costUSD: Number(res.cost.toFixed(4)) };
    writeJson(join(variantDir(site, `${base}+E`), "overview.json"), { summary, overview: res.text });
    console.log(JSON.stringify(summary));
}

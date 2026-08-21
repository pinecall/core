/**
 * RESEARCH SPIKE — shared helpers for scripts/research/*. Not wired into the CLI,
 * not part of the package. Run `npm run build` first: everything imports the
 * built `dist/tap.js`.
 *
 * Corpus layout (under $TAP_RESEARCH_DIR, default ./.research-data, gitignored):
 *   <site>/corpus.json     planTap output with markdown kept (+ html bytes)
 *   <site>/labels.json     manual keep/junk labels per path
 *   <site>/questions.json  realistic user questions for the retrieval probe
 *   <site>/<variant>/      per-option outputs (markdown per page + metrics)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA = process.env.TAP_RESEARCH_DIR ?? join(ROOT, ".research-data");

export function siteDir(site) {
    const d = join(DATA, site);
    mkdirSync(d, { recursive: true });
    return d;
}
export function readJson(p, fallback = undefined) {
    if (!existsSync(p)) {
        if (fallback !== undefined) return fallback;
        throw new Error(`missing ${p}`);
    }
    return JSON.parse(readFileSync(p, "utf8"));
}
export function writeJson(p, v) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(v, null, 2));
}
export function loadCorpus(site) {
    return readJson(join(siteDir(site), "corpus.json"));
}
export function apiKey() {
    if (process.env.PINECALL_API_KEY) return process.env.PINECALL_API_KEY;
    const creds = JSON.parse(readFileSync(join(process.env.HOME, ".pinecall", "credentials"), "utf8"));
    return creds.api_key;
}
export const KB_API = process.env.PINECALL_PLAYGROUND_URL ?? "https://playground.pinecall.io";
export const LLM_API = process.env.PINECALL_VOICE_URL ?? "https://voice.pinecall.io";

export function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
export function countWords(text) {
    const m = text.match(/\S+/g);
    return m ? m.length : 0;
}
export function pct(a, b) {
    return b ? `${((100 * a) / b).toFixed(1)}%` : "n/a";
}
export function fmt(n, d = 1) {
    return typeof n === "number" ? n.toFixed(d) : String(n);
}

// ── Text blocks ─────────────────────────────────────────────────────────
/** Split markdown into blocks (paragraph-ish units) and normalize for shingling. */
export function blocksOf(markdown) {
    return markdown
        .split(/\n{2,}/)
        .map((b) => b.trim())
        .filter(Boolean);
}
export function normBlock(b) {
    return b.toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();
}
/** Sentences of a text (rough, language-agnostic). */
export function sentencesOf(text) {
    return text
        .replace(/\s+/g, " ")
        .split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡"(\[]|\d)/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

// ── LLM gateway ─────────────────────────────────────────────────────────
/** Anthropic list prices (USD per 1M tokens), 2026-08 — used for the cost column. */
export const PRICE = {
    haiku: { in: 1.0, out: 5.0 },
    sonnet: { in: 3.0, out: 15.0 },
};
export function costOf(model, usage) {
    const p = PRICE[model] ?? PRICE.haiku;
    return ((usage.input_tokens ?? 0) * p.in + (usage.output_tokens ?? 0) * p.out) / 1e6;
}

/**
 * One call to Pinecall's LLM gateway (SSE). Returns { text, usage, ms, cost }.
 * `format` (a JSON schema) switches to mode "analysis" — a suggestion to
 * Anthropic, not a constraint, so callers JSON.parse inside try/catch.
 */
export async function llm(opts) {
    // The gateway occasionally answers 200 with an EMPTY stream (no token, no
    // done frame) when Anthropic is overloaded — seen 2026-08-21 with four
    // spikes running in parallel. Treat that as a failure and retry.
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const r = await llmOnce(opts);
            if (r.text.trim() || r.usage.output_tokens > 0) return r;
            lastErr = new Error("empty stream from gateway");
        } catch (e) {
            lastErr = e;
            if (/llm 4\d\d/.test(e.message) && !/429/.test(e.message)) throw e;
        }
        await new Promise((res) => setTimeout(res, 1500 * 2 ** attempt));
    }
    throw lastErr;
}
async function llmOnce({ system, user, model = "haiku", maxTokens = 1024, format, temperature = 0 }) {
    const started = Date.now();
    const body = {
        model,
        system,
        messages: [{ role: "user", content: user }],
        temperature,
        max_tokens: maxTokens,
        ...(format ? { mode: "analysis", format } : {}),
    };
    const res = await fetch(`${LLM_API}/api/llm/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey() },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`llm ${res.status}: ${await res.text()}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let text = "";
    let usage = { input_tokens: 0, output_tokens: 0 };
    let error = null;
    outer: for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of frame.split("\n")) {
                if (!line.startsWith("data: ")) continue;
                const data = line.slice(6);
                if (data === "[DONE]") break outer;
                let evt;
                try { evt = JSON.parse(data); } catch { continue; }
                if (evt.type === "token") text += evt.content;
                else if (evt.type === "done") usage = evt.usage ?? usage;
                else if (evt.type === "error") error = evt.error;
            }
        }
    }
    if (error) throw new Error(`llm upstream: ${error}`);
    return { text, usage, ms: Date.now() - started, cost: costOf(model, usage) };
}

/** Pull the first JSON value out of a model reply (tolerates ``` fences). */
export function parseJson(text) {
    const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try { return JSON.parse(t); } catch {}
    const m = t.match(/[\[{][\s\S]*[\]}]/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    throw new Error(`not JSON: ${text.slice(0, 200)}`);
}

// ── Cost ledger ─────────────────────────────────────────────────────────
const LEDGER = join(DATA, "llm-ledger.jsonl");
export function logCost(entry) {
    mkdirSync(DATA, { recursive: true });
    writeFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { flag: "a" });
}

// ── Knowledge API ───────────────────────────────────────────────────────
async function kbCall(method, path, body) {
    const res = await fetch(`${KB_API}/api/knowledge${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey()}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`knowledge ${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json().catch(() => ({}));
}
export const kb = {
    create: (name, description) => kbCall("POST", "", { name, description }),
    get: (id) => kbCall("GET", `/${id}`),
    del: (id) => kbCall("DELETE", `/${id}`),
    push: (id, doc) => kbCall("POST", `/${id}/docs`, doc),
    rm: (id, docId) => kbCall("DELETE", `/${id}/docs/${docId}`),
    reindex: (id) => kbCall("POST", `/${id}/reindex`),
    query: async (id, query, k = 5) => (await kbCall("POST", `/${id}/query`, { query, k })).hits ?? [],
};

// ── Deterministic noise detectors (option A building blocks) ────────────
/** Lines of a markdown doc, trimmed, with list bullets/heading marks stripped for matching. */
export function linesOf(markdown) {
    return markdown.split("\n").map((l) => l.trim()).filter(Boolean);
}
export function normLine(l) {
    return l
        .replace(/^([-*+]|\d+\.)\s+/, "")
        .replace(/^#+\s+/, "")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .toLowerCase()
        .replace(/[^\p{L}\p{N} ]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}
/**
 * Cross-page boilerplate: a normalized line (>= minChars) that occurs on at
 * least `minPages` pages. Returns Map<normLine, pageCount>.
 */
export function boilerplateLines(pages, { minPages, minChars = 12 } = {}) {
    const n = pages.length;
    const threshold = minPages ?? Math.max(3, Math.ceil(n * 0.2));
    const seen = new Map();
    for (const p of pages) {
        const uniq = new Set(linesOf(p.markdown ?? "").map(normLine).filter((l) => l.length >= minChars));
        for (const l of uniq) seen.set(l, (seen.get(l) ?? 0) + 1);
    }
    const out = new Map();
    for (const [l, c] of seen) if (c >= threshold) out.set(l, c);
    return { lines: out, threshold, pages: n };
}
/** Split a page into {kept, dropped} lines given the boilerplate set. */
export function stripBoilerplate(markdown, bp) {
    const kept = [];
    const dropped = [];
    for (const raw of markdown.split("\n")) {
        const t = raw.trim();
        if (!t) { kept.push(raw); continue; }
        const n = normLine(t);
        if (n.length >= 12 && bp.has(n)) dropped.push(raw);
        else kept.push(raw);
    }
    return { kept: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), dropped };
}
/** Raw HTML that survived extraction (inline svg, iframes, tags). */
export function residualHtml(markdown) {
    let bytes = 0;
    for (const m of markdown.matchAll(/<svg[\s\S]*?<\/svg>|<iframe[\s\S]*?<\/iframe>|<(?:div|span|img|picture|source|video|style|script)\b[^>]*>/gi)) bytes += m[0].length;
    return bytes;
}
/** Word 4-gram shingle set, hashed to 32 bits. */
export function shingles(text, k = 4) {
    const w = normLine(text).split(" ").filter(Boolean);
    const out = new Set();
    for (let i = 0; i + k <= w.length; i++) {
        const s = w.slice(i, i + k).join(" ");
        let h = 2166136261;
        for (let j = 0; j < s.length; j++) { h ^= s.charCodeAt(j); h = Math.imul(h, 16777619); }
        out.add(h >>> 0);
    }
    return out;
}
export function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
}
/** Pairs of pages whose content (after boilerplate strip) overlaps >= threshold. */
export function nearDuplicates(pages, threshold = 0.7) {
    const sets = pages.map((p) => shingles(p.text ?? p.markdown ?? ""));
    const pairs = [];
    for (let i = 0; i < pages.length; i++)
        for (let j = i + 1; j < pages.length; j++) {
            const s = jaccard(sets[i], sets[j]);
            if (s >= threshold) pairs.push({ a: pages[i].path, b: pages[j].path, sim: Number(s.toFixed(3)) });
        }
    return pairs;
}
/** URL-shape heuristics — the patterns that are junk on almost every site. */
export const JUNK_URL = [
    [/\/(tag|tags|etiqueta|etiquetas)\//i, "tag"],
    [/\/(category|categories|categoria|categorias|topics?)\//i, "category"],
    [/\/(author|authors|autor)\//i, "author"],
    [/\/(page|pagina)\/\d+/i, "pagination"],
    [/\/\d{4}\/\d{2}\/?$/i, "date-archive"],
    [/\/(login|signin|sign-in|signup|sign-up|register|account|cart|checkout|wp-admin|wp-login)/i, "auth/cart"],
    [/\/(privacy|privacidad|terms|terminos|legal|cookies?|gdpr|imprint|impressum|aviso-legal|disclaimer)/i, "legal"],
    [/\/(search|buscar|feed|rss|sitemap)/i, "search/feed"],
    [/\/(newsletter|subscribe|unsubscribe)/i, "newsletter"],
    [/[?&](replytocom|share|print)=/i, "query-noise"],
];
export function junkByUrl(url) {
    for (const [re, why] of JUNK_URL) if (re.test(url)) return why;
    return null;
}

// ── Fixtures (committed ground truth) ───────────────────────────────────
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
export function labelsFor(site) {
    const all = readJson(join(FIXTURES, "labels.json"));
    const l = all[site] ?? {};
    return (path) => l[path] ?? l._default ?? null;
}
export function questionsFor(site) {
    return readJson(join(FIXTURES, "questions.json"))[site] ?? [];
}
export const isJunkLabel = (label) => typeof label === "string" && label.startsWith("drop:");

// ── Variants (what would be pushed to the KB) ───────────────────────────
/** Exactly what src/tap/tap.ts#frontmatter stamps on a tapped document. */
export function frontmatter({ url, title, hash, fetchedAt }) {
    return `---\nurl: ${url}\ntitle: ${JSON.stringify(title)}\nhash: ${hash}\nfetchedAt: ${fetchedAt}\n---\n\n`;
}
export function variantDir(site, variant) {
    const d = join(siteDir(site), "variants", variant);
    mkdirSync(d, { recursive: true });
    return d;
}
/** docs: [{path,title,text}] — written as the variant; meta keeps the decisions. */
export function writeVariant(site, variant, docs, meta = {}) {
    const d = variantDir(site, variant);
    writeJson(join(d, "docs.json"), { site, variant, writtenAt: new Date().toISOString(), ...meta, docs });
    return d;
}
export function readVariant(site, variant) {
    return readJson(join(variantDir(site, variant), "docs.json"));
}

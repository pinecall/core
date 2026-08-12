#!/usr/bin/env node
/**
 * Build-time generator for the static model catalog.
 *
 *   node scripts/gen-catalog.mjs   →   src/catalog.generated.ts
 *
 * WHY A GENERATOR, AND WHY STATIC
 * -------------------------------
 * The server has NO endpoint that returns the *config shortcut strings* an
 * agent config uses. `GET {playground}/api/rates/models` is live and
 * authoritative, but it returns BILLING ids (`deepgram-flux`, `stt-rt-v5`) —
 * not `deepgram/flux` / `soniox/realtime`, which is what a caller must type.
 * The only place those strings exist is the reference docs, so the shortcut
 * table is generated from them at build time and stamped with `staleAsOf`.
 *
 * At runtime `list_models` merges in the ONE thing the live table can say
 * without guessing: which providers are managed (provider-level, an exact
 * match on both sides — no fuzzy model-id matching, which would silently
 * mislabel `soniox/realtime` as unpriced).
 *
 * Sources: docs/reference/{llm,stt,tts}-providers.md in this repo.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.join(here, "..", "..", "docs", "reference");
const outFile = path.join(here, "..", "src", "catalog.generated.ts");

const DOCS = {
    llm: "llm-providers.md",
    stt: "stt-providers.md",
    tts: "tts-providers.md",
};

/** The config field each kind is written under in an agent config. */
const FIELD = { llm: "llm", stt: "stt", tts: "voice" };

// ── markdown helpers ────────────────────────────────────────────────────────

/** Split a doc into `## ` sections: [{ title, body }]. */
function sections(md) {
    const out = [];
    let cur = { title: "", body: "" };
    for (const line of md.split("\n")) {
        const m = /^##\s+(.*)$/.exec(line);
        if (m) {
            out.push(cur);
            cur = { title: m[1].trim(), body: "" };
        } else {
            cur.body += line + "\n";
        }
    }
    out.push(cur);
    return out;
}

/** Markdown tables in `md` as blocks: [{ header, rows }] — cells trimmed. */
function tables(md) {
    const out = [];
    let cur = null;
    for (const line of md.split("\n")) {
        if (!/^\s*\|/.test(line)) {
            cur = null;
            continue;
        }
        const cells = line.split("|").slice(1, -1).map((c) => c.trim());
        if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator
        if (cells.length < 2) continue;
        if (!cur) {
            cur = { header: cells, rows: [] };
            out.push(cur);
        } else {
            cur.rows.push(cells);
        }
    }
    return out;
}

/** Every data row of every table, flat. */
function tableRows(md) {
    return tables(md).flatMap((t) => t.rows);
}

const strip = (s) => s.replace(/[`*✅❌]/g, "").trim();

// ── extraction ──────────────────────────────────────────────────────────────

/**
 * Shortcut strings, in doc order, with the trailing `// comment` of the line
 * they were written on. Only literal `field: "value"` forms count — that is
 * exactly what a caller pastes into a config.
 */
function shortcuts(md, field) {
    const re = new RegExp(`\\b${field}\\s*:\\s*"([^"]+)"([^\\n]*)`, "g");
    const found = new Map(); // value → Set(comment)
    for (const line of md.split("\n")) {
        let m;
        while ((m = re.exec(line))) {
            const value = m[1];
            // Skip prose placeholders and legacy `provider:model` examples.
            if (!value || value.includes("...") || value.includes(":")) continue;
            const comment = /\/\/\s*(.+)$/.exec(m[2])?.[1]?.trim();
            if (!found.has(value)) found.set(value, new Set());
            if (comment) found.get(value).add(comment);
        }
    }
    return found;
}

/** provider → { managed, note } from the "Managed vs bring-your-own-key" table. */
function managedTable(md, kind) {
    const sec = sections(md).find((s) => /^Managed vs/i.test(s.title));
    const out = new Map();
    if (!sec) return out;
    for (const cells of tableRows(sec.body)) {
        if (/provider/i.test(cells[0]) && /managed/i.test(cells[1] ?? "")) continue; // header
        // "`deepgram` (flux/nova)" → deepgram ; "`anthropic` (`claude`)" → anthropic + alias
        const first = cells[0];
        const names = [...first.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]);
        if (!names.length) continue;
        const managed = /✅|yes/i.test(cells[1] ?? "");
        const note = strip(cells[2] ?? "");
        out.set(names[0], { managed, aliases: names.slice(1), note, kind });
    }
    return out;
}

/**
 * Free-text notes keyed by a shortcut or a bare model name, harvested from
 * every OTHER table in the doc ("Which to choose", "Model picker").
 */
function rowNotes(md) {
    const out = new Map();
    for (const sec of sections(md)) {
        if (/^Managed vs/i.test(sec.title)) continue;
        for (const { header, rows } of tables(sec.body)) {
        for (const cells of rows) {
            const key = strip(cells[0]);
            if (!key) continue;
            // "Best for: … · Trade-off: …" — a bare cell like "Native (built-in)"
            // means nothing without the column it came from.
            const rest = cells
                .slice(1)
                .map((c, i) => [strip(header[i + 1] ?? ""), strip(c)])
                .filter(([, v]) => v)
                .map(([h, v]) => (h ? `${h}: ${v}` : v))
                .join(" · ");
            if (!rest) continue;
            const prev = out.get(key) ?? [];
            prev.push(rest);
            out.set(key, prev);
        }
        }
    }
    return out;
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Prose sentences of a section, tables and code fences removed. */
function prose(body) {
    return body
        .replace(/```[\s\S]*?```/g, " ")
        .split("\n")
        .filter((l) => !/^\s*\|/.test(l))
        .join("\n")
        .split(/(?<=[.!?])\s+|\n\n/)
        .map((s) => strip(s.replace(/^>\s*/, "").replace(/\s+/g, " ")).trim())
        .filter(Boolean);
}

/**
 * Sentences mentioning languages, taken ONLY from the section that documents
 * this entry — the answer to "can I use it for Arabic?".
 *
 * Scoping is by section TITLE, most specific first: a title naming the model
 * ("Deepgram Flux") wins; otherwise the provider's own section ("Soniox
 * (managed)"). Without that, `deepgram/nova-3` inherits Flux's coverage claim,
 * which is exactly the note that would send someone to the wrong model.
 */
function languageNotes(md, { provider, model }) {
    const token = norm((model ?? provider).split(/[-\/]/)[0]);
    const secs = sections(md).filter((s) => s.title);
    const byModel = secs.filter((s) => norm(s.title).split(" ").includes(token));
    const byProvider = secs.filter((s) => norm(s.title).includes(norm(provider)));
    const own = byModel.length ? byModel : byProvider;

    const hits = [];
    const take = (s) => {
        if (!/languages?\b/i.test(s) || s.length < 20 || s.length > 260) return;
        if (!hits.includes(s)) hits.push(s);
    };
    for (const sec of own) prose(sec.body).forEach(take);
    // Plus the doc's own language-coverage section, but only sentences that
    // name this model/provider.
    for (const sec of secs.filter((s) => /language/i.test(s.title))) {
        for (const s of prose(sec.body)) if (norm(s).includes(token)) take(s);
    }
    return hits.slice(0, 3);
}

// ── per-kind build ──────────────────────────────────────────────────────────

function buildKind(kind, md) {
    const managed = managedTable(md, kind);
    const notes = rowNotes(md);

    const providerOf = (value) => {
        if (!value.includes("/")) return value; // bare, e.g. "transcribe"
        const p = value.split("/")[0];
        for (const [name, info] of managed) {
            if (name === p || info.aliases.includes(p)) return name;
        }
        return p;
    };

    const rows = [];

    if (kind === "tts") {
        // A TTS "model" a caller picks is a VOICE (`provider/alias`); the engine
        // models are per provider. So the rows here are providers, and the
        // voices come from list_voices against the live server.
        for (const [provider, info] of managed) {
            const examples = [...shortcuts(md, FIELD.tts).keys()].filter(
                (v) => providerOf(v) === provider,
            );
            rows.push({
                shortcut: `${provider}/<voice-alias>`,
                provider,
                model: null,
                managed: info.managed,
                examples,
                notes: [info.note, ...(notes.get(provider) ?? []), ...languageNotes(md, { provider, model: null })].filter(
                    Boolean,
                ),
            });
        }
    } else {
        const byShortcut = new Map();
        for (const [value, comments] of shortcuts(md, FIELD[kind])) {
            // A bare model name is only a documented form for STT ("transcribe");
            // for LLM it means "assume OpenAI", which the manual explains instead
            // of listing a second row for the same model.
            if (kind === "llm" && !value.includes("/")) continue;

            const provider = providerOf(value);
            const model = value.includes("/") ? value.split("/").slice(1).join("/") : value;
            // Alias providers (`claude/…`, `gemini/…`) fold into the canonical row.
            const shortcut = value.includes("/") ? `${provider}/${model}` : value;
            const info = managed.get(provider);

            const row = byShortcut.get(shortcut) ?? {
                shortcut,
                provider,
                model,
                managed: info ? info.managed : null,
                aliasForms: [],
                examples: [],
                notes: [],
            };
            if (value !== shortcut && !row.aliasForms.includes(value)) row.aliasForms.push(value);
            row.notes.push(
                ...comments,
                ...(notes.get(value) ?? []),
                ...(notes.get(shortcut) ?? []),
                ...(notes.get(model) ?? []),
                info?.note,
                ...languageNotes(md, { provider, model }),
            );
            byShortcut.set(shortcut, row);
        }
        rows.push(...byShortcut.values());
    }

    // Deduplicate notes, keep doc order.
    for (const r of rows) {
        r.aliasForms ??= [];
        r.notes = [...new Set(r.notes.filter(Boolean))].slice(0, 6);
    }

    const providers = [...managed].map(([name, info]) => ({
        name,
        aliases: info.aliases,
        managed: info.managed,
        note: info.note || null,
    }));

    return { rows, providers };
}

// ── emit ────────────────────────────────────────────────────────────────────

const kinds = {};
const hash = createHash("sha256");
for (const [kind, file] of Object.entries(DOCS)) {
    const md = readFileSync(path.join(docsDir, file), "utf8");
    hash.update(md);
    const { rows, providers } = buildKind(kind, md);
    kinds[kind] = { source: `docs/reference/${file}`, field: FIELD[kind], models: rows, providers };
}

const catalog = {
    staleAsOf: new Date().toISOString().slice(0, 10),
    docsSha: hash.digest("hex").slice(0, 12),
    kinds,
};

const banner = `/**
 * GENERATED FILE — do not edit. \`npm run gen:catalog\` in mcp/ rewrites it.
 *
 * Source: docs/reference/{llm,stt,tts}-providers.md at docsSha ${catalog.docsSha}.
 * See scripts/gen-catalog.mjs for why this is static and what stays live.
 */

export interface CatalogModel {
    /** The EXACT string an agent config uses, e.g. "deepgram/flux". */
    shortcut: string;
    provider: string;
    model: string | null;
    /** From the docs table; \`list_models\` overrides it with the live rate table. */
    managed: boolean | null;
    /** Equivalent spellings of the same model, e.g. "claude/claude-sonnet-4-6". */
    aliasForms: string[];
    /** For TTS providers: documented example voice strings. */
    examples: string[];
    notes: string[];
}

export interface CatalogProvider {
    name: string;
    aliases: string[];
    managed: boolean;
    note: string | null;
}

export interface CatalogKind {
    source: string;
    /** The agent-config field this kind is written under. */
    field: string;
    models: CatalogModel[];
    providers: CatalogProvider[];
}

export interface Catalog {
    /** Date the table was generated from the docs (YYYY-MM-DD). */
    staleAsOf: string;
    docsSha: string;
    kinds: Record<"llm" | "stt" | "tts", CatalogKind>;
}

export const CATALOG: Catalog = `;

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, banner + JSON.stringify(catalog, null, 4) + ";\n");

const counts = Object.entries(kinds)
    .map(([k, v]) => `${k}=${v.models.length}`)
    .join(" ");
console.log(`wrote ${path.relative(process.cwd(), outFile)} (${counts}, docsSha ${catalog.docsSha})`);

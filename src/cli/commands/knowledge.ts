/**
 * CLI — `pinecall knowledge`
 *
 * Knowledge base (RAG) management. Knowledge bases are a PAID feature.
 *   pinecall knowledge                       List knowledge bases
 *   pinecall knowledge create <name> [--description="..."]
 *   pinecall knowledge docs <kbId>           List documents in a KB
 *   pinecall knowledge push <kbId> <files…>  Upload local docs (.md/.txt)
 *   pinecall knowledge get <kbId> <docId>    Print a document's text
 *   pinecall knowledge query [kbId] "<q>"   Semantic search (no LLM; kbId optional if single KB)
 *   pinecall knowledge reindex <kbId>        Re-train (rebuild) the index
 *   pinecall knowledge rm <kbId> <docId>     Delete a document
 *   pinecall knowledge delete <kbId>         Delete a knowledge base
 */

import { basename } from "node:path";
import { readFileSync } from "node:fs";
import type { CliConfig } from "../config.js";
import { c, table, info, error, section, kv } from "../ui.js";

// ── Playground API helper (KB lives on the management API) ───────────────

async function pg(config: CliConfig, path: string, init?: RequestInit): Promise<any> {
    const url = `${config.playground}/api${path}`;
    let res: Response;
    try {
        res = await fetch(url, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.apiKey}`,
                ...(init?.headers || {}),
            },
        });
    } catch {
        error(`Cannot reach Playground at ${config.playground}`);
    }
    if (res!.status === 402) {
        error(
            `Knowledge bases are a paid feature.\n` +
            `  Upgrade to Starter or higher at ${c.cyan("https://platform.pinecall.io/billing")}`
        );
    }
    if (!res!.ok) {
        const body = await res!.text();
        error(`Playground ${res!.status}: ${body}`);
    }
    return res!.json();
}

function flag(args: string[], name: string): string | undefined {
    const pre = `--${name}=`;
    const hit = args.find((a) => a.startsWith(pre));
    return hit ? hit.slice(pre.length) : undefined;
}

// ── List KBs ─────────────────────────────────────────────────────────────

async function list(config: CliConfig): Promise<void> {
    const data = await pg(config, "/knowledge");
    const kbs = data.knowledgeBases ?? [];
    if (config.json) { console.log(JSON.stringify(kbs, null, 2)); return; }
    if (!kbs.length) {
        info("No knowledge bases yet. Create one: " + c.cyan('pinecall knowledge create "My docs"'));
        return;
    }
    section("Knowledge bases", kbs.length);
    table(
        ["ID", "NAME", "DOCS", "STATUS"],
        kbs.map((k: any) => [c.dim(k.id), k.name, String(k.docCount ?? 0), statusBadge(k.status)])
    );
}

function statusBadge(s?: string): string {
    if (s === "ready" || s === "indexed") return c.green(s);
    if (s === "indexing" || s === "pending") return c.yellow(s);
    return c.dim(s || "empty");
}

// ── Create ───────────────────────────────────────────────────────────────

async function create(config: CliConfig, name: string, description?: string): Promise<void> {
    if (!name) error('Usage: pinecall knowledge create "<name>" [--description="..."]');
    const data = await pg(config, "/knowledge", {
        method: "POST",
        body: JSON.stringify({ name, description }),
    });
    const kb = data.knowledgeBase;
    if (config.json) { console.log(JSON.stringify(kb, null, 2)); return; }
    info(`${c.green("✓")} Created knowledge base ${c.bold(kb.name)}`);
    kv("id", kb.id);
    info(`Attach it to an agent: ${c.cyan(`knowledgeBase: "${kb.id}"`)}`);
}

// ── Docs ─────────────────────────────────────────────────────────────────

async function docs(config: CliConfig, kbId: string): Promise<void> {
    if (!kbId) error("Usage: pinecall knowledge docs <kbId>");
    const data = await pg(config, `/knowledge/${kbId}`);
    const list = data.docs ?? [];
    if (config.json) { console.log(JSON.stringify(list, null, 2)); return; }
    section(`Documents · ${data.knowledgeBase?.name ?? kbId}`, list.length);
    if (!list.length) { info("No documents. Add some: " + c.cyan(`pinecall knowledge push ${kbId} ./docs/*.md`)); return; }
    table(
        ["ID", "TITLE", "PATH", "SIZE"],
        list.map((d: any) => [c.dim(d.id), d.title || "—", d.path, fmtBytes(d.bytes)])
    );
}

function fmtBytes(n?: number): string {
    const b = Number(n) || 0;
    return b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KB`;
}

// ── Push (upload local files) ──────────────────────────────────────────────

async function push(config: CliConfig, kbId: string, files: string[]): Promise<void> {
    if (!kbId || !files.length) error("Usage: pinecall knowledge push <kbId> <file> [file…]");
    let ok = 0;
    for (const file of files) {
        let text: string;
        try {
            text = readFileSync(file, "utf8");
        } catch {
            info(`${c.red("✗")} ${file} ${c.dim("(cannot read)")}`);
            continue;
        }
        // Keep the relative path (so re-pushing updates the same doc via the
        // server's path-based upsert); title is the bare filename.
        const path = file.replace(/^\.\//, "");
        const title = basename(file).replace(/\.[^.]+$/, "");
        try {
            await pg(config, `/knowledge/${kbId}/docs`, {
                method: "POST",
                body: JSON.stringify({ path, title, text }),
            });
            ok++;
            info(`${c.green("✓")} ${path} ${c.dim(fmtBytes(text.length))}`);
        } catch {
            info(`${c.red("✗")} ${path} ${c.dim("(upload failed)")}`);
        }
    }
    if (config.json) { console.log(JSON.stringify({ uploaded: ok, total: files.length }, null, 2)); return; }
    info(`${c.green("✓")} Uploaded ${ok}/${files.length} document(s). ${c.dim("Index rebuilds automatically.")}`);
}

// ── Get one doc's text ─────────────────────────────────────────────────────

async function get(config: CliConfig, kbId: string, docId: string): Promise<void> {
    if (!kbId || !docId) error("Usage: pinecall knowledge get <kbId> <docId>");
    const data = await pg(config, `/knowledge/${kbId}/docs/${docId}`);
    if (config.json) { console.log(JSON.stringify(data.doc, null, 2)); return; }
    console.log(data.doc?.text ?? "");
}

// ── Query (retrieval-only, no LLM) ─────────────────────────────────────────

// A Mongo ObjectId (kbId) is 24 hex chars — used to tell a kbId apart from
// question text when the kbId is omitted.
function looksLikeKbId(s?: string): boolean {
    return !!s && /^[a-f0-9]{24}$/i.test(s);
}

// Resolve the kbId to operate on: when omitted, auto-pick the org's only KB.
async function resolveSingleKb(config: CliConfig): Promise<string> {
    const data = await pg(config, "/knowledge");
    const kbs = data.knowledgeBases ?? [];
    if (kbs.length === 1) return kbs[0].id;
    if (!kbs.length) error("No knowledge bases yet. Create one: " + c.cyan('pinecall knowledge create "<name>"'));
    error(
        `You have ${kbs.length} knowledge bases — specify one by id:\n` +
        kbs.map((k: any) => `    ${c.dim(k.id)}  ${k.name}`).join("\n"),
    );
    return ""; // unreachable (error exits)
}

async function query(config: CliConfig, args: string[]): Promise<void> {
    // `query [kbId] "<question>"` — kbId optional when the org has a single KB.
    let kbId: string;
    let terms: string[];
    if (looksLikeKbId(args[0])) { kbId = args[0]; terms = args.slice(1); }
    else { kbId = await resolveSingleKb(config); terms = args; }
    const q = terms.join(" ").trim();
    if (!q) error('Usage: pinecall knowledge query [kbId] "<question>"');
    const k = Number(flag(process.argv.slice(2), "k")) || 6;
    const data = await pg(config, `/knowledge/${kbId}/query`, {
        method: "POST",
        body: JSON.stringify({ query: q, k }),
    });
    const hits = data.hits ?? [];
    if (config.json) { console.log(JSON.stringify(hits, null, 2)); return; }
    section(`Matches for "${q}"`, hits.length);
    if (!hits.length) { info("No matches."); return; }
    for (const h of hits) {
        const score = c.dim(`${(h.score ?? 0).toFixed(3)}`);
        const where = [h.doc_title, h.heading].filter(Boolean).join(" › ");
        console.log(`  ${score}  ${c.bold(where || h.doc_path)}`);
        const snippet = String(h.text || "").replace(/\s+/g, " ").trim().slice(0, 160);
        if (snippet) console.log(`         ${c.dim(snippet)}…`);
    }
}

// ── Reindex (re-train) ─────────────────────────────────────────────────────

async function reindex(config: CliConfig, kbId: string): Promise<void> {
    if (!kbId) error("Usage: pinecall knowledge reindex <kbId>");
    info(`${c.dim("⟳")} Re-training the index…`);
    await pg(config, `/knowledge/${kbId}/reindex`, { method: "POST" });
    info(`${c.green("✓")} Re-index triggered. The voice server rebuilds embeddings in the background.`);
}

// ── Delete doc / KB ────────────────────────────────────────────────────────

async function rmDoc(config: CliConfig, kbId: string, docId: string): Promise<void> {
    if (!kbId || !docId) error("Usage: pinecall knowledge rm <kbId> <docId>");
    await pg(config, `/knowledge/${kbId}/docs/${docId}`, { method: "DELETE" });
    info(`${c.green("✓")} Removed document ${c.dim(docId)}`);
}

async function deleteKb(config: CliConfig, kbId: string): Promise<void> {
    if (!kbId) error("Usage: pinecall knowledge delete <kbId>");
    await pg(config, `/knowledge/${kbId}`, { method: "DELETE" });
    info(`${c.green("✓")} Deleted knowledge base ${c.dim(kbId)}`);
}

// ── Help ───────────────────────────────────────────────────────────────────

const HELP = `
  ${c.purple("⚡")} ${c.bold("pinecall knowledge")} — Knowledge bases (RAG) ${c.dim("· paid feature")}

  ${c.bold("Commands:")}
    ${c.dim("(none)")}                          List knowledge bases
    create "<name>" [--description=…]   Create a knowledge base
    docs <kbId>                         List documents in a KB
    push <kbId> <files…>               Upload local docs (.md, .txt)
    get <kbId> <docId>                  Print a document's text
    query [kbId] "<question>"          Semantic search — top chunks, no LLM
                                        ${c.dim("(kbId optional if you have one KB)")}
    reindex <kbId>                      Re-train (rebuild) the index
    rm <kbId> <docId>                   Delete a document
    delete <kbId>                       Delete a knowledge base

  ${c.bold("Examples:")}
    ${c.dim("$")} pinecall knowledge create "Product docs"
    ${c.dim("$")} pinecall knowledge push kb_123 ./docs/*.md
    ${c.dim("$")} pinecall knowledge reindex kb_123

  Attach a KB to an agent with ${c.cyan('knowledgeBase: "kb_…"')} and place
  ${c.cyan("{{RAG_CONTEXT}}")} in the prompt (or leave it out to auto-inject).
`;

// ── Entry ────────────────────────────────────────────────────────────────

export async function knowledgeCommand(config: CliConfig, argv: string[]): Promise<void> {
    if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return; }
    const positional = argv.filter((a) => !a.startsWith("-") && a !== "knowledge");
    const sub = positional[0];

    switch (sub) {
        case undefined:
        case "list":
            return list(config);
        case "create":
            return create(config, positional[1], flag(argv, "description"));
        case "docs":
            return docs(config, positional[1]);
        case "push":
            return push(config, positional[1], positional.slice(2));
        case "get":
            return get(config, positional[1], positional[2]);
        case "query":
        case "search":
            return query(config, positional.slice(1));
        case "reindex":
        case "retrain":
            return reindex(config, positional[1]);
        case "rm":
            return rmDoc(config, positional[1], positional[2]);
        case "delete":
            return deleteKb(config, positional[1]);
        default:
            error(`Unknown subcommand: ${sub}\nRun ${c.cyan("pinecall knowledge --help")}`);
    }
}

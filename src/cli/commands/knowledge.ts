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
import {
    KnowledgeApiError,
    createKnowledgeBase,
    deleteDoc,
    deleteKnowledgeBase,
    getDoc,
    getKnowledgeBase,
    listKnowledgeBases,
    pushDoc,
    queryKnowledge,
    reindexKnowledge,
    type KnowledgeApiOptions,
} from "../../api/knowledge.js";

// ── The public client, wired to this CLI invocation ──────────────────────

function api(config: CliConfig): KnowledgeApiOptions {
    return { apiKey: config.apiKey, playgroundUrl: config.playground };
}

/**
 * Turn a thrown KnowledgeApiError back into the exact message this command
 * has always printed. The client is typed so a library consumer can branch on
 * `code`; the CLI is the layer that formats — including the 402 upgrade text.
 */
function fail(config: CliConfig, err: unknown): never {
    if (err instanceof KnowledgeApiError) {
        if (err.code === "UPGRADE_REQUIRED") {
            error(
                `Knowledge bases are a paid feature.\n` +
                `  Upgrade to Starter or higher at ${c.cyan("https://platform.pinecall.io/billing")}`
            );
        }
        if (err.code === "NETWORK_ERROR") {
            error(`Cannot reach Playground at ${config.playground}`);
        }
        // "knowledge GET /kb: 404 <body>" → the body the old helper printed.
        const body = err.message.replace(/^.*?: \d+ ?/, "");
        error(`Playground ${err.status}: ${body}`);
    }
    throw err;
}

/** Run one client call, mapping any failure to the CLI's own exit path. */
async function run<T>(config: CliConfig, fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        return fail(config, err);
    }
}

function flag(args: string[], name: string): string | undefined {
    const pre = `--${name}=`;
    const hit = args.find((a) => a.startsWith(pre));
    return hit ? hit.slice(pre.length) : undefined;
}

// ── List KBs ─────────────────────────────────────────────────────────────

async function list(config: CliConfig): Promise<void> {
    const kbs = await run(config, () => listKnowledgeBases(api(config)));
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
    const kb = await run(config, () => createKnowledgeBase(api(config), name, description));
    if (config.json) { console.log(JSON.stringify(kb, null, 2)); return; }
    info(`${c.green("✓")} Created knowledge base ${c.bold(kb.name)}`);
    kv("id", kb.id);
    info(`Attach it to an agent: ${c.cyan(`knowledgeBase: "${kb.id}"`)}`);
}

// ── Docs ─────────────────────────────────────────────────────────────────

async function docs(config: CliConfig, kbId: string): Promise<void> {
    if (!kbId) error("Usage: pinecall knowledge docs <kbId>");
    const data = await run(config, () => getKnowledgeBase(api(config), kbId));
    const list = data.docs;
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
            await pushDoc(api(config), kbId, { path, title, text });
            ok++;
            info(`${c.green("✓")} ${path} ${c.dim(fmtBytes(text.length))}`);
        } catch (err) {
            // An API failure aborted the whole push before this refactor (the
            // transport exited the process), so it still does — otherwise a 402
            // would be reported once per file as a plain "upload failed".
            if (err instanceof KnowledgeApiError) fail(config, err);
            info(`${c.red("✗")} ${path} ${c.dim("(upload failed)")}`);
        }
    }
    if (config.json) { console.log(JSON.stringify({ uploaded: ok, total: files.length }, null, 2)); return; }
    info(`${c.green("✓")} Uploaded ${ok}/${files.length} document(s). ${c.dim("Index rebuilds automatically.")}`);
}

// ── Get one doc's text ─────────────────────────────────────────────────────

async function get(config: CliConfig, kbId: string, docId: string): Promise<void> {
    if (!kbId || !docId) error("Usage: pinecall knowledge get <kbId> <docId>");
    const doc = await run(config, () => getDoc(api(config), kbId, docId));
    if (config.json) { console.log(JSON.stringify(doc, null, 2)); return; }
    console.log(doc?.text ?? "");
}

// ── Query (retrieval-only, no LLM) ─────────────────────────────────────────

// A Mongo ObjectId (kbId) is 24 hex chars — used to tell a kbId apart from
// question text when the kbId is omitted.
function looksLikeKbId(s?: string): boolean {
    return !!s && /^[a-f0-9]{24}$/i.test(s);
}

// Resolve the kbId to operate on: when omitted, auto-pick the org's only KB.
async function resolveSingleKb(config: CliConfig): Promise<string> {
    const kbs = await run(config, () => listKnowledgeBases(api(config)));
    if (kbs.length === 1) return kbs[0]!.id;
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
    const hits = await run(config, () => queryKnowledge(api(config), kbId, q, { k }));
    if (config.json) { console.log(JSON.stringify(hits, null, 2)); return; }
    section(`Matches for "${q}"`, hits.length);
    if (!hits.length) { info("No matches."); return; }
    for (const h of hits) {
        const score = c.dim(`${(h.score ?? 0).toFixed(3)}`);
        const where = [h.doc_title, h.heading].filter(Boolean).join(" › ");
        console.log(`  ${score}  ${c.bold(where || String(h.doc_path))}`);
        const snippet = String(h.text || "").replace(/\s+/g, " ").trim().slice(0, 160);
        if (snippet) console.log(`         ${c.dim(snippet)}…`);
    }
}

// ── Reindex (re-train) ─────────────────────────────────────────────────────

async function reindex(config: CliConfig, kbId: string): Promise<void> {
    if (!kbId) error("Usage: pinecall knowledge reindex <kbId>");
    info(`${c.dim("⟳")} Re-training the index…`);
    await run(config, () => reindexKnowledge(api(config), kbId));
    info(`${c.green("✓")} Re-index triggered. The voice server rebuilds embeddings in the background.`);
}

// ── Delete doc / KB ────────────────────────────────────────────────────────

async function rmDoc(config: CliConfig, kbId: string, docId: string): Promise<void> {
    if (!kbId || !docId) error("Usage: pinecall knowledge rm <kbId> <docId>");
    await run(config, () => deleteDoc(api(config), kbId, docId));
    info(`${c.green("✓")} Removed document ${c.dim(docId)}`);
}

async function deleteKb(config: CliConfig, kbId: string): Promise<void> {
    if (!kbId) error("Usage: pinecall knowledge delete <kbId>");
    await run(config, () => deleteKnowledgeBase(api(config), kbId));
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

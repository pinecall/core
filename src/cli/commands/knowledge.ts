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
 *   pinecall knowledge tap <url> [kbId]      Crawl a website into a KB
 *   pinecall knowledge sync <kbId>           Re-tap a KB from its manifest
 */

import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
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
import { planTap, type TapPlan, type TapPage, type TapPlanTotals } from "../../tap/plan.js";
import { tap as tapPlan, syncTap, TapSyncError, type TapReport } from "../../tap/tap.js";
import type { TapProgress } from "../../tap/types.js";

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

// ── Tap: preview table ─────────────────────────────────────────────────────

/**
 * One table row per planned page.
 *
 * Badges are additive and deliberately terse: a page can be both thin and a
 * client-rendered shell, and a preview a human scans must say so on one line.
 * `✗` wins alone — a page that failed to fetch has no other property worth
 * reporting.
 */
export function planRows(plan: TapPlan): string[][] {
    return plan.pages.map((p: TapPage) => {
        let badges: string;
        if (p.error) badges = c.red("✗ " + p.error.slice(0, 40));
        else if (p.excluded) badges = c.dim("EXCL");
        else {
            const parts: string[] = [];
            if (p.thin) parts.push(c.yellow("THIN"));
            if (p.needsJs) parts.push(c.yellow("JS!"));
            badges = parts.join(" ");
        }
        return [c.dim(p.path), p.excluded || p.error ? c.dim("—") : String(p.words), badges];
    });
}

/** The one-line summary under the preview table. */
export function totalsLine(t: TapPlanTotals): string {
    const bits = [
        `${t.included} to index`,
        `${t.words.toLocaleString("en-US")} words`,
        `~${t.tokens.toLocaleString("en-US")} tokens`,
    ];
    if (t.thin) bits.push(`${t.thin} thin`);
    if (t.needsJs) bits.push(`${t.needsJs} need JS`);
    if (t.excluded) bits.push(`${t.excluded} excluded`);
    if (t.failed) bits.push(c.red(`${t.failed} failed`));
    return bits.join(c.dim(" · "));
}

// ── Tap: progress rendering ────────────────────────────────────────────────

export interface ProgressSink {
    write: (s: string) => void;
    /** A whole line, for the non-TTY path. */
    line: (s: string) => void;
}

/**
 * Render TapProgress events.
 *
 * On a TTY the bar is one line rewritten with `\r`. Piped (or under --json) it
 * degrades to one line per PHASE change, never per page: a hundred-page crawl
 * redirected to a log must not write a hundred lines of bar.
 */
export function progressRenderer(tty: boolean, sink: ProgressSink): {
    on: (ev: TapProgress) => void;
    end: () => void;
} {
    let lastPhase = "";
    let width = 0;
    return {
        on(ev: TapProgress) {
            if (!tty) {
                if (ev.phase !== lastPhase && ev.event !== "error") {
                    lastPhase = ev.phase;
                    sink.line(`  ${ev.phase}… ${ev.done}/${ev.total}`);
                }
                if (ev.event === "error") sink.line(`  ✗ ${ev.path ?? ev.url ?? ""} ${ev.message ?? ""}`);
                return;
            }
            const total = ev.total || 0;
            const done = Math.min(ev.done, total || ev.done);
            const frac = total ? done / total : 0;
            const cells = 24;
            const filled = Math.round(frac * cells);
            const bar = "█".repeat(filled) + "░".repeat(Math.max(0, cells - filled));
            const where = (ev.path || ev.url || "").slice(-40);
            const line = `  ${c.cyan(bar)} ${done}/${total || "?"} ${c.bold(ev.phase)} ${c.dim(where)}`;
            width = Math.max(width, line.length);
            sink.write("\r" + line.padEnd(width) );
        },
        end() {
            if (tty) sink.write("\r" + " ".repeat(width) + "\r");
            lastPhase = "";
        },
    };
}

function stdoutSink(): ProgressSink {
    return {
        write: (s) => process.stdout.write(s),
        line: (s) => console.log(s),
    };
}

// ── Tap: input ─────────────────────────────────────────────────────────────

function regexes(raw?: string): RegExp[] | undefined {
    if (!raw) return undefined;
    return raw.split(",").map((r) => new RegExp(r.trim()));
}

/** Ask on stdin. Anything that is not y/yes is a no — the default is refuse. */
export async function confirm(question: string): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer: string = await new Promise((resolve) => rl.question(`  ${question} `, resolve));
        return /^y(es)?$/i.test(answer.trim());
    } finally {
        rl.close();
    }
}

/** The report summary both verbs finish with. */
function printReport(report: TapReport): void {
    section("Result");
    kv("pushed", String(report.pushed));
    kv("updated", String(report.updated));
    kv("skipped", String(report.skipped));
    kv("deleted", String(report.deleted));
    kv("failed", report.failed.length ? c.red(String(report.failed.length)) : "0");
    kv("reindexed", report.reindexed ? c.green("yes") : c.dim("no"));
    for (const f of report.failed) info(`${c.red("✗")} ${f.path} ${c.dim(f.error)}`);
}

// ── Tap ────────────────────────────────────────────────────────────────────

async function tapSite(config: CliConfig, argv: string[], positional: string[]): Promise<void> {
    const url = positional[1];
    if (!url) error("Usage: pinecall knowledge tap <url> [kbId] [--limit=N] [--dry-run] [--yes]");
    let kbId = positional[2];
    const dryRun = argv.includes("--dry-run");
    const json = config.json;
    const yes = argv.includes("--yes") || argv.includes("-y") || json;
    const reindex = !argv.includes("--no-reindex");
    const limit = Number(flag(argv, "limit")) || undefined;
    const include = regexes(flag(argv, "include"));
    const exclude = regexes(flag(argv, "exclude"));

    let hostname: string;
    try {
        hostname = new URL(url).hostname;
    } catch {
        error(`Not a URL: ${url}`);
    }

    if (!json) info(`${c.dim("⟳")} discovering ${c.bold(hostname)}…`);
    const plan = await run(config, () =>
        planTap(url, {
            ...(limit ? { limit } : {}),
            ...(include ? { include } : {}),
            ...(exclude ? { exclude } : {}),
            // Keep the prose when we are about to pour it: the plan the human
            // approves IS the plan we tap, so the site is crawled once.
            keepContent: !dryRun,
        }),
    );

    if (json && dryRun) { console.log(JSON.stringify(planJson(plan), null, 2)); return; }
    if (!json) {
        section(`Plan · ${hostname}`, plan.totals.pages);
        table(["PATH", "WORDS", ""], planRows(plan));
        info(totalsLine(plan.totals));
        info(c.dim(`discovered via ${plan.source}`));
    }

    if (dryRun) {
        if (!json) info(c.dim("--dry-run: nothing was written."));
        return;
    }
    if (!plan.totals.included) error("Nothing to index.");

    if (!kbId) {
        if (!yes && !(await confirm(`Create a knowledge base for ${hostname} and tap ${plan.totals.included} pages? [y/N]`))) {
            info("Aborted.");
            return;
        }
        const kb = await run(config, () => createKnowledgeBase(api(config), `site: ${hostname}`, url));
        kbId = kb.id;
        if (!json) { info(`${c.green("✓")} Created knowledge base ${c.bold(kb.name)}`); kv("id", kb.id); }
    } else if (!yes && !(await confirm(`Tap ${plan.totals.included} pages into ${kbId}? [y/N]`))) {
        info("Aborted.");
        return;
    }

    const bar = progressRenderer(!!process.stdout.isTTY && !json, stdoutSink());
    const report = await run(config, () =>
        tapPlan(api(config), kbId!, plan, {
            reindex,
            // The manifest records the options we actually tapped with, so the
            // limit must travel too — otherwise sync re-plans with the default.
            ...(limit ? { limit } : {}),
            ...(include ? { include } : {}),
            ...(exclude ? { exclude } : {}),
            onProgress: bar.on,
        }),
    ).finally(() => bar.end());

    if (json) { console.log(JSON.stringify({ knowledgeBaseId: kbId, plan: planJson(plan), report }, null, 2)); return; }
    printReport(report);
}

/** The plan, without the megabytes of markdown `keepContent` may have kept. */
function planJson(plan: TapPlan) {
    return {
        startUrl: plan.startUrl,
        source: plan.source,
        totals: plan.totals,
        pages: plan.pages.map(({ markdown: _markdown, ...rest }) => rest),
    };
}

// ── Sync ───────────────────────────────────────────────────────────────────

async function sync(config: CliConfig, argv: string[], kbId: string): Promise<void> {
    if (!kbId) error("Usage: pinecall knowledge sync <kbId> [--yes] [--no-reindex]");
    const json = config.json;
    const reindex = !argv.includes("--no-reindex");

    if (!json) info(`${c.dim("⟳")} re-crawling the site behind ${c.bold(kbId)}…`);
    const bar = progressRenderer(!!process.stdout.isTTY && !json, stdoutSink());
    let report: TapReport;
    try {
        report = await syncTap(api(config), kbId, { reindex, onProgress: bar.on });
    } catch (err) {
        bar.end();
        if (err instanceof TapSyncError && err.code === "NEVER_TAPPED") {
            error(
                `This knowledge base was never tapped — there is no manifest to sync from.\n` +
                `  Tap a site into it first: ${c.cyan(`pinecall knowledge tap <url> ${kbId}`)}`,
            );
        }
        return fail(config, err);
    }
    bar.end();

    if (json) { console.log(JSON.stringify(report, null, 2)); return; }
    const delta = report.pushed + report.updated + report.deleted;
    if (!delta) {
        info(`${c.green("✓")} up to date — reindex skipped ${c.dim(`(${report.skipped} ${report.skipped === 1 ? "page" : "pages"} unchanged)`)}`);
        return;
    }
    printReport(report);
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
    tap <url> [kbId]                    Crawl a website into a KB
    sync <kbId>                         Re-tap a KB from its own manifest

  ${c.bold("tap options:")}
    --limit=N                           Max pages (default 100)
    --include=<re>  --exclude=<re>      Comma-separated URL regexes
    --dry-run                           Preview only — writes nothing
    --yes                               Skip the confirmation
    --no-reindex                        Push without rebuilding the index

  ${c.bold("Examples:")}
    ${c.dim("$")} pinecall knowledge create "Product docs"
    ${c.dim("$")} pinecall knowledge push kb_123 ./docs/*.md
    ${c.dim("$")} pinecall knowledge reindex kb_123
    ${c.dim("$")} pinecall knowledge tap https://example.com --dry-run
    ${c.dim("$")} pinecall knowledge tap https://example.com --limit=50 --yes
    ${c.dim("$")} pinecall knowledge tap https://example.com kb_123 --exclude='/blog/'
    ${c.dim("$")} pinecall knowledge sync kb_123

  ${c.dim("tap")} discovers via robots.txt + sitemap (links as fallback), extracts each
  page to markdown and stores a ${c.cyan("_tap-manifest.json")} inside the KB, so
  ${c.dim("sync")} only pushes what changed and skips the reindex when nothing did.

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
        case "tap":
            return tapSite(config, argv, positional);
        case "sync":
            return sync(config, argv, positional[1]);
        default:
            error(`Unknown subcommand: ${sub}\nRun ${c.cyan("pinecall knowledge --help")}`);
    }
}

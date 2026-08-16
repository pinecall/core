/**
 * tap / syncTap — the verbs that write.
 *
 * `planTap` looks; these two pour. The whole incremental story hangs on ONE
 * artefact: a document stored inside the knowledge base itself, at the path
 * `_tap-manifest.json`, mapping every doc path to the URL it came from and the
 * hash of the markdown that was pushed. Keeping it in the KB (instead of on
 * the caller's disk) is what makes a sync work from any machine, any process,
 * any CI job — the knowledge base carries its own provenance.
 *
 * Two rules the manifest buys us, and both are acceptance criteria:
 *
 * - **An unchanged page is not re-pushed.** Same hash ⇒ skipped, not written.
 * - **Zero delta ⇒ no reindex at all.** Re-indexing is the expensive half of
 *   the operation; a sync that found nothing must cost nothing.
 */

import {
    getDoc,
    getKnowledgeBase,
    pushDoc,
    pushDocs,
    deleteDoc,
    reindexKnowledge,
    KnowledgeApiError,
    type KnowledgeApiOptions,
    type KnowledgeDocInput,
} from "../api/knowledge.js";
import { PinecallError } from "../kernel/errors.js";
import { fetchPage } from "./fetch.js";
import { extract } from "./extract.js";
import { contentHash } from "./hash.js";
import { planTap, isExcluded, type TapPage, type TapPlan } from "./plan.js";
import { emit, type DiscoverySource, type OnProgress } from "./types.js";

/** Where the manifest lives, inside the knowledge base it describes. */
export const MANIFEST_PATH = "_tap-manifest.json";
const MANIFEST_TITLE = "tap manifest";

// ── Types ────────────────────────────────────────────────────────────────

export interface TapManifestEntry {
    url: string;
    hash: string;
}

export interface TapManifest {
    version: 1;
    startUrl: string;
    source: DiscoverySource;
    tappedAt: string;
    /** Keyed by knowledge-base document path. */
    pages: Record<string, TapManifestEntry>;
}

export interface TapFailure {
    path: string;
    error: string;
}

export interface TapReport {
    /** Documents whose path was not in the previous manifest. */
    pushed: number;
    /** Documents that existed with a different hash. */
    updated: number;
    /** Documents whose hash was unchanged — never sent. */
    skipped: number;
    failed: TapFailure[];
    /** Documents removed because the site no longer serves them. */
    deleted: number;
    reindexed: boolean;
}

export interface TapOptions {
    include?: RegExp[];
    exclude?: RegExp[];
    onProgress?: OnProgress;
    /** Rebuild the index at the end when something moved. Default: true. */
    reindex?: boolean;
}

export interface SyncTapOptions {
    onProgress?: OnProgress;
    reindex?: boolean;
}

/** Thrown by `syncTap` when the knowledge base carries no manifest. */
export class TapSyncError extends PinecallError {
    constructor(message: string, code: string) {
        super(message, code);
        this.name = "TapSyncError";
    }
}

// ── Manifest ─────────────────────────────────────────────────────────────

/**
 * The manifest's document id, or null when it is not there.
 *
 * The knowledge API addresses documents by id, and the manifest is identified
 * by PATH, so every read starts with a listing. A KB that was never tapped is
 * a normal answer here, not an error.
 */
async function manifestDocId(
    auth: KnowledgeApiOptions,
    kbId: string,
): Promise<string | null> {
    const { docs } = await getKnowledgeBase(auth, kbId);
    return docs.find((d) => d.path === MANIFEST_PATH)?.id ?? null;
}

function parseManifest(text: string): TapManifest | null {
    try {
        const parsed = JSON.parse(text) as Partial<TapManifest>;
        if (!parsed || typeof parsed !== "object" || !parsed.pages) return null;
        return {
            version: 1,
            startUrl: String(parsed.startUrl ?? ""),
            source: (parsed.source ?? "sitemap") as DiscoverySource,
            tappedAt: String(parsed.tappedAt ?? ""),
            pages: parsed.pages as Record<string, TapManifestEntry>,
        };
    } catch {
        return null;
    }
}

/**
 * Read the manifest out of the knowledge base. Returns null both when there is
 * no manifest document and when the one there cannot be parsed — a corrupt
 * manifest is treated as "never tapped", which re-pushes rather than deletes.
 */
export async function readManifest(
    auth: KnowledgeApiOptions,
    kbId: string,
): Promise<{ manifest: TapManifest | null; docId: string | null }> {
    let docId: string | null;
    try {
        docId = await manifestDocId(auth, kbId);
    } catch (err) {
        if (err instanceof KnowledgeApiError && err.status === 404) {
            return { manifest: null, docId: null };
        }
        throw err;
    }
    if (!docId) return { manifest: null, docId: null };
    try {
        const doc = await getDoc(auth, kbId, docId);
        return { manifest: parseManifest(doc.text), docId };
    } catch (err) {
        if (err instanceof KnowledgeApiError && err.status === 404) {
            return { manifest: null, docId: null };
        }
        throw err;
    }
}

async function writeManifest(
    auth: KnowledgeApiOptions,
    kbId: string,
    manifest: TapManifest,
): Promise<void> {
    await pushDoc(auth, kbId, {
        path: MANIFEST_PATH,
        title: MANIFEST_TITLE,
        text: JSON.stringify(manifest, null, 2),
    });
}

// ── Documents ────────────────────────────────────────────────────────────

/**
 * The header every tapped document carries.
 *
 * It is what lets a retrieval hit point back at a real page: the answer an
 * agent gives out of this knowledge base can cite the URL it came from. The
 * title is JSON-escaped because a page title with a quote or a newline in it
 * must not break the block.
 */
export function frontmatter(page: {
    url: string;
    title: string;
    hash: string;
    fetchedAt: string;
}): string {
    return (
        "---\n" +
        `url: ${page.url}\n` +
        `title: ${JSON.stringify(page.title)}\n` +
        `hash: ${page.hash}\n` +
        `fetchedAt: ${page.fetchedAt}\n` +
        "---\n\n"
    );
}

function docFor(page: TapPage, markdown: string, fetchedAt: string): KnowledgeDocInput {
    return {
        path: page.path,
        title: page.title,
        text:
            frontmatter({
                url: page.url,
                title: page.title,
                hash: page.hash,
                fetchedAt,
            }) + markdown,
    };
}

/**
 * The markdown for a page, re-fetching only when the plan does not carry it.
 *
 * A plan taken without `keepContent` is a table of hashes with no prose, and
 * tapping it must still work — so the pages that need text get fetched again
 * here rather than the caller being told to re-plan.
 */
async function materialize(
    pages: TapPage[],
    onProgress: OnProgress | undefined,
): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const missing = pages.filter((p) => p.markdown === undefined);
    for (const p of pages) {
        if (p.markdown !== undefined) out.set(p.url, p.markdown);
    }
    if (!missing.length) return out;

    const total = missing.length;
    let done = 0;
    emit(onProgress, { phase: "fetch", event: "start", done, total });
    for (const p of missing) {
        try {
            const fetched = await fetchPage(p.url);
            const extracted = await extract(fetched.body, fetched.finalUrl);
            out.set(p.url, extracted.markdown);
            // The hash travels with the text it was taken over.
            p.hash = contentHash(extracted.markdown);
            done++;
            emit(onProgress, {
                phase: "extract", event: "page", url: p.url, path: p.path, done, total,
            });
        } catch (err) {
            done++;
            emit(onProgress, {
                phase: "fetch",
                event: "error",
                url: p.url,
                path: p.path,
                done,
                total,
                message: err instanceof Error ? err.message : String(err),
            });
        }
    }
    emit(onProgress, { phase: "fetch", event: "done", done, total });
    return out;
}

/** Included, fetched, non-broken pages — the only ones that ever get pushed. */
function indexable(plan: TapPlan, opts: Pick<TapOptions, "include" | "exclude">): TapPage[] {
    return plan.pages.filter(
        (p) =>
            !p.excluded &&
            !p.error &&
            !isExcluded(p.url, opts.include, opts.exclude),
    );
}

/**
 * Push a batch and fold the results into a report, classifying each document
 * against the previous manifest: a path nobody had seen is `pushed`, a path
 * that was there under a different hash is `updated`.
 */
async function pushBatch(
    auth: KnowledgeApiOptions,
    kbId: string,
    entries: Array<{ doc: KnowledgeDocInput; isNew: boolean }>,
    report: TapReport,
    onProgress: OnProgress | undefined,
): Promise<void> {
    const total = entries.length;
    emit(onProgress, { phase: "push", event: "start", done: 0, total });
    if (!total) {
        emit(onProgress, { phase: "push", event: "done", done: 0, total: 0 });
        return;
    }

    const results = await pushDocs(auth, kbId, entries.map((e) => e.doc));
    let done = 0;
    results.forEach((r, i) => {
        done++;
        const entry = entries[i]!;
        if (r.ok) {
            if (entry.isNew) report.pushed++;
            else report.updated++;
            emit(onProgress, { phase: "push", event: "page", path: r.path, done, total });
        } else {
            report.failed.push({ path: r.path, error: r.error?.message ?? "push failed" });
            emit(onProgress, {
                phase: "push",
                event: "error",
                path: r.path,
                done,
                total,
                message: r.error?.message ?? "push failed",
            });
        }
    });
    emit(onProgress, { phase: "push", event: "done", done, total });
}

async function maybeReindex(
    auth: KnowledgeApiOptions,
    kbId: string,
    report: TapReport,
    wanted: boolean,
    onProgress: OnProgress | undefined,
): Promise<void> {
    const moved = report.pushed + report.updated + report.deleted > 0;
    if (!wanted || !moved) return;
    emit(onProgress, { phase: "reindex", event: "start", done: 0, total: 1 });
    await reindexKnowledge(auth, kbId);
    report.reindexed = true;
    emit(onProgress, { phase: "reindex", event: "done", done: 1, total: 1 });
}

function emptyReport(): TapReport {
    return { pushed: 0, updated: 0, skipped: 0, failed: [], deleted: 0, reindexed: false };
}

// ── tap ──────────────────────────────────────────────────────────────────

/**
 * Pour a plan into a knowledge base.
 *
 * Give it a URL and it plans the site first; give it a plan a human already
 * approved and it uses exactly that. Unchanged pages (same hash as the last
 * tap) are skipped without a request, and the manifest is rewritten at the end
 * so the next `syncTap` knows what this run left behind.
 */
export async function tap(
    auth: KnowledgeApiOptions,
    kbId: string,
    plan: TapPlan | string,
    opts: TapOptions = {},
): Promise<TapReport> {
    const { include, exclude, onProgress, reindex = true } = opts;

    const resolved: TapPlan =
        typeof plan === "string"
            ? await planTap(plan, {
                  keepContent: true,
                  ...(include ? { include } : {}),
                  ...(exclude ? { exclude } : {}),
                  ...(onProgress ? { onProgress } : {}),
              })
            : plan;

    const report = emptyReport();
    const pages = indexable(resolved, { ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) });
    const content = await materialize(pages, onProgress);

    const { manifest: previous } = await readManifest(auth, kbId);
    const known = previous?.pages ?? {};
    const tappedAt = new Date().toISOString();

    const entries: Array<{ doc: KnowledgeDocInput; isNew: boolean }> = [];
    const manifestPages: Record<string, TapManifestEntry> = {};

    for (const page of pages) {
        const markdown = content.get(page.url);
        if (markdown === undefined) {
            report.failed.push({ path: page.path, error: "no content extracted" });
            continue;
        }
        manifestPages[page.path] = { url: page.url, hash: page.hash };
        const before = known[page.path];
        if (before && before.hash === page.hash) {
            report.skipped++;
            continue;
        }
        entries.push({ doc: docFor(page, markdown, tappedAt), isNew: !before });
    }

    await pushBatch(auth, kbId, entries, report, onProgress);

    await writeManifest(auth, kbId, {
        version: 1,
        startUrl: resolved.startUrl,
        source: resolved.source,
        tappedAt,
        pages: manifestPages,
    });

    await maybeReindex(auth, kbId, report, reindex, onProgress);
    return report;
}

// ── syncTap ──────────────────────────────────────────────────────────────

/**
 * Re-tap a knowledge base from its own manifest.
 *
 * Needs no arguments beyond the KB because the manifest already says which
 * site this is and what was in it. Pages that changed are pushed, pages the
 * site stopped serving are deleted, and everything else is left alone — so a
 * sync over a site that did not move is a handful of GETs and nothing else.
 */
export async function syncTap(
    auth: KnowledgeApiOptions,
    kbId: string,
    opts: SyncTapOptions = {},
): Promise<TapReport> {
    const { onProgress, reindex = true } = opts;

    const { manifest } = await readManifest(auth, kbId);
    if (!manifest || !manifest.startUrl) {
        throw new TapSyncError(
            `Knowledge base ${kbId} has no ${MANIFEST_PATH}: it was never tapped. Run tap() first.`,
            "NEVER_TAPPED",
        );
    }

    const plan = await planTap(manifest.startUrl, {
        keepContent: true,
        ...(onProgress ? { onProgress } : {}),
    });

    const report = emptyReport();
    const pages = indexable(plan, {});
    const content = await materialize(pages, onProgress);
    const tappedAt = new Date().toISOString();

    const entries: Array<{ doc: KnowledgeDocInput; isNew: boolean }> = [];
    const manifestPages: Record<string, TapManifestEntry> = {};

    for (const page of pages) {
        const markdown = content.get(page.url);
        if (markdown === undefined) {
            report.failed.push({ path: page.path, error: "no content extracted" });
            continue;
        }
        manifestPages[page.path] = { url: page.url, hash: page.hash };
        const before = manifest.pages[page.path];
        if (before && before.hash === page.hash) {
            report.skipped++;
            continue;
        }
        entries.push({ doc: docFor(page, markdown, tappedAt), isNew: !before });
    }

    await pushBatch(auth, kbId, entries, report, onProgress);

    // Gone from the site — the manifest is the only record that they were ever
    // there, so this is the one chance to take them out of the index.
    const gone = Object.keys(manifest.pages).filter((path) => !(path in manifestPages));
    if (gone.length) {
        const { docs } = await getKnowledgeBase(auth, kbId);
        const byPath = new Map(docs.map((d) => [d.path, d.id]));
        const total = gone.length;
        let done = 0;
        emit(onProgress, { phase: "delete", event: "start", done, total });
        for (const path of gone) {
            const docId = byPath.get(path);
            done++;
            if (!docId) {
                // Already absent from the KB: nothing to delete, and dropping it
                // from the manifest is the whole fix.
                emit(onProgress, { phase: "delete", event: "page", path, done, total });
                continue;
            }
            try {
                await deleteDoc(auth, kbId, docId);
                report.deleted++;
                emit(onProgress, { phase: "delete", event: "page", path, done, total });
            } catch (err) {
                report.failed.push({
                    path,
                    error: err instanceof Error ? err.message : String(err),
                });
                emit(onProgress, {
                    phase: "delete",
                    event: "error",
                    path,
                    done,
                    total,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        }
        emit(onProgress, { phase: "delete", event: "done", done, total });
    }

    const delta = report.pushed + report.updated + report.deleted > 0;
    if (delta) {
        await writeManifest(auth, kbId, {
            version: 1,
            startUrl: manifest.startUrl,
            source: plan.source,
            tappedAt,
            pages: manifestPages,
        });
    }

    await maybeReindex(auth, kbId, report, reindex, onProgress);
    return report;
}

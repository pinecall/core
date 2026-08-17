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

/**
 * The crawl options a tap ran with, in a shape that survives JSON.
 *
 * `include`/`exclude` are stored as **RegExp sources** (`re.source`) because a
 * `RegExp` does not serialize — `JSON.stringify(/a/)` is `{}` — and they are
 * rebuilt with `new RegExp(s)` on read. Flags are deliberately not kept: the
 * filters are matched against URLs, where case matters.
 */
export interface TapCrawlOptions {
    limit?: number;
    /** RegExp sources, not patterns with delimiters: `\\/docs\\/`, not `/docs/`. */
    include?: string[];
    exclude?: string[];
}

export interface TapManifest {
    version: 1;
    startUrl: string;
    source: DiscoverySource;
    tappedAt: string;
    /**
     * The crawl options the tap that wrote this manifest actually used, so a
     * later `syncTap` re-plans the same slice of the site instead of the whole
     * of it.
     *
     * **Optional on read, and that is not a version bump.** A manifest written
     * before this field existed simply has none, and syncs with the library
     * defaults (limit 100, no include/exclude) — exactly the behaviour it had
     * when it was written. Manifest `version` stays `1`.
     */
    options?: TapCrawlOptions;
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
    /**
     * Maximum pages to consider. Politeness default: 100.
     *
     * Used when `tap` plans the site itself; when it is handed a prebuilt plan
     * the plan already decided, and this is recorded in the manifest so the
     * next `syncTap` re-plans with the same bound.
     */
    limit?: number;
    include?: RegExp[];
    exclude?: RegExp[];
    onProgress?: OnProgress;
    /** Rebuild the index at the end when something moved. Default: true. */
    reindex?: boolean;
}

export interface SyncTapOptions {
    /**
     * Override the limit stored in the manifest. Omitted, the stored one is
     * used; given, it wins and is written back on the next manifest write.
     */
    limit?: number;
    /** Override the manifest's stored `include`. Same rule as {@link SyncTapOptions.limit}. */
    include?: RegExp[];
    /** Override the manifest's stored `exclude`. Same rule as {@link SyncTapOptions.limit}. */
    exclude?: RegExp[];
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

/** The live shape of {@link TapCrawlOptions}: sources compiled back to RegExp. */
interface CrawlOptions {
    limit?: number;
    include?: RegExp[];
    exclude?: RegExp[];
}

function compile(sources: unknown): RegExp[] | undefined {
    if (!Array.isArray(sources)) return undefined;
    const out: RegExp[] = [];
    for (const s of sources) {
        if (typeof s !== "string") continue;
        try {
            out.push(new RegExp(s));
        } catch {
            // A source that no longer compiles is dropped rather than fatal: a
            // sync must not be bricked by one bad pattern in a stored manifest.
        }
    }
    return out.length ? out : undefined;
}

/** Manifest options → the live options planTap takes. */
function crawlOptionsOf(stored: TapCrawlOptions | undefined): CrawlOptions {
    if (!stored) return {};
    const out: CrawlOptions = {};
    if (typeof stored.limit === "number" && Number.isFinite(stored.limit)) {
        out.limit = stored.limit;
    }
    const include = compile(stored.include);
    if (include) out.include = include;
    const exclude = compile(stored.exclude);
    if (exclude) out.exclude = exclude;
    return out;
}

/**
 * Live options → what goes in the manifest. Returns undefined when nothing was
 * constrained, so a default tap does not grow an empty object in its manifest.
 */
function storedOptionsOf(opts: CrawlOptions): TapCrawlOptions | undefined {
    const out: TapCrawlOptions = {};
    if (typeof opts.limit === "number") out.limit = opts.limit;
    if (opts.include?.length) out.include = opts.include.map((re) => re.source);
    if (opts.exclude?.length) out.exclude = opts.exclude.map((re) => re.source);
    return Object.keys(out).length ? out : undefined;
}

function parseOptions(raw: unknown): TapCrawlOptions | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    return storedOptionsOf(crawlOptionsOf(raw as TapCrawlOptions));
}

function parseManifest(text: string): TapManifest | null {
    try {
        const parsed = JSON.parse(text) as Partial<TapManifest>;
        if (!parsed || typeof parsed !== "object" || !parsed.pages) return null;
        const options = parseOptions(parsed.options);
        return {
            version: 1,
            startUrl: String(parsed.startUrl ?? ""),
            source: (parsed.source ?? "sitemap") as DiscoverySource,
            tappedAt: String(parsed.tappedAt ?? ""),
            ...(options ? { options } : {}),
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

    // One doc at a time, EMITTING AS EACH ONE LANDS — not pushDocs and a loop
    // over its results afterwards. The batch call answered only when all N
    // uploads were done, so a consumer's progress bar sat at 0/N for the whole
    // push phase (~0.6s x N against the playground) and then jumped to done in
    // one burst — measured on the live site with a 39-page crawl. Failure
    // semantics are pushDocs's own: one bad document never aborts the rest.
    let done = 0;
    for (const entry of entries) {
        done++;
        try {
            await pushDoc(auth, kbId, entry.doc);
            if (entry.isNew) report.pushed++;
            else report.updated++;
            emit(onProgress, { phase: "push", event: "page", path: entry.doc.path, done, total });
        } catch (err) {
            const message = err instanceof Error ? err.message : "push failed";
            report.failed.push({ path: entry.doc.path, error: message });
            emit(onProgress, {
                phase: "push",
                event: "error",
                path: entry.doc.path,
                done,
                total,
                message,
            });
        }
    }
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
    const { limit, include, exclude, onProgress, reindex = true } = opts;
    // What this run actually crawled with — written into the manifest so the
    // next syncTap re-plans the same slice instead of the whole site.
    const used: CrawlOptions = {
        ...(limit === undefined ? {} : { limit }),
        ...(include ? { include } : {}),
        ...(exclude ? { exclude } : {}),
    };

    const resolved: TapPlan =
        typeof plan === "string"
            ? await planTap(plan, {
                  keepContent: true,
                  ...(limit === undefined ? {} : { limit }),
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

    const storedOptions = storedOptionsOf(used);
    await writeManifest(auth, kbId, {
        version: 1,
        startUrl: resolved.startUrl,
        source: resolved.source,
        tappedAt,
        ...(storedOptions ? { options: storedOptions } : {}),
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

    // The manifest's own crawl options are the baseline — re-planning with the
    // library defaults would pull in pages the original tap deliberately left
    // out. An explicit option here overrides, per key, and is persisted below.
    const stored = crawlOptionsOf(manifest.options);
    const effective: CrawlOptions = {
        ...stored,
        ...(opts.limit === undefined ? {} : { limit: opts.limit }),
        ...(opts.include ? { include: opts.include } : {}),
        ...(opts.exclude ? { exclude: opts.exclude } : {}),
    };

    const plan = await planTap(manifest.startUrl, {
        keepContent: true,
        ...(effective.limit === undefined ? {} : { limit: effective.limit }),
        ...(effective.include ? { include: effective.include } : {}),
        ...(effective.exclude ? { exclude: effective.exclude } : {}),
        ...(onProgress ? { onProgress } : {}),
    });

    const report = emptyReport();
    const pages = indexable(plan, {
        ...(effective.include ? { include: effective.include } : {}),
        ...(effective.exclude ? { exclude: effective.exclude } : {}),
    });
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
    const storedOptions = storedOptionsOf(effective);
    // An override that changed nothing on the site still has to be recorded,
    // or the next sync would silently fall back to the old bounds.
    const optionsMoved =
        JSON.stringify(storedOptions ?? null) !== JSON.stringify(manifest.options ?? null);
    if (delta || optionsMoved) {
        await writeManifest(auth, kbId, {
            version: 1,
            startUrl: manifest.startUrl,
            source: plan.source,
            tappedAt,
            ...(storedOptions ? { options: storedOptions } : {}),
            pages: manifestPages,
        });
    }

    await maybeReindex(auth, kbId, report, reindex, onProgress);
    return report;
}

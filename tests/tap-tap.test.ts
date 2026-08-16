/**
 * tap / syncTap — the verbs that write.
 *
 * The knowledge API module is mocked wholesale and `fetch` is stubbed for the
 * crawl, so nothing here touches a network. What is pinned is the arithmetic
 * the manifest exists for: same hash ⇒ no push, zero delta ⇒ NO reindex call
 * at all, and a page the site stopped serving ⇒ exactly one delete.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/api/knowledge.js", async () => {
    const actual = await vi.importActual<typeof import("../src/api/knowledge.js")>(
        "../src/api/knowledge.js",
    );
    return {
        ...actual,
        getKnowledgeBase: vi.fn(),
        getDoc: vi.fn(),
        pushDoc: vi.fn(),
        pushDocs: vi.fn(),
        deleteDoc: vi.fn(),
        reindexKnowledge: vi.fn(),
    };
});

import {
    getKnowledgeBase,
    getDoc,
    pushDoc,
    pushDocs,
    deleteDoc,
    reindexKnowledge,
    type KnowledgeApiOptions,
    type KnowledgeDocInput,
} from "../src/api/knowledge.js";
import { tap, syncTap, TapSyncError, MANIFEST_PATH } from "../src/tap/tap.js";
import { docPath } from "../src/tap/plan.js";
import type { TapProgress } from "../src/tap/types.js";

const auth: KnowledgeApiOptions = { apiKey: "k", playgroundUrl: "http://pg.local" };
const KB = "kb_1";
const SITE = "https://ex.com";

// ── the fake site ────────────────────────────────────────────────────────

function res(body: string, contentType: string, url = ""): Response {
    return {
        ok: true,
        status: 200,
        url,
        headers: new Headers({ "content-type": contentType }),
        text: async () => body,
    } as unknown as Response;
}

function notFound(): Response {
    return {
        ok: false,
        status: 404,
        url: "",
        headers: new Headers(),
        text: async () => "",
    } as unknown as Response;
}

function page(title: string, seed: string): string {
    const body = Array.from({ length: 400 }, (_, i) => `${seed}${i}`).join(" ");
    return `<!doctype html><html><head><title>${title}</title></head><body>
        <article><h1>${title}</h1><p>${body}</p></article>
    </body></html>`;
}

function sitemap(urls: string[]): string {
    return `<?xml version="1.0"?><urlset>${urls
        .map((u) => `<url><loc>${u}</loc></url>`)
        .join("")}</urlset>`;
}

/** A site is a map of path -> seed; changing a seed changes the prose. */
function serve(pages: Record<string, string>) {
    const urls = Object.keys(pages);
    const table: Record<string, () => Response> = {
        [`${SITE}/robots.txt`]: () => res("User-agent: *\nAllow: /\n", "text/plain"),
        [`${SITE}/sitemap.xml`]: () => res(sitemap(urls), "application/xml"),
    };
    for (const [url, seed] of Object.entries(pages)) {
        table[url] = () => res(page(url, seed), "text/html; charset=utf-8", url);
    }
    return vi.fn(async (input: unknown) => {
        const hit = table[String(input)];
        return hit ? hit() : notFound();
    });
}

const SITE_V1 = {
    [`${SITE}/`]: "a",
    [`${SITE}/about`]: "b",
    [`${SITE}/news`]: "c",
};

// ── knowledge-base double ────────────────────────────────────────────────

type Doc = { id: string; path: string; title: string; bytes: number; text: string };

/** An in-memory knowledge base, keyed by path exactly as the server keys it. */
function fakeKb(initial: Doc[] = []) {
    const docs = new Map(initial.map((d) => [d.path, d]));
    let n = initial.length;

    vi.mocked(getKnowledgeBase).mockImplementation(async () => ({
        knowledgeBase: { id: KB, name: "kb", docCount: docs.size, status: "ready" },
        docs: [...docs.values()].map(({ text: _t, ...rest }) => rest),
    }));
    vi.mocked(getDoc).mockImplementation(async (_a, _kb, id) => {
        const found = [...docs.values()].find((d) => d.id === id);
        if (!found) throw new Error(`no doc ${id}`);
        return found;
    });
    vi.mocked(pushDoc).mockImplementation(async (_a, _kb, doc: KnowledgeDocInput) => {
        const existing = docs.get(doc.path);
        const stored: Doc = {
            id: existing?.id ?? `d${++n}`,
            path: doc.path,
            title: doc.title ?? "",
            bytes: doc.text.length,
            text: doc.text,
        };
        docs.set(doc.path, stored);
        const { text: _t, ...rest } = stored;
        return rest;
    });
    vi.mocked(pushDocs).mockImplementation(async (a, kb, list: KnowledgeDocInput[]) => {
        const out = [];
        for (const doc of list) {
            out.push({ path: doc.path, ok: true, doc: await vi.mocked(pushDoc)(a, kb, doc) });
        }
        return out;
    });
    vi.mocked(deleteDoc).mockImplementation(async (_a, _kb, id) => {
        for (const [path, d] of docs) if (d.id === id) docs.delete(path);
    });
    vi.mocked(reindexKnowledge).mockImplementation(async () => {});

    return {
        docs,
        manifest: () => JSON.parse(docs.get(MANIFEST_PATH)!.text),
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", serve(SITE_V1));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// ── tests ────────────────────────────────────────────────────────────────

describe("tap — the first one", () => {
    it("pushes every page plus the manifest and reindexes once", async () => {
        const kb = fakeKb();
        const report = await tap(auth, KB, SITE);

        expect(report.pushed).toBe(3);
        expect(report.updated).toBe(0);
        expect(report.skipped).toBe(0);
        expect(report.failed).toEqual([]);
        expect(report.reindexed).toBe(true);
        expect(reindexKnowledge).toHaveBeenCalledTimes(1);

        expect([...kb.docs.keys()].sort()).toEqual(
            ["about.md", "index.md", "news.md", MANIFEST_PATH].sort(),
        );

        const manifest = kb.manifest();
        expect(manifest.version).toBe(1);
        expect(manifest.startUrl).toBe(SITE);
        expect(Object.keys(manifest.pages).sort()).toEqual(
            ["about.md", "index.md", "news.md"].sort(),
        );
        expect(manifest.pages["about.md"].url).toBe(`${SITE}/about`);
        expect(manifest.pages["about.md"].hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it("writes a frontmatter header carrying the url, hash and time", async () => {
        const kb = fakeKb();
        await tap(auth, KB, SITE);

        const doc = kb.docs.get("about.md")!;
        expect(doc.text.startsWith("---\n")).toBe(true);
        expect(doc.text).toContain(`url: ${SITE}/about`);
        expect(doc.text).toContain(`hash: ${kb.manifest().pages["about.md"].hash}`);
        expect(doc.text).toMatch(/fetchedAt: \d{4}-\d{2}-\d{2}T/);
        expect(doc.text).toMatch(/\n---\n\n/);
    });

    it("emits push progress with done/total on every event", async () => {
        fakeKb();
        const events: TapProgress[] = [];
        await tap(auth, KB, SITE, { onProgress: (e) => events.push(e) });

        for (const e of events) {
            expect(typeof e.done).toBe("number");
            expect(typeof e.total).toBe("number");
        }
        const push = events.filter((e) => e.phase === "push");
        expect(push[0]!.event).toBe("start");
        expect(push.at(-1)).toMatchObject({ event: "done", done: 3, total: 3 });
        expect(events.filter((e) => e.phase === "reindex").map((e) => e.event)).toEqual([
            "start",
            "done",
        ]);
    });

    it("skips a page whose hash has not moved since the last tap", async () => {
        const kb = fakeKb();
        await tap(auth, KB, SITE);
        vi.mocked(pushDocs).mockClear();

        const second = await tap(auth, KB, SITE);
        expect(second.skipped).toBe(3);
        expect(second.pushed).toBe(0);
        expect(second.updated).toBe(0);
        expect(second.reindexed).toBe(false);
        expect(pushDocs).not.toHaveBeenCalled();
        expect(kb.docs.size).toBe(4);
    });

    it("honours reindex:false", async () => {
        fakeKb();
        const report = await tap(auth, KB, SITE, { reindex: false });
        expect(report.pushed).toBe(3);
        expect(report.reindexed).toBe(false);
        expect(reindexKnowledge).not.toHaveBeenCalled();
    });

    it("respects exclude", async () => {
        const kb = fakeKb();
        const report = await tap(auth, KB, SITE, { exclude: [/\/news/] });
        expect(report.pushed).toBe(2);
        expect(kb.docs.has("news.md")).toBe(false);
    });
});

describe("syncTap", () => {
    it("throws a typed NEVER_TAPPED error on a knowledge base with no manifest", async () => {
        fakeKb();
        await expect(syncTap(auth, KB)).rejects.toBeInstanceOf(TapSyncError);
        await expect(syncTap(auth, KB)).rejects.toMatchObject({ code: "NEVER_TAPPED" });
        expect(pushDocs).not.toHaveBeenCalled();
        expect(reindexKnowledge).not.toHaveBeenCalled();
    });

    it("with zero delta pushes nothing, deletes nothing and never reindexes", async () => {
        const kb = fakeKb();
        await tap(auth, KB, SITE);
        const manifestBefore = kb.docs.get(MANIFEST_PATH)!.text;
        vi.mocked(pushDoc).mockClear();
        vi.mocked(pushDocs).mockClear();
        vi.mocked(reindexKnowledge).mockClear();

        const report = await syncTap(auth, KB);

        expect(report).toMatchObject({
            pushed: 0, updated: 0, deleted: 0, skipped: 3, reindexed: false,
        });
        expect(pushDocs).not.toHaveBeenCalled();
        expect(pushDoc).not.toHaveBeenCalled();
        expect(deleteDoc).not.toHaveBeenCalled();
        expect(reindexKnowledge).not.toHaveBeenCalled();
        // The manifest was not rewritten either.
        expect(kb.docs.get(MANIFEST_PATH)!.text).toBe(manifestBefore);
    });

    it("pushes what changed, deletes what is gone, and rewrites the manifest", async () => {
        const kb = fakeKb();
        await tap(auth, KB, SITE);
        const before = kb.manifest();

        // /about rewritten, /news taken down.
        vi.stubGlobal(
            "fetch",
            serve({ [`${SITE}/`]: "a", [`${SITE}/about`]: "REWRITTEN" }),
        );
        vi.mocked(pushDocs).mockClear();
        vi.mocked(reindexKnowledge).mockClear();

        const events: TapProgress[] = [];
        const report = await syncTap(auth, KB, { onProgress: (e) => events.push(e) });

        expect(report.updated).toBe(1);
        expect(report.pushed).toBe(0);
        expect(report.skipped).toBe(1);
        expect(report.deleted).toBe(1);
        expect(report.reindexed).toBe(true);
        expect(reindexKnowledge).toHaveBeenCalledTimes(1);

        expect(vi.mocked(pushDocs).mock.calls[0]![2]).toHaveLength(1);
        expect(vi.mocked(pushDocs).mock.calls[0]![2][0]!.path).toBe("about.md");
        expect(deleteDoc).toHaveBeenCalledTimes(1);
        expect(kb.docs.has("news.md")).toBe(false);

        const after = kb.manifest();
        expect(Object.keys(after.pages).sort()).toEqual(["about.md", "index.md"]);
        expect(after.pages["about.md"].hash).not.toBe(before.pages["about.md"].hash);
        expect(after.pages["index.md"].hash).toBe(before.pages["index.md"].hash);

        const del = events.filter((e) => e.phase === "delete");
        expect(del.map((e) => e.event)).toEqual(["start", "page", "done"]);
        expect(del.at(-1)).toMatchObject({ done: 1, total: 1 });
        expect(del[1]!.path).toBe(docPath(`${SITE}/news`));
    });

    it("pushes a page the site added since the last tap", async () => {
        fakeKb();
        await tap(auth, KB, SITE);
        vi.stubGlobal("fetch", serve({ ...SITE_V1, [`${SITE}/blog`]: "d" }));

        const report = await syncTap(auth, KB);
        expect(report.pushed).toBe(1);
        expect(report.updated).toBe(0);
        expect(report.skipped).toBe(3);
        expect(report.deleted).toBe(0);
    });
});

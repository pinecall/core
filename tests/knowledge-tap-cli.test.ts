/**
 * CLI — `pinecall knowledge tap` / `sync`.
 *
 * The network is mocked end to end: the only thing this exercises is the
 * layer the user actually sees — the preview table, the bar, and the promise
 * that `--dry-run` writes NOTHING. That last one is asserted the only way
 * worth asserting it: by watching every request that leaves and proving none
 * of them went to the knowledge API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
    knowledgeCommand,
    planRows,
    totalsLine,
    progressRenderer,
    type ProgressSink,
} from "../src/cli/commands/knowledge.js";
import type { TapPlan } from "../src/tap/plan.js";
import type { TapProgress } from "../src/tap/types.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ── Fixtures ─────────────────────────────────────────────────────────────

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
        ok: false, status: 404, url: "", headers: new Headers(), text: async () => "",
    } as unknown as Response;
}

const html = (body: string, url = "") => res(body, "text/html; charset=utf-8", url);

function page(title: string, words: number): string {
    const body = Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
    return `<!doctype html><html><head><title>${title}</title></head><body>
        <article><h1>${title}</h1><p>${body}</p></article>
    </body></html>`;
}

const SITE = "https://ex.com";
const SITEMAP = `<?xml version="1.0"?><urlset>
    <url><loc>https://ex.com/</loc></url>
    <url><loc>https://ex.com/about</loc></url>
    <url><loc>https://ex.com/blog/one</loc></url>
</urlset>`;

const ROUTES: Record<string, Response | (() => Response)> = {
    [`${SITE}/robots.txt`]: () => res(`User-agent: *\nSitemap: ${SITE}/sitemap.xml\n`, "text/plain"),
    [`${SITE}/sitemap.xml`]: () => res(SITEMAP, "application/xml"),
    [`${SITE}/`]: () => html(page("Home", 400), `${SITE}/`),
    [`${SITE}/about`]: () => html(page("About", 400), `${SITE}/about`),
    [`${SITE}/blog/one`]: () => html(page("One", 400), `${SITE}/blog/one`),
};

const config = {
    apiKey: "sk-test",
    server: "https://voice.example",
    playground: "https://pg.example",
    json: false,
};

// ── A knowledge base that remembers, so a second tap can be a real sync ──

interface FakeDoc { id: string; path: string; title: string; text: string }

class FakeKb {
    kbs = new Map<string, { id: string; name: string; description?: string }>();
    docs = new Map<string, FakeDoc[]>();
    reindexed = 0;
    private seq = 0;

    handle(url: string, init: any): Response | null {
        const m = url.match(/\/api\/knowledge(.*)$/);
        if (!m) return null;
        const path = m[1] ?? "";
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(init.body) : undefined;
        const json = (o: unknown) => ({
            ok: true, status: 200, url, headers: new Headers({ "content-type": "application/json" }),
            text: async () => JSON.stringify(o), json: async () => JSON.parse(JSON.stringify(o)),
        } as unknown as Response);

        if (path === "" && method === "POST") {
            const id = `kb_${++this.seq}`;
            const kb = { id, name: body.name, description: body.description };
            this.kbs.set(id, kb);
            this.docs.set(id, []);
            return json({ knowledgeBase: kb });
        }
        const parts = path.split("/").filter(Boolean);
        const kbId = parts[0] ?? "";
        const docs = this.docs.get(kbId);
        if (!docs) return notFound();

        if (parts.length === 1 && method === "GET") {
            return json({ knowledgeBase: this.kbs.get(kbId), docs: docs.map(({ text: _t, ...d }) => d) });
        }
        if (parts[1] === "reindex" && method === "POST") { this.reindexed++; return json({ ok: true }); }
        if (parts[1] === "docs" && parts.length === 2 && method === "POST") {
            const existing = docs.find((d) => d.path === body.path);
            if (existing) { existing.text = body.text; existing.title = body.title; return json({ doc: existing }); }
            const doc = { id: `doc_${++this.seq}`, path: body.path, title: body.title, text: body.text };
            docs.push(doc);
            return json({ doc });
        }
        if (parts[1] === "docs" && parts.length === 3) {
            const i = docs.findIndex((d) => d.id === parts[2]);
            if (i < 0) return notFound();
            if (method === "GET") return json({ doc: docs[i] });
            if (method === "DELETE") { docs.splice(i, 1); return json({ ok: true }); }
        }
        return notFound();
    }
}

let calls: string[];
let out: string[];
let errs: string[];
let kb: FakeKb;

beforeEach(() => {
    calls = [];
    out = [];
    errs = [];
    kb = new FakeKb();
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
        out.push(strip(a.map(String).join(" ")));
    });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
        errs.push(strip(a.map(String).join(" ")));
    });
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: unknown) => {
        const url = String(input);
        calls.push(url);
        const fake = kb.handle(url, init);
        if (fake) return fake;
        const hit = ROUTES[url];
        if (!hit) return notFound();
        return typeof hit === "function" ? hit() : hit;
    }));
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// ── The preview ──────────────────────────────────────────────────────────

const PLAN: TapPlan = {
    startUrl: SITE,
    source: "sitemap",
    pages: [
        { url: `${SITE}/`, path: "index.md", title: "Home", words: 400, tokens: 500, thin: false, needsJs: false, hash: "a" },
        { url: `${SITE}/x`, path: "x.md", title: "X", words: 12, tokens: 20, thin: true, needsJs: true, hash: "b" },
        { url: `${SITE}/y`, path: "y.md", title: "", words: 0, tokens: 0, thin: false, needsJs: false, hash: "", excluded: true },
        { url: `${SITE}/z`, path: "z.md", title: "", words: 0, tokens: 0, thin: false, needsJs: false, hash: "", error: "HTTP 500" },
    ],
    totals: { pages: 4, included: 2, excluded: 1, failed: 1, thin: 1, needsJs: 1, words: 412, tokens: 520 },
};

describe("preview rendering", () => {
    it("badges each page by what the plan found", () => {
        const rows = planRows(PLAN).map((r) => r.map(strip));
        expect(rows[0]).toEqual(["index.md", "400", ""]);
        expect(rows[1]![2]).toContain("THIN");
        expect(rows[1]![2]).toContain("JS!");
        expect(rows[2]![2]).toBe("EXCL");
        expect(rows[3]![2]).toContain("✗");
        expect(rows[3]![2]).toContain("HTTP 500");
    });

    it("summarises the totals on one line", () => {
        const line = strip(totalsLine(PLAN.totals));
        expect(line).toContain("2 to index");
        expect(line).toContain("412 words");
        expect(line).toContain("1 thin");
        expect(line).toContain("1 need JS");
        expect(line).toContain("1 excluded");
        expect(line).toContain("1 failed");
    });
});

// ── The bar ──────────────────────────────────────────────────────────────

function sink(): ProgressSink & { writes: string[]; lines: string[] } {
    const writes: string[] = [];
    const lines: string[] = [];
    return { writes, lines, write: (s) => writes.push(s), line: (s) => lines.push(s) };
}

const ev = (phase: TapProgress["phase"], done: number, total: number, path?: string): TapProgress =>
    ({ phase, event: "page", done, total, ...(path ? { path } : {}) });

describe("progress rendering", () => {
    it("rewrites one line on a TTY", () => {
        const s = sink();
        const bar = progressRenderer(true, s);
        bar.on(ev("fetch", 1, 4, "a.md"));
        bar.on(ev("fetch", 2, 4, "b.md"));
        bar.end();
        expect(s.lines).toHaveLength(0);
        expect(s.writes.every((w) => w.startsWith("\r"))).toBe(true);
        expect(strip(s.writes[1]!)).toContain("2/4");
        expect(strip(s.writes[1]!)).toContain("b.md");
    });

    it("degrades to one line per phase when piped", () => {
        const s = sink();
        const bar = progressRenderer(false, s);
        for (let i = 1; i <= 20; i++) bar.on(ev("fetch", i, 20, `p${i}.md`));
        for (let i = 1; i <= 20; i++) bar.on(ev("push", i, 20, `p${i}.md`));
        bar.end();
        expect(s.writes).toHaveLength(0);
        expect(s.lines).toHaveLength(2);
        expect(s.lines[0]).toContain("fetch");
        expect(s.lines[1]).toContain("push");
    });

    it("reports errors even when piped", () => {
        const s = sink();
        const bar = progressRenderer(false, s);
        bar.on({ phase: "fetch", event: "error", done: 1, total: 2, path: "b.md", message: "boom" });
        expect(s.lines.join("\n")).toContain("boom");
    });
});

// ── --dry-run ────────────────────────────────────────────────────────────

describe("knowledge tap --dry-run", () => {
    it("prints the preview and writes nothing", async () => {
        await knowledgeCommand(config, ["knowledge", "tap", SITE, "--dry-run"]);
        const text = out.join("\n");
        expect(text).toContain("PATH");
        expect(text).toContain("index.md");
        expect(text).toContain("about.md");
        expect(text).toContain("3 to index");
        expect(text).toContain("nothing was written");
        // The only requests that left went to the site itself.
        expect(calls.every((u) => u.startsWith(SITE))).toBe(true);
        expect(calls.some((u) => u.includes("/api/knowledge"))).toBe(false);
    });

    it("honours --exclude and --limit", async () => {
        await knowledgeCommand(config, ["knowledge", "tap", SITE, "--dry-run", "--exclude=/blog/"]);
        const text = out.join("\n");
        expect(text).toContain("EXCL");
        expect(text).toContain("2 to index");
        expect(calls).not.toContain(`${SITE}/blog/one`);
    });

    it("emits machine-readable JSON with --json", async () => {
        await knowledgeCommand({ ...config, json: true }, ["knowledge", "tap", SITE, "--dry-run"]);
        const parsed = JSON.parse(out.join("\n"));
        expect(parsed.startUrl).toBe(SITE);
        expect(parsed.source).toBe("sitemap");
        expect(parsed.totals.included).toBe(3);
        expect(parsed.pages).toHaveLength(3);
        // keepContent is off for a dry run, and the JSON never carries prose.
        expect(parsed.pages[0].markdown).toBeUndefined();
    });
});

// ── tap for real, then sync ──────────────────────────────────────────────

describe("knowledge tap --yes", () => {
    it("creates 'site: <hostname>' when no kbId is given, and reports the id", async () => {
        await knowledgeCommand(config, ["knowledge", "tap", SITE, "--yes"]);
        const created = [...kb.kbs.values()];
        expect(created).toHaveLength(1);
        expect(created[0]!.name).toBe("site: ex.com");
        const text = out.join("\n");
        expect(text).toContain(created[0]!.id);
        expect(text).toContain("pushed: 3");
        // The manifest lives in the KB, next to the three pages.
        const docs = kb.docs.get(created[0]!.id)!;
        expect(docs.map((d) => d.path).sort()).toEqual(
            ["_tap-manifest.json", "about.md", "blog__one.md", "index.md"],
        );
        expect(kb.reindexed).toBe(1);
        // The site was crawled once — the approved plan carried its own prose.
        expect(calls.filter((u) => u === `${SITE}/about`)).toHaveLength(1);
    });

    it("--no-reindex pushes without rebuilding the index", async () => {
        await knowledgeCommand(config, ["knowledge", "tap", SITE, "--yes", "--no-reindex"]);
        expect(kb.reindexed).toBe(0);
    });
});

describe("knowledge sync", () => {
    async function tapFirst(): Promise<string> {
        await knowledgeCommand(config, ["knowledge", "tap", SITE, "--yes"]);
        out = [];
        return [...kb.kbs.keys()][0]!;
    }

    it("reports zero delta and skips the reindex when nothing moved", async () => {
        const id = await tapFirst();
        kb.reindexed = 0;
        await knowledgeCommand(config, ["knowledge", "sync", id]);
        expect(out.join("\n")).toContain("up to date — reindex skipped");
        expect(kb.reindexed).toBe(0);
    });

    it("applies the delta when the site changed", async () => {
        const id = await tapFirst();
        kb.reindexed = 0;
        ROUTES[`${SITE}/about`] = () => html(page("About, rewritten", 500), `${SITE}/about`);
        try {
            await knowledgeCommand(config, ["knowledge", "sync", id]);
        } finally {
            ROUTES[`${SITE}/about`] = () => html(page("About", 400), `${SITE}/about`);
        }
        const text = out.join("\n");
        expect(text).toContain("updated: 1");
        expect(text).toContain("skipped: 2");
        expect(kb.reindexed).toBe(1);
    });

    it("tells the user to tap first when the KB was never tapped", async () => {
        const fresh = kb.handle("/api/knowledge", { method: "POST", body: JSON.stringify({ name: "empty" }) })!;
        const id = JSON.parse(await fresh.text()).knowledgeBase.id;
        const exit = vi.spyOn(process, "exit").mockImplementation((() => {
            throw new Error("exit");
        }) as never);
        await expect(knowledgeCommand(config, ["knowledge", "sync", id])).rejects.toThrow("exit");
        expect(errs.join("\n")).toContain("never tapped");
        expect(errs.join("\n")).toContain("knowledge tap");
        exit.mockRestore();
    });
});

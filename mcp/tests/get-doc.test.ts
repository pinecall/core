/**
 * get_doc — path resolution, the truncation cap, the structured miss, and the
 * live contract against the real Pinecall Docs KB.
 *
 * The live tests run only when PINECALL_API_KEY is in the env; they are the
 * ones that prove the KB really serves document content.
 */

import { describe, it, expect } from "vitest";
import getDoc, {
    MAX_CHARS,
    normalizePath,
    findDoc,
    frontmatterTitle,
    type GetDocResult,
    type GetDocMiss,
} from "../src/tools/get-doc.js";
import { DOCS_KB_ID } from "../src/tools/docs-search.js";
import { Session } from "../src/session.js";

const CATALOG = [
    { id: "d1", path: "guides/call-log.md", title: "call-log", bytes: 6832 },
    { id: "d2", path: "api/call.md", title: "call", bytes: 100 },
    { id: "d3", path: "web/core/overview.md", title: "overview", bytes: 200 },
    { id: "d4", path: "web/widget/overview.md", title: "overview", bytes: 300 },
];

/** A Session stand-in serving the two KB endpoints out of CATALOG. */
function stubSession(texts: Record<string, string>, hits: any[] = []) {
    const calls: string[] = [];
    const session = {
        calls,
        async playground(path: string) {
            calls.push(path);
            if (path === `/knowledge/${DOCS_KB_ID}`) return { docs: CATALOG };
            if (path.endsWith("/query")) return { hits };
            const id = path.split("/").pop()!;
            return { doc: { id, text: texts[id] ?? "" } };
        },
    };
    return session as unknown as Session & { calls: string[] };
}

describe("get_doc", () => {
    it("normalizes a path: no ./, no leading /, no .md, case-insensitive", () => {
        for (const p of ["guides/call-log", "guides/call-log.md", "./guides/call-log.md", "/Guides/Call-Log"]) {
            expect(normalizePath(p)).toBe("guides/call-log");
        }
    });

    it("resolves a path with or without .md, and a UNIQUE basename", () => {
        expect(findDoc(CATALOG, "guides/call-log")?.id).toBe("d1");
        expect(findDoc(CATALOG, "guides/call-log.md")?.id).toBe("d1");
        expect(findDoc(CATALOG, "call-log")?.id).toBe("d1");
        // "overview" is ambiguous (web/core + web/widget) — refuse rather than guess.
        expect(findDoc(CATALOG, "overview")).toBeUndefined();
        expect(findDoc(CATALOG, "")).toBeUndefined();
    });

    it("prefers the frontmatter title over the KB's filename title", async () => {
        const session = stubSession({ d1: '---\ntitle: "The Call Log"\ndescription: "x"\n---\n\n# The Call Log\n' });
        const res = (await getDoc.handler({ path: "guides/call-log" }, { session })) as GetDocResult;
        expect(res.title).toBe("The Call Log");
        expect(res.path).toBe("guides/call-log.md");
        expect(res.truncated).toBe(false);
        expect(res.markdown).toContain("# The Call Log");
        expect(session.calls).toEqual([`/knowledge/${DOCS_KB_ID}`, `/knowledge/${DOCS_KB_ID}/docs/d1`]);
    });

    it("falls back to the KB title when there is no frontmatter", async () => {
        const session = stubSession({ d2: "# Call\n" });
        const res = (await getDoc.handler({ path: "api/call" }, { session })) as GetDocResult;
        expect(res.title).toBe("call");
        expect(frontmatterTitle("# Call\n")).toBeUndefined();
        expect(frontmatterTitle("---\nno title here\n---\n")).toBeUndefined();
    });

    it("caps the markdown at MAX_CHARS and says so", async () => {
        const session = stubSession({ d1: "x".repeat(MAX_CHARS + 500) });
        const res = (await getDoc.handler({ path: "guides/call-log" }, { session })) as GetDocResult;
        expect(res.markdown).toHaveLength(MAX_CHARS);
        expect(res.truncated).toBe(true);
    });

    it("answers an unknown path with a structured error + nearest matches, not a throw", async () => {
        const session = stubSession({}, [{ doc_path: "guides/call-log.md", text: "…", score: 0.9 }]);
        const miss = (await getDoc.handler({ path: "guides/calls-logs" }, { session })) as GetDocMiss;
        expect(miss.error).toContain("guides/calls-logs");
        expect(miss.path).toBe("guides/calls-logs");
        expect(miss.suggestions.map((s) => s.path)).toContain("guides/call-log.md");
        expect(miss.suggestions.length).toBeGreaterThan(0);
    });

    it("still suggests literal path matches when docs_search itself fails", async () => {
        const broken = {
            async playground(path: string) {
                if (path === `/knowledge/${DOCS_KB_ID}`) return { docs: CATALOG };
                throw new Error("search is down");
            },
        } as unknown as Session;
        const miss = (await getDoc.handler({ path: "guides/nope" }, { session: broken })) as GetDocMiss;
        expect(miss.suggestions.map((s) => s.path)).toContain("guides/call-log.md");
    });

    const live = process.env.PINECALL_API_KEY ? it : it.skip;

    live("returns the REAL full markdown of guides/call-log", async () => {
        const session = new Session(process.env, "/pinecall-tests-no-home");
        const res = (await getDoc.handler({ path: "guides/call-log" }, { session })) as GetDocResult;
        expect(res.path).toBe("guides/call-log.md");
        expect(res.title).toBe("The Call Log");
        expect(res.truncated).toBe(false);
        // The whole page, not a snippet: front and back are both present.
        expect(res.markdown).toContain("append-only log");
        expect(res.markdown.length).toBeGreaterThan(3000);
    });

    live("answers a bogus path with suggestions instead of crashing", async () => {
        const session = new Session(process.env, "/pinecall-tests-no-home");
        const miss = (await getDoc.handler({ path: "guides/does-not-exist" }, { session })) as GetDocMiss;
        expect(miss.error).toBeTruthy();
        expect(miss.suggestions.length).toBeGreaterThan(0);
        for (const s of miss.suggestions) expect(s.path).toMatch(/\.mdx?$/);
    });
});

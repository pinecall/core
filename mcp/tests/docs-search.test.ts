/**
 * docs_search — the mapping from the KB's hit shape to the tool result, and
 * the live contract against the real Pinecall Docs KB.
 *
 * The live test runs only when PINECALL_API_KEY is in the env; it is the one
 * that actually proves the endpoint and the KB id.
 */

import { describe, it, expect } from "vitest";
import docsSearch, { DOCS_KB_ID, type DocsHit } from "../src/tools/docs-search.js";
import { Session } from "../src/session.js";

/** A Session stand-in: records the call, returns a canned KB payload. */
function stubSession(payload: unknown) {
    const calls: Array<{ path: string; body: any }> = [];
    const session = {
        calls,
        async playground(path: string, init?: RequestInit) {
            calls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
            return payload;
        },
    };
    return session as unknown as Session & { calls: typeof calls };
}

describe("docs_search", () => {
    it("hits the same endpoint the CLI's `knowledge query` does", async () => {
        const session = stubSession({ hits: [] });
        await docsSearch.handler({ query: "tools", limit: 3 }, { session });
        expect(session.calls[0].path).toBe(`/knowledge/${DOCS_KB_ID}/query`);
        expect(session.calls[0].body).toEqual({ query: "tools", k: 3 });
    });

    it("defaults to 6 results", async () => {
        const session = stubSession({ hits: [] });
        await docsSearch.handler({ query: "tools" }, { session });
        expect(session.calls[0].body.k).toBe(6);
    });

    it("maps a hit to {title, path, snippet, score} and collapses whitespace", async () => {
        const session = stubSession({
            hits: [
                {
                    doc_title: "call-log",
                    heading: "The Call Log",
                    doc_path: "guides/call-log.md",
                    text: "Every call is\n an  append-only log.",
                    score: 1.09,
                },
                { doc_path: "api/call.md", text: "x", score: 0.5 },
            ],
        });
        const hits = (await docsSearch.handler({ query: "call log cursor" }, { session })) as DocsHit[];
        expect(hits).toEqual([
            {
                title: "call-log › The Call Log",
                path: "guides/call-log.md",
                snippet: "Every call is an append-only log.",
                score: 1.09,
            },
            { title: "api/call.md", path: "api/call.md", snippet: "x", score: 0.5 },
        ]);
    });

    it("returns an empty list — never throws — when the KB has no hits", async () => {
        const session = stubSession({ hits: [] });
        await expect(docsSearch.handler({ query: "nothing" }, { session })).resolves.toEqual([]);

        const missing = stubSession({});
        await expect(docsSearch.handler({ query: "nothing" }, { session: missing })).resolves.toEqual([]);

        const blank = stubSession({ hits: [{ doc_path: "a" }] });
        expect(await docsSearch.handler({ query: "   " }, { session: blank })).toEqual([]);
        expect(blank.calls).toHaveLength(0);
    });

    const live = process.env.PINECALL_API_KEY ? it : it.skip;

    live("finds guides/call-log at the top of the REAL docs KB", async () => {
        const session = new Session(process.env, "/pinecall-tests-no-home");
        const hits = (await docsSearch.handler({ query: "call log cursor" }, { session })) as DocsHit[];
        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0].path).toBe("guides/call-log.md");
        expect(hits[0].snippet).toBeTruthy();
        expect(hits[0].score).toBeGreaterThan(hits[1].score);
    });

    live("answers a garbage query with a list, not an error", async () => {
        const session = new Session(process.env, "/pinecall-tests-no-home");
        const hits = (await docsSearch.handler(
            { query: "asdkjhasd qwiuey zxcvbnm 88888", limit: 3 },
            { session },
        )) as DocsHit[];
        expect(Array.isArray(hits)).toBe(true);
        expect(hits.length).toBeLessThanOrEqual(3);
        // Nearest-neighbour retrieval always answers; the separation is in the score.
        for (const h of hits) expect(h.score).toBeLessThan(1);
    });
});

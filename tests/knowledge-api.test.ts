/**
 * Knowledge REST client — the wire shapes the CLI already speaks, now public.
 *
 * The two things worth pinning: 402 is a paid-feature refusal and must arrive
 * as a typed, catchable error (a consumer offers an upgrade; it does not grep
 * a message), and `pushDoc` must send the caller's `path` verbatim, because
 * the server upserts on it — mangle the path and a re-push duplicates the doc
 * instead of updating it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
    KnowledgeApiError,
    listKnowledgeBases,
    createKnowledgeBase,
    getKnowledgeBase,
    deleteKnowledgeBase,
    reindexKnowledge,
    pushDoc,
    pushDocs,
    getDoc,
    deleteDoc,
    queryKnowledge,
} from "../src/api/knowledge.js";

const opts = { apiKey: "pk_test", playgroundUrl: "https://pg.test/" };

function ok(body: unknown): Response {
    return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

function fail(status: number, body = ""): Response {
    return {
        ok: false,
        status,
        statusText: "Error",
        json: async () => ({}),
        text: async () => body,
    } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const lastCall = () => fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];

describe("knowledge client — happy paths", () => {
    it("lists knowledge bases, and strips the base URL's trailing slash", async () => {
        fetchMock.mockResolvedValue(ok({ knowledgeBases: [{ id: "a", name: "Docs", docCount: 2, status: "ready" }] }));
        const kbs = await listKnowledgeBases(opts);
        expect(kbs).toEqual([{ id: "a", name: "Docs", docCount: 2, status: "ready" }]);
        const [url, init] = lastCall();
        expect(url).toBe("https://pg.test/api/knowledge");
        expect(init.method).toBe("GET");
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer pk_test");
    });

    it("returns [] when the server omits knowledgeBases", async () => {
        fetchMock.mockResolvedValue(ok({}));
        expect(await listKnowledgeBases(opts)).toEqual([]);
    });

    it("creates a knowledge base and unwraps knowledgeBase", async () => {
        fetchMock.mockResolvedValue(ok({ knowledgeBase: { id: "kb1", name: "Docs", docCount: 0, status: "empty" } }));
        const kb = await createKnowledgeBase(opts, "Docs", "the manual");
        expect(kb.id).toBe("kb1");
        const [url, init] = lastCall();
        expect(url).toBe("https://pg.test/api/knowledge");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body as string)).toEqual({ name: "Docs", description: "the manual" });
    });

    it("gets a knowledge base with its docs, defaulting docs to []", async () => {
        fetchMock.mockResolvedValue(ok({ knowledgeBase: { id: "kb1", name: "Docs", docCount: 0, status: "ready" } }));
        const { knowledgeBase, docs } = await getKnowledgeBase(opts, "kb1");
        expect(knowledgeBase.id).toBe("kb1");
        expect(docs).toEqual([]);
        expect(lastCall()[0]).toBe("https://pg.test/api/knowledge/kb1");
    });

    it("gets one doc's text", async () => {
        fetchMock.mockResolvedValue(ok({ doc: { id: "d1", path: "docs/a.md", title: "a", bytes: 3, text: "hi" } }));
        const doc = await getDoc(opts, "kb1", "d1");
        expect(doc.text).toBe("hi");
        expect(lastCall()[0]).toBe("https://pg.test/api/knowledge/kb1/docs/d1");
    });

    it("deletes a doc, a KB, and triggers a reindex", async () => {
        fetchMock.mockResolvedValue(ok({}));
        await deleteDoc(opts, "kb1", "d1");
        expect(lastCall()).toMatchObject(["https://pg.test/api/knowledge/kb1/docs/d1", { method: "DELETE" }]);
        await deleteKnowledgeBase(opts, "kb1");
        expect(lastCall()).toMatchObject(["https://pg.test/api/knowledge/kb1", { method: "DELETE" }]);
        await reindexKnowledge(opts, "kb1");
        expect(lastCall()).toMatchObject(["https://pg.test/api/knowledge/kb1/reindex", { method: "POST" }]);
    });

    it("queries with a default k of 6, and returns [] when there are no hits", async () => {
        fetchMock.mockResolvedValue(ok({}));
        expect(await queryKnowledge(opts, "kb1", "how do I ship?")).toEqual([]);
        const [url, init] = lastCall();
        expect(url).toBe("https://pg.test/api/knowledge/kb1/query");
        expect(JSON.parse(init.body as string)).toEqual({ query: "how do I ship?", k: 6 });
    });

    it("honours an explicit k", async () => {
        fetchMock.mockResolvedValue(ok({ hits: [{ score: 0.9, text: "chunk", doc_path: "a.md" }] }));
        const hits = await queryKnowledge(opts, "kb1", "q", { k: 2 });
        expect(hits[0].score).toBe(0.9);
        expect(JSON.parse(lastCall()[1].body as string).k).toBe(2);
    });
});

describe("pushDoc — path is the upsert key", () => {
    it("sends path, title and text verbatim", async () => {
        fetchMock.mockResolvedValue(ok({ doc: { id: "d1", path: "docs/guides/a.md", title: "a", bytes: 2 } }));
        const doc = await pushDoc(opts, "kb1", { path: "docs/guides/a.md", title: "a", text: "hi" });
        expect(doc.id).toBe("d1");
        const [url, init] = lastCall();
        expect(url).toBe("https://pg.test/api/knowledge/kb1/docs");
        expect(JSON.parse(init.body as string)).toEqual({ path: "docs/guides/a.md", title: "a", text: "hi" });
    });

    it("pushDocs reports per-doc results and does not abort the batch", async () => {
        fetchMock
            .mockResolvedValueOnce(ok({ doc: { id: "d1", path: "a.md", title: "a", bytes: 1 } }))
            .mockResolvedValueOnce(fail(500, "boom"))
            .mockResolvedValueOnce(ok({ doc: { id: "d3", path: "c.md", title: "c", bytes: 1 } }));
        const results = await pushDocs(opts, "kb1", [
            { path: "a.md", text: "1" },
            { path: "b.md", text: "2" },
            { path: "c.md", text: "3" },
        ]);
        expect(results.map((r) => [r.path, r.ok])).toEqual([["a.md", true], ["b.md", false], ["c.md", true]]);
        expect(results[1].error).toBeInstanceOf(KnowledgeApiError);
        expect((results[1].error as KnowledgeApiError).status).toBe(500);
    });
});

describe("errors", () => {
    it("maps HTTP 402 to a typed UPGRADE_REQUIRED error", async () => {
        fetchMock.mockResolvedValue(fail(402));
        const err = await listKnowledgeBases(opts).catch((e) => e);
        expect(err).toBeInstanceOf(KnowledgeApiError);
        expect(err).toBeInstanceOf(Error);
        expect(err.code).toBe("UPGRADE_REQUIRED");
        expect(err.status).toBe(402);
    });

    it("maps 402 on every verb, not just the listing", async () => {
        fetchMock.mockResolvedValue(fail(402));
        for (const run of [
            () => createKnowledgeBase(opts, "x"),
            () => pushDoc(opts, "kb1", { path: "a.md", text: "t" }),
            () => queryKnowledge(opts, "kb1", "q"),
            () => reindexKnowledge(opts, "kb1"),
        ]) {
            await expect(run()).rejects.toMatchObject({ code: "UPGRADE_REQUIRED", status: 402 });
        }
    });

    it("carries the server's status and body on other failures", async () => {
        fetchMock.mockResolvedValue(fail(404, "no such kb"));
        const err = await getKnowledgeBase(opts, "nope").catch((e) => e);
        expect(err.status).toBe(404);
        expect(err.message).toContain("no such kb");
        expect(err.code).toBeUndefined();
    });

    it("turns an unreachable playground into NETWORK_ERROR", async () => {
        fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
        const err = await listKnowledgeBases(opts).catch((e) => e);
        expect(err).toBeInstanceOf(KnowledgeApiError);
        expect(err.code).toBe("NETWORK_ERROR");
        expect(err.status).toBe(0);
    });
});

describe("base URL resolution", () => {
    it("falls back to PINECALL_PLAYGROUND_URL, then to the public default", async () => {
        fetchMock.mockResolvedValue(ok({ knowledgeBases: [] }));
        const prev = process.env.PINECALL_PLAYGROUND_URL;

        process.env.PINECALL_PLAYGROUND_URL = "http://localhost:3000";
        await listKnowledgeBases({ apiKey: "pk" });
        expect(lastCall()[0]).toBe("http://localhost:3000/api/knowledge");

        delete process.env.PINECALL_PLAYGROUND_URL;
        await listKnowledgeBases({ apiKey: "pk" });
        expect(lastCall()[0]).toBe("https://playground.pinecall.io/api/knowledge");

        if (prev === undefined) delete process.env.PINECALL_PLAYGROUND_URL;
        else process.env.PINECALL_PLAYGROUND_URL = prev;
    });
});

/**
 * knowledge — unit tests against a stub Playground.
 *
 * The handler is exercised directly with a Session pointed at a local HTTP
 * server that records what the tool actually sent. What is pinned here is the
 * CONTRACT: the CLI's endpoints, the shape of a query hit, idempotency by path,
 * and — the security one — that `push` never reads a local filesystem path.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import knowledge from "../src/tools/knowledge.js";
import { Session } from "../src/session.js";

interface Seen { method: string; url: string; body: any }
const seen: Seen[] = [];
let server: http.Server;
let session: Session;

const KB_ONE = { id: "aaaaaaaaaaaaaaaaaaaaaaaa", name: "Pinecall Docs", docCount: 12, status: "ready" };
const KB_TWO = { id: "bbbbbbbbbbbbbbbbbbbbbbbb", name: "Scratch", docCount: 0, status: "empty" };

beforeAll(async () => {
    server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
            const body = raw ? JSON.parse(raw) : undefined;
            seen.push({ method: req.method!, url: req.url!, body });
            res.setHeader("Content-Type", "application/json");
            if (req.url === "/api/knowledge") {
                res.end(JSON.stringify({ knowledgeBases: [KB_ONE, KB_TWO] }));
            } else if (req.url?.endsWith("/query")) {
                res.end(JSON.stringify({
                    hits: [{
                        doc_title: "Pricing", heading: "Plans", doc_path: "docs/pricing.md",
                        text: "  Starter   is\n$29 " + "x".repeat(600), score: 0.812345,
                    }],
                }));
            } else if (req.url?.endsWith("/docs")) {
                res.end(JSON.stringify({ doc: { id: "doc_1" } }));
            } else {
                res.statusCode = 404;
                res.end("{}");
            }
        });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    session = new Session({
        PINECALL_API_KEY: "pk_test_key_123456",
        PINECALL_PLAYGROUND_URL: `http://127.0.0.1:${port}`,
    } as NodeJS.ProcessEnv);
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const call = (args: any) => knowledge.handler(args, { session });

describe("knowledge tool", () => {
    it("is registered with the three spec'd actions", async () => {
        const { tools } = await import("../src/tools/index.js");
        expect(tools.map((t) => t.name)).toContain("knowledge");
        expect((knowledge.schema as any).action.options).toEqual(["list", "query", "push"]);
    });

    it("list hits GET /knowledge and returns small rows", async () => {
        seen.length = 0;
        const res: any = await call({ action: "list" });
        expect(seen[0]).toMatchObject({ method: "GET", url: "/api/knowledge" });
        expect(res.knowledgeBases).toEqual([
            { id: KB_ONE.id, name: "Pinecall Docs", docs: 12, status: "ready" },
            { id: KB_TWO.id, name: "Scratch", docs: 0, status: "empty" },
        ]);
    });

    it("query posts { query, k } and returns ranked {title, path, snippet, score}", async () => {
        seen.length = 0;
        const res: any = await call({ action: "query", kb: KB_ONE.id, query: "how much is starter", k: 3 });
        const post = seen.find((s) => s.method === "POST")!;
        expect(post.url).toBe(`/api/knowledge/${KB_ONE.id}/query`);
        expect(post.body).toEqual({ query: "how much is starter", k: 3 });
        const hit = res.hits[0];
        expect(hit.title).toBe("Pricing › Plans");
        expect(hit.path).toBe("docs/pricing.md");
        expect(hit.score).toBe(0.8123);
        expect(hit.snippet.startsWith("Starter is $29")).toBe(true); // whitespace collapsed
        expect(hit.snippet.length).toBeLessThanOrEqual(400);
        expect(hit.truncated).toBe(true);
    });

    it("resolves a KB by exact name, and refuses an unknown one by listing the real ones", async () => {
        const res: any = await call({ action: "query", kb: "Scratch", query: "x" });
        expect(res.kb).toBe(KB_TWO.id);
        await expect(call({ action: "query", kb: "Nope", query: "x" })).rejects.toThrow(/No knowledge base named/);
    });

    it("refuses to guess when the org has several KBs and none was named", async () => {
        await expect(call({ action: "query", query: "x" })).rejects.toThrow(/2 knowledge bases/);
    });

    it("push sends {path, title, text} per doc — content comes from the caller, never from disk", async () => {
        seen.length = 0;
        const res: any = await call({
            action: "push",
            kb: KB_TWO.id,
            docs: [{ path: "./docs/a.md", content: "hello" }, { path: "b.txt", content: "world", title: "Bee" }],
        });
        const posts = seen.filter((s) => s.method === "POST");
        expect(posts.map((p) => p.body)).toEqual([
            { path: "docs/a.md", title: "a", text: "hello" },
            { path: "b.txt", title: "Bee", text: "world" },
        ]);
        expect(res).toMatchObject({ kb: KB_TWO.id, pushed: 2, total: 2 });
        expect(res.note).toMatch(/Idempotent by path/);
    });

    it("push has no way to name a local file: the schema requires inline content", () => {
        const shape = (knowledge.schema as any).docs;
        const parsed = shape.safeParse([{ path: "docs/a.md" }]);
        expect(parsed.success).toBe(false); // no content → rejected, so no path-read fallback exists
        expect(JSON.stringify(knowledge.handler.toString())).not.toMatch(/readFileSync|readFile\(/);
    });

    it("query without a question and push without docs both explain the fix", async () => {
        await expect(call({ action: "query", kb: KB_ONE.id })).rejects.toThrow(/needs `query`/);
        await expect(call({ action: "push", kb: KB_ONE.id, docs: [] })).rejects.toThrow(/needs `docs`/);
    });

    it("the manual states the two rules the spec asks for", () => {
        expect(knowledge.manual).toMatch(/idempotent by `path`/i);
        expect(knowledge.manual).toMatch(/automatic/i);
        expect(knowledge.manual).toMatch(/RAG/);
    });
});

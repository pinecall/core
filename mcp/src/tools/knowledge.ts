/**
 * knowledge — the org's knowledge bases (RAG), as one tool with three actions.
 *
 * Same endpoints the CLI's `pinecall knowledge` uses (src/cli/commands/knowledge.ts),
 * called through the session's Playground fetch — no second HTTP client:
 *   list   GET  /knowledge
 *   query  POST /knowledge/:kb/query      { query, k }  → hits
 *   push   POST /knowledge/:kb/docs       { path, title, text }
 *
 * `push` deliberately takes {path, content} PAIRS. The MCP client supplies the
 * content; this server never reads a local filesystem path, so an agent cannot
 * use it to exfiltrate arbitrary files off the machine running the server.
 */

import { z } from "zod";
import { defineTool } from "./types.js";
import type { Session } from "../session.js";

/** A Mongo ObjectId — the shape of a kbId. */
const KB_ID = /^[a-f0-9]{24}$/i;

interface Kb { id: string; name?: string; docCount?: number; status?: string }

async function listKbs(session: Session): Promise<Kb[]> {
    const data = await session.playground<any>("/knowledge");
    return data.knowledgeBases ?? [];
}

/**
 * Resolve which KB to act on. An explicit id wins; a name is matched
 * case-insensitively; omitted resolves only when the org has exactly one.
 */
async function resolveKb(session: Session, kb: string | undefined): Promise<string> {
    if (kb && KB_ID.test(kb)) return kb;
    const kbs = await listKbs(session);
    if (!kbs.length) {
        throw new Error(
            "This org has no knowledge bases. Create one with the CLI: " +
            'pinecall knowledge create "<name>" — then pass its id as `kb`.',
        );
    }
    if (kb) {
        const hits = kbs.filter((k) => (k.name ?? "").toLowerCase() === kb.toLowerCase());
        if (hits.length === 1) return hits[0].id;
        if (hits.length > 1) throw new Error(`"${kb}" matches ${hits.length} knowledge bases — pass the id instead.`);
        throw new Error(
            `No knowledge base named "${kb}". Available: ` +
            kbs.map((k) => `${k.name} (${k.id})`).join(", "),
        );
    }
    if (kbs.length === 1) return kbs[0].id;
    throw new Error(
        `This org has ${kbs.length} knowledge bases — pass \`kb\`: ` +
        kbs.map((k) => `${k.name} (${k.id})`).join(", "),
    );
}

const SNIPPET = 400;

export default defineTool({
    name: "knowledge",
    description:
        "Knowledge bases (RAG): list the org's KBs, query one for ranked chunks, or push documents into one.",
    schema: {
        action: z.enum(["list", "query", "push"]).describe("list the org's KBs · query one · push documents into one"),
        kb: z
            .string()
            .optional()
            .describe("Knowledge base id (24-hex) or exact name. Optional when the org has exactly one KB."),
        query: z.string().optional().describe("action=query: the question — semantic search, no LLM"),
        k: z.number().int().min(1).max(20).optional().describe("action=query: how many chunks (default 6)"),
        docs: z
            .array(
                z.object({
                    path: z.string().min(1).describe("Stable identifier, e.g. docs/pricing.md — push is idempotent by path"),
                    content: z.string().min(1).describe("The document text (markdown or plain text)"),
                    title: z.string().optional().describe("Human title; defaults to the path's basename"),
                }),
            )
            .optional()
            .describe("action=push: the documents, content included — this server never reads local files"),
    },
    manual: "RAG. Attach with `knowledgeBase: \"<kbId>\"`; chunks auto-inject, or place `{{RAG_CONTEXT}}`. `push` takes content YOU read, idempotent by `path`, reindexed automatically.",
    async handler(
        args: {
            action: "list" | "query" | "push";
            kb?: string;
            query?: string;
            k?: number;
            docs?: { path: string; content: string; title?: string }[];
        },
        { session },
    ) {
        if (args.action === "list") {
            const kbs = await listKbs(session);
            return {
                knowledgeBases: kbs.map((k) => ({
                    id: k.id,
                    name: k.name ?? null,
                    docs: k.docCount ?? 0,
                    status: k.status ?? "empty",
                })),
            };
        }

        if (args.action === "query") {
            const q = (args.query ?? "").trim();
            if (!q) throw new Error("action=query needs `query` — the question to search for.");
            const kbId = await resolveKb(session, args.kb);
            const data = await session.playground<any>(`/knowledge/${kbId}/query`, {
                method: "POST",
                body: JSON.stringify({ query: q, k: args.k ?? 6 }),
            });
            const hits = (data.hits ?? []) as any[];
            return {
                kb: kbId,
                hits: hits.map((h) => {
                    const text = String(h.text ?? "").replace(/\s+/g, " ").trim();
                    return {
                        title: [h.doc_title, h.heading].filter(Boolean).join(" › ") || h.doc_path || null,
                        path: h.doc_path ?? null,
                        snippet: text.slice(0, SNIPPET),
                        truncated: text.length > SNIPPET,
                        score: typeof h.score === "number" ? Number(h.score.toFixed(4)) : null,
                    };
                }),
            };
        }

        // push
        const docs = args.docs ?? [];
        if (!docs.length) {
            throw new Error("action=push needs `docs` — [{ path, content, title? }]. Read the files yourself and pass the text.");
        }
        const kbId = await resolveKb(session, args.kb);
        const pushed: { path: string; bytes: number; id?: string }[] = [];
        const failed: { path: string; error: string }[] = [];
        for (const doc of docs) {
            const path = doc.path.replace(/^\.\//, "");
            const title = doc.title ?? (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "");
            try {
                const res = await session.playground<any>(`/knowledge/${kbId}/docs`, {
                    method: "POST",
                    body: JSON.stringify({ path, title, text: doc.content }),
                });
                pushed.push({ path, bytes: doc.content.length, id: res?.doc?.id });
            } catch (err) {
                failed.push({ path, error: session.redact(err instanceof Error ? err.message : String(err)) });
            }
        }
        return {
            kb: kbId,
            pushed: pushed.length,
            total: docs.length,
            docs: pushed,
            ...(failed.length ? { failed } : {}),
            note: "Idempotent by path — the same path replaces its document. The index re-trains automatically.",
        };
    },
});

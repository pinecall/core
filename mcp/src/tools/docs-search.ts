/**
 * docs_search — semantic retrieval over the public Pinecall Docs knowledge base.
 *
 * Exactly the call `pinecall knowledge query` makes (src/cli/commands/knowledge.ts):
 * POST {playground}/api/knowledge/{kbId}/query  { query, k } -> { hits: [...] }
 * routed through the session's playground helper, so there is no second HTTP
 * client and the key stays in one place.
 */

import { z } from "zod";
import { defineTool } from "./types.js";

/** The public Pinecall Docs KB. Overridable for a fork/self-host. */
export const DOCS_KB_ID = process.env.PINECALL_DOCS_KB_ID || "6a342d8665460d8af75d5757";

const SNIPPET_CHARS = 400;

export interface DocsHit {
    title: string;
    path: string;
    snippet: string;
    score: number;
}

export default defineTool({
    name: "docs_search",
    description:
        "Search the Pinecall documentation (semantic, no LLM). Returns the top matching doc chunks with their path.",
    schema: {
        query: z.string().min(1).describe("What you want to know, in natural language, e.g. 'call log cursor'"),
        limit: z.number().int().min(1).max(20).optional().describe("How many chunks to return (default 6)"),
    },
    manual: "It locates; `get_doc` reads. Nearest-neighbour: a `score` near 1.0 clear of the rest is real, a flat ~0.8 run means the docs do not cover it.",
    async handler(args: { query: string; limit?: number }, { session }): Promise<DocsHit[]> {
        const query = args.query.trim();
        if (!query) return [];
        const k = args.limit ?? 6;

        const data = await session.playground<{ hits?: any[] }>(`/knowledge/${DOCS_KB_ID}/query`, {
            method: "POST",
            body: JSON.stringify({ query, k }),
        });

        const hits = Array.isArray(data?.hits) ? data.hits : [];
        return hits.slice(0, k).map((h): DocsHit => ({
            title: [h.doc_title, h.heading].filter(Boolean).join(" › ") || String(h.doc_path ?? ""),
            path: String(h.doc_path ?? ""),
            snippet: String(h.text ?? "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS),
            score: Number(h.score ?? 0),
        }));
    },
});

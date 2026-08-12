/**
 * get_doc — the FULL markdown of one Pinecall docs page.
 *
 * Source of truth is the SAME Playground knowledge base `docs_search` queries
 * (`DOCS_KB_ID`), so a page can never be out of sync with what search returns.
 * Probed against the live API: the KB does expose document content, so there is
 * no fetching of docs.pinecall.io and no HTML scraping anywhere.
 *
 *   GET /knowledge/:kb          -> { knowledgeBase, docs: [{ id, path, title, bytes }] }
 *   GET /knowledge/:kb/docs/:id -> { doc: { id, path, title, bytes, text } }
 *
 * No LLM: pure content retrieval. The only "intelligence" is the suggestion
 * list on a miss, which reuses `docs_search` rather than inventing a ranker.
 */

import { z } from "zod";
import { defineTool } from "./types.js";
import docsSearch, { DOCS_KB_ID, type DocsHit } from "./docs-search.js";
import type { Session } from "../session.js";

/** Cap on the returned markdown. Longer pages come back with truncated:true. */
export const MAX_CHARS = 40_000;

/** How many nearest matches an unknown path is answered with. */
const SUGGESTIONS = 5;

interface KbDoc {
    id: string;
    path: string;
    title?: string;
    bytes?: number;
}

export interface GetDocResult {
    path: string;
    title: string;
    markdown: string;
    truncated: boolean;
}

export interface GetDocMiss {
    error: string;
    path: string;
    suggestions: { path: string; title: string }[];
}

/**
 * The comparable form of a docs path: no leading `./` or `/`, no `.md`,
 * case-insensitive. `guides/call-log`, `/guides/call-log.md` and
 * `Guides/Call-Log` are the same page.
 */
export function normalizePath(path: string): string {
    return path
        .trim()
        .replace(/^\.?\//, "")
        .replace(/\.mdx?$/i, "")
        .toLowerCase();
}

async function listDocs(session: Session): Promise<KbDoc[]> {
    const data = await session.playground<{ docs?: KbDoc[] }>(`/knowledge/${DOCS_KB_ID}`);
    return Array.isArray(data?.docs) ? data.docs : [];
}

/** Exact path first; a unique basename match is accepted as a convenience. */
export function findDoc(docs: KbDoc[], wanted: string): KbDoc | undefined {
    const want = normalizePath(wanted);
    if (!want) return undefined;
    const exact = docs.find((d) => normalizePath(d.path) === want);
    if (exact) return exact;
    const base = (p: string) => normalizePath(p).split("/").pop() ?? "";
    const byBase = docs.filter((d) => base(d.path) === want);
    return byBase.length === 1 ? byBase[0] : undefined;
}

/** `title:` out of the YAML frontmatter, when the page has one. */
export function frontmatterTitle(markdown: string): string | undefined {
    if (!markdown.startsWith("---")) return undefined;
    const end = markdown.indexOf("\n---", 3);
    if (end === -1) return undefined;
    const m = markdown.slice(0, end).match(/^title:\s*(.+)$/m);
    if (!m) return undefined;
    return m[1].trim().replace(/^["']|["']$/g, "") || undefined;
}

/**
 * Nearest matches for a path that is not in the KB. Semantic hits from
 * `docs_search` first (the path text reads well as a query), then any catalog
 * path that literally contains one of the requested segments.
 */
async function nearest(session: Session, wanted: string, docs: KbDoc[]): Promise<{ path: string; title: string }[]> {
    const out = new Map<string, { path: string; title: string }>();
    const titleOf = (p: string) => docs.find((d) => d.path === p)?.title ?? "";

    try {
        const hits = (await docsSearch.handler(
            { query: normalizePath(wanted).replace(/[/-]+/g, " "), limit: SUGGESTIONS },
            { session },
        )) as DocsHit[];
        for (const h of hits) if (h.path) out.set(h.path, { path: h.path, title: titleOf(h.path) || h.title });
    } catch {
        // A miss must never become a crash: fall through to the literal match.
    }

    const segments = normalizePath(wanted).split("/").filter(Boolean);
    for (const d of docs) {
        if (out.size >= SUGGESTIONS * 2) break;
        const p = normalizePath(d.path);
        if (segments.some((s) => s.length > 2 && p.includes(s))) {
            out.set(d.path, { path: d.path, title: d.title ?? "" });
        }
    }

    return [...out.values()].slice(0, SUGGESTIONS);
}

export default defineTool({
    name: "get_doc",
    description:
        "Read a whole Pinecall docs page as markdown, by the path docs_search returned (e.g. guides/call-log).",
    schema: {
        path: z
            .string()
            .min(1)
            .describe("The doc path from a docs_search hit, e.g. guides/call-log (the .md is optional)"),
    },
    manual: [
        "**`get_doc`** — the WHOLE page. `docs_search` finds where an answer lives; `get_doc`",
        "reads it. Args: `{ path }` — the `path` off a search hit, with or without the `.md`",
        "(`guides/call-log` and `guides/call-log.md` are the same page).",
        "Returns `{ path, title, markdown, truncated }`; `truncated: true` means the page was",
        "longer than 40k chars and you are seeing the head of it.",
        "**Prefer `get_doc` over reasoning from snippets**: a search snippet is 400 chars out of",
        "the middle of a chunk, so it drops the imports, the surrounding options and the caveats —",
        "read the page before you write code against it.",
        "An unknown path is not an error you should retry blindly: it comes back as",
        "`{ error, path, suggestions: [{ path, title }] }` — pick a suggestion or search again.",
        "It reads the same knowledge base `docs_search` queries, so the two can never disagree.",
    ].join("\n"),
    async handler(args: { path: string }, { session }): Promise<GetDocResult | GetDocMiss> {
        const wanted = (args.path ?? "").trim();
        const docs = await listDocs(session);

        const doc = findDoc(docs, wanted);
        if (!doc) {
            return {
                error: `No docs page at "${wanted}". Use one of the paths below, or call docs_search again.`,
                path: wanted,
                suggestions: await nearest(session, wanted, docs),
            };
        }

        const data = await session.playground<{ doc?: { text?: string; title?: string } }>(
            `/knowledge/${DOCS_KB_ID}/docs/${doc.id}`,
        );
        const text = String(data?.doc?.text ?? "");
        const truncated = text.length > MAX_CHARS;

        return {
            path: doc.path,
            title: frontmatterTitle(text) ?? doc.title ?? data?.doc?.title ?? doc.path,
            markdown: truncated ? text.slice(0, MAX_CHARS) : text,
            truncated,
        };
    },
});

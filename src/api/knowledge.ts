/**
 * Knowledge base (RAG) REST client — the documents an agent can look things up in.
 *
 * Knowledge bases live on the PLAYGROUND API (the management plane), not on
 * the voice server: creating a KB, pushing docs and rebuilding the index are
 * account operations, and they happen whether or not any agent is online.
 * That is why this module takes its own `playgroundUrl` instead of the
 * `apiUrl` the rest of the SDK talks to.
 *
 * Knowledge bases are a paid feature. The server answers HTTP 402 for orgs on
 * a plan without them, and that arrives here as a typed
 * `KnowledgeApiError` with `code === "UPGRADE_REQUIRED"` — catchable, so a
 * consumer can offer the upgrade instead of parsing a message.
 */

import { PinecallError } from "../kernel/errors.js";

export const DEFAULT_PLAYGROUND_URL = "https://playground.pinecall.io";

// ── Types ────────────────────────────────────────────────────────────────

export interface KnowledgeBase {
    id: string;
    name: string;
    description?: string;
    docCount: number;
    status: string;
}

export interface KnowledgeDoc {
    id: string;
    path: string;
    title: string;
    bytes: number;
}

/** A document as returned by `getDoc` — the listing fields plus the text. */
export interface KnowledgeDocWithText extends KnowledgeDoc {
    text: string;
}

export interface KnowledgeHit {
    score: number;
    text: string;
    heading?: string;
    doc_title?: string;
    doc_path?: string;
}

export interface KnowledgeApiOptions {
    apiKey: string;
    /**
     * Management API base. Defaults to `PINECALL_PLAYGROUND_URL` and then to
     * https://playground.pinecall.io. Trailing slashes are stripped, so
     * "http://localhost:3000/" and "http://localhost:3000" are the same host.
     */
    playgroundUrl?: string;
}

/** A document to upsert. `path` is the identity: pushing the same path updates. */
export interface KnowledgeDocInput {
    path: string;
    title?: string;
    text: string;
}

/** One entry of a `pushDocs` batch — a failure never aborts the rest. */
export interface PushResult {
    path: string;
    ok: boolean;
    doc?: KnowledgeDoc;
    error?: Error;
}

// ── Errors ───────────────────────────────────────────────────────────────

export class KnowledgeApiError extends PinecallError {
    constructor(message: string, public status: number, code?: string) {
        super(message, code);
        this.name = "KnowledgeApiError";
    }
}

// ── Transport ────────────────────────────────────────────────────────────

function baseUrl(opts: KnowledgeApiOptions): string {
    const raw =
        opts.playgroundUrl ??
        (typeof process !== "undefined" ? process.env?.PINECALL_PLAYGROUND_URL : undefined) ??
        DEFAULT_PLAYGROUND_URL;
    return raw.replace(/\/+$/, "");
}

async function call<T>(
    opts: KnowledgeApiOptions,
    method: string,
    path: string,
    body?: unknown,
): Promise<T> {
    const url = `${baseUrl(opts)}/api/knowledge${path}`;
    let res: Response;
    try {
        res = await fetch(url, {
            method,
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${opts.apiKey}`,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    } catch (err) {
        throw new KnowledgeApiError(
            `Cannot reach the Playground at ${baseUrl(opts)}: ${(err as Error)?.message ?? err}`,
            0,
            "NETWORK_ERROR",
        );
    }

    if (res.status === 402) {
        throw new KnowledgeApiError(
            "Knowledge bases are a paid feature — upgrade to Starter or higher.",
            402,
            "UPGRADE_REQUIRED",
        );
    }

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new KnowledgeApiError(
            `knowledge ${method} ${path}: ${res.status} ${text || res.statusText}`,
            res.status,
        );
    }

    return (await res.json().catch(() => ({}))) as T;
}

// ── Knowledge bases ──────────────────────────────────────────────────────

export async function listKnowledgeBases(opts: KnowledgeApiOptions): Promise<KnowledgeBase[]> {
    const data = await call<{ knowledgeBases?: KnowledgeBase[] }>(opts, "GET", "");
    return data.knowledgeBases ?? [];
}

export async function createKnowledgeBase(
    opts: KnowledgeApiOptions,
    name: string,
    description?: string,
): Promise<KnowledgeBase> {
    const data = await call<{ knowledgeBase: KnowledgeBase }>(opts, "POST", "", { name, description });
    return data.knowledgeBase;
}

export async function getKnowledgeBase(
    opts: KnowledgeApiOptions,
    kbId: string,
): Promise<{ knowledgeBase: KnowledgeBase; docs: KnowledgeDoc[] }> {
    const data = await call<{ knowledgeBase: KnowledgeBase; docs?: KnowledgeDoc[] }>(
        opts, "GET", `/${encodeURIComponent(kbId)}`,
    );
    return { knowledgeBase: data.knowledgeBase, docs: data.docs ?? [] };
}

export async function deleteKnowledgeBase(opts: KnowledgeApiOptions, kbId: string): Promise<void> {
    await call<unknown>(opts, "DELETE", `/${encodeURIComponent(kbId)}`);
}

export async function reindexKnowledge(opts: KnowledgeApiOptions, kbId: string): Promise<void> {
    await call<unknown>(opts, "POST", `/${encodeURIComponent(kbId)}/reindex`);
}

// ── Documents ────────────────────────────────────────────────────────────

/**
 * Upsert one document. The server keys on `path`, so pushing the same path
 * twice updates the document instead of duplicating it — which is what lets a
 * consumer re-push a whole folder on every build.
 */
export async function pushDoc(
    opts: KnowledgeApiOptions,
    kbId: string,
    doc: KnowledgeDocInput,
): Promise<KnowledgeDoc> {
    const data = await call<{ doc: KnowledgeDoc }>(
        opts, "POST", `/${encodeURIComponent(kbId)}/docs`,
        { path: doc.path, title: doc.title, text: doc.text },
    );
    return data.doc;
}

/**
 * Push a batch. One bad document does not lose the other forty: every entry
 * comes back with its own ok/error, in the order given.
 */
export async function pushDocs(
    opts: KnowledgeApiOptions,
    kbId: string,
    docs: KnowledgeDocInput[],
): Promise<PushResult[]> {
    const results: PushResult[] = [];
    for (const doc of docs) {
        try {
            results.push({ path: doc.path, ok: true, doc: await pushDoc(opts, kbId, doc) });
        } catch (err) {
            results.push({ path: doc.path, ok: false, error: err as Error });
        }
    }
    return results;
}

export async function getDoc(
    opts: KnowledgeApiOptions,
    kbId: string,
    docId: string,
): Promise<KnowledgeDocWithText> {
    const data = await call<{ doc: KnowledgeDocWithText }>(
        opts, "GET", `/${encodeURIComponent(kbId)}/docs/${encodeURIComponent(docId)}`,
    );
    return data.doc;
}

export async function deleteDoc(
    opts: KnowledgeApiOptions,
    kbId: string,
    docId: string,
): Promise<void> {
    await call<unknown>(opts, "DELETE", `/${encodeURIComponent(kbId)}/docs/${encodeURIComponent(docId)}`);
}

// ── Query ────────────────────────────────────────────────────────────────

/** Retrieval only — the top `k` chunks, no LLM in the loop. */
export async function queryKnowledge(
    opts: KnowledgeApiOptions,
    kbId: string,
    query: string,
    o: { k?: number } = {},
): Promise<KnowledgeHit[]> {
    const data = await call<{ hits?: KnowledgeHit[] }>(
        opts, "POST", `/${encodeURIComponent(kbId)}/query`,
        { query, k: o.k ?? 6 },
    );
    return data.hits ?? [];
}

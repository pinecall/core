/**
 * Memory REST client — what an agent remembers about its contacts.
 *
 * Talks to `/api/memory` on the voice server with the org's API key. The
 * agent does not need to be online: memory is a store, not a session, which
 * is what lets a back office ask "which callers asked not to be phoned" long
 * after the calls ended.
 */

export interface MemoryFact {
    id: string;
    kind: string;
    text: string;
    confidence: number;
    valid_from: string;
    valid_to?: string | null;
    supersedes?: string;
    evidence?: string;
    source?: { call?: string; turn?: number; transport?: string };
}

export interface MemoryHit {
    contact: string;
    kind: string;
    text: string;
    score: number | null;
}

export interface MemoryContact {
    contact: string;
    revision: number;
    facts: MemoryFact[];
    /** The regenerated memory.md — the same text the prompt sees as {{MEMORY}}. */
    memoryMd: string;
}

export interface MemoryApiOptions {
    apiKey: string;
    apiUrl: string;
    agent: string;
}

async function call<T>(opts: MemoryApiOptions, method: string, path: string): Promise<T> {
    const res = await fetch(`${opts.apiUrl}/api/memory${path}`, {
        method,
        headers: { Authorization: `Bearer ${opts.apiKey}` },
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data.success === false) {
        throw new Error(`memory ${method} ${path}: ${res.status} ${(data.error as string) ?? res.statusText}`);
    }
    return data as T;
}

export async function memorySearch(
    opts: MemoryApiOptions,
    query: string,
    o: { contact?: string | null; k?: number } = {},
): Promise<MemoryHit[]> {
    const qs = new URLSearchParams({ agent: opts.agent, q: query, k: String(o.k ?? 6) });
    if (o.contact) qs.set("contact", o.contact);
    const data = await call<{ hits: MemoryHit[] }>(opts, "GET", `/search?${qs}`);
    return data.hits ?? [];
}

export async function memoryGet(opts: MemoryApiOptions, contact: string): Promise<MemoryContact> {
    const data = await call<{ contact: string; revision: number; facts: MemoryFact[]; memory_md: string }>(
        opts, "GET", `/${encodeURIComponent(opts.agent)}/${encodeURIComponent(contact)}`,
    );
    return { contact: data.contact, revision: data.revision, facts: data.facts ?? [], memoryMd: data.memory_md ?? "" };
}

export async function memoryForget(opts: MemoryApiOptions, contact: string): Promise<boolean> {
    const data = await call<{ forgotten: boolean }>(
        opts, "DELETE", `/${encodeURIComponent(opts.agent)}/${encodeURIComponent(contact)}`,
    );
    return Boolean(data.forgotten);
}

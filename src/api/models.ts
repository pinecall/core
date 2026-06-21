/**
 * Model access API — check whether the authenticated org can use a given
 * STT/TTS/LLM model (plan + managed/BYOK gates), before configuring an agent.
 *
 * Hits the Playground org API (authenticated with your API key), not the voice
 * server. Default base: https://playground.pinecall.io (override with
 * PINECALL_PLAYGROUND_URL or the `playgroundUrl` option).
 */

const DEFAULT_PLAYGROUND_URL = "https://playground.pinecall.io";

export type ModelAccessReason = "ok" | "unknown_model" | "plan_restricted" | "byok_key_required";

export interface ModelAccess {
    service: string;
    provider?: string;
    model: string;
    /** model is priced/known */
    exists: boolean;
    /** Pinecall serves it with its own key (no token needed) */
    managed: boolean;
    /** the model's provider is allowed on the org's plan */
    planAllowed: boolean;
    /** the org has saved its own key for this provider */
    hasKey: boolean;
    /** BYOK provider with no saved key → user must add one */
    requiresKey: boolean;
    /** final verdict: planAllowed && (managed || hasKey) */
    allowed: boolean;
    reason: ModelAccessReason;
}

export interface FetchModelAccessOptions {
    service: "stt" | "tts" | "llm";
    model: string;
    apiKey?: string;
    playgroundUrl?: string;
}

export interface ListModelAccessOptions {
    apiKey?: string;
    playgroundUrl?: string;
}

function resolveAuth(opts: { apiKey?: string; playgroundUrl?: string }) {
    const env = (typeof process !== "undefined" ? process.env : {}) as Record<string, string | undefined>;
    const apiKey = opts.apiKey ?? env.PINECALL_API_KEY;
    const base = opts.playgroundUrl ?? env.PINECALL_PLAYGROUND_URL ?? DEFAULT_PLAYGROUND_URL;
    if (!apiKey) throw new Error("fetchModelAccess: apiKey required (pass apiKey or set PINECALL_API_KEY)");
    return { apiKey, base };
}

/** Access decision for one (service, model). */
export async function fetchModelAccess(opts: FetchModelAccessOptions): Promise<ModelAccess> {
    const { apiKey, base } = resolveAuth(opts);
    const url = `${base}/api/models/access?service=${encodeURIComponent(opts.service)}&model=${encodeURIComponent(opts.model)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`Failed to check model access: HTTP ${res.status}`);
    return (await res.json()) as ModelAccess;
}

/** Convenience: true if the org can use the model. */
export async function hasModelAccess(opts: FetchModelAccessOptions): Promise<boolean> {
    return (await fetchModelAccess(opts)).allowed;
}

/** Access for every priced model the org could use. */
export async function fetchModelCatalog(opts: ListModelAccessOptions = {}): Promise<ModelAccess[]> {
    const { apiKey, base } = resolveAuth(opts);
    const res = await fetch(`${base}/api/models/access`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`Failed to list model access: HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data.models) ? (data.models as ModelAccess[]) : [];
}

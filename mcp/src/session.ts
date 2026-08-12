/**
 * Session — the one place that knows the API key.
 *
 * The key comes from PINECALL_API_KEY at boot, or from the `set_api_key`
 * tool, which stores it IN MEMORY for the life of this process only. It is
 * never written to disk, never logged, and never included in a tool result
 * (see `redact()` — every outbound error string goes through it).
 *
 * Endpoints are the SAME ones the CLI uses:
 *   · voice server  (PINECALL_URL,  default https://voice.pinecall.io) — apiFetch from the SDK
 *   · playground    (PINECALL_PLAYGROUND_URL, default https://playground.pinecall.io) — /api/orgs/me
 */

import { apiFetch, DEFAULT_API_URL } from "../../src/api/http.js";

export const DEFAULT_PLAYGROUND_URL = "https://playground.pinecall.io";

/** Thrown when a tool needs the key and there is none. Carries the fix. */
export class MissingApiKeyError extends Error {
    constructor() {
        super(
            "No Pinecall API key in this session. Set PINECALL_API_KEY in the MCP " +
            "server env, or call the `set_api_key` tool with your pk_... key " +
            "(stored in memory for this session only).",
        );
        this.name = "MissingApiKeyError";
    }
}

export class Session {
    /** In memory only. Never serialized. */
    #apiKey: string;
    readonly serverUrl: string;
    readonly playgroundUrl: string;

    constructor(env: NodeJS.ProcessEnv = process.env) {
        this.#apiKey = env.PINECALL_API_KEY ?? "";
        this.serverUrl = (env.PINECALL_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
        this.playgroundUrl = (env.PINECALL_PLAYGROUND_URL ?? DEFAULT_PLAYGROUND_URL).replace(/\/+$/, "");
    }

    hasApiKey(): boolean {
        return this.#apiKey.length > 0;
    }

    /** The only reader. Throws the actionable error instead of returning "". */
    apiKey(): string {
        if (!this.#apiKey) throw new MissingApiKeyError();
        return this.#apiKey;
    }

    /** `set_api_key`. Returns nothing — a caller must not be able to read it back. */
    setApiKey(key: string): void {
        this.#apiKey = key.trim();
    }

    /**
     * Scrub the key out of any string before it leaves the process.
     * Belt and braces: an upstream 401 body could quote the credential.
     */
    redact(text: string): string {
        let out = text;
        if (this.#apiKey) out = out.split(this.#apiKey).join("[redacted]");
        return out.replace(/\bpk_[A-Za-z0-9_-]{6,}/g, "pk_[redacted]");
    }

    /** GET on the voice server — reuses the SDK's apiFetch, no second HTTP client. */
    async server<T = any>(path: string, query?: Record<string, string>): Promise<T> {
        const res = await apiFetch(path, { apiUrl: this.serverUrl, apiKey: this.apiKey(), query });
        if (!res.ok) throw new Error(`Pinecall ${res.status} on ${path}: ${await res.text()}`);
        return res.json() as Promise<T>;
    }

    /** GET on the Playground API — the same base the CLI's `account`/`balance` use. */
    async playground<T = any>(path: string, init?: RequestInit): Promise<T> {
        const url = `${this.playgroundUrl}/api${path}`;
        const res = await fetch(url, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.apiKey()}`,
                ...(init?.headers as Record<string, string> | undefined),
            },
        });
        if (!res.ok) throw new Error(`Playground ${res.status} on ${path}: ${await res.text()}`);
        return res.json() as Promise<T>;
    }
}

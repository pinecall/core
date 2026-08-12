/**
 * Session — the one place that knows the API key.
 *
 * At boot the key is resolved by `resolveApiKey()` (see credentials.ts):
 * env → ~/.pinecall/credentials → a read-only scan of the shell rc files.
 * It can also arrive from the `set_api_key` tool, which stores it IN MEMORY
 * for the life of this process — and writes the credentials store only when
 * asked with `persist`. The key is never logged and never included in a tool
 * result (see `redact()` — every outbound error string goes through it).
 *
 * Endpoints are the SAME ones the CLI uses:
 *   · voice server  (PINECALL_URL,  default https://voice.pinecall.io) — apiFetch from the SDK
 *   · playground    (PINECALL_PLAYGROUND_URL, default https://playground.pinecall.io) — /api/orgs/me
 */

import { homedir } from "node:os";
import { apiFetch, DEFAULT_API_URL } from "../../src/api/http.js";
import { resolveApiKey, writeCredentials, type KeySource } from "./credentials.js";

export const DEFAULT_PLAYGROUND_URL = "https://playground.pinecall.io";

/** Thrown when a tool needs the key and there is none. Carries the fix. */
export class MissingApiKeyError extends Error {
    constructor() {
        super(
            "No Pinecall API key in this session. Looked in PINECALL_API_KEY, " +
            "~/.pinecall/credentials, and the shell rc files (~/.zshenv, ~/.zshrc, " +
            "~/.bash_profile, ~/.bashrc, ~/.profile) — an IDE spawns this server " +
            "without your shell, so an `export` in a terminal does not reach it. " +
            "Fix it by setting PINECALL_API_KEY in the MCP server's env block, or " +
            "call the `set_api_key` tool with your pk_... key (add persist: true to " +
            "save it to ~/.pinecall/credentials, mode 0600, for next time).",
        );
        this.name = "MissingApiKeyError";
    }
}

export class Session {
    /** In memory only. Never serialized. */
    #apiKey: string;
    /** The home dir the credentials store lives under — overridable for tests. */
    readonly #home: string;
    readonly serverUrl: string;
    readonly playgroundUrl: string;

    /** Where the current key came from. Reported by `whoami`, never the key itself. */
    keySource: KeySource;
    /** True when an rc-file hit was copied into ~/.pinecall/credentials at boot. */
    keyPersisted: boolean;
    /** The rc file a "shell-rc" hit came from — a path, not a secret. */
    keyRcFile?: string;

    constructor(env: NodeJS.ProcessEnv = process.env, home: string = homedir()) {
        this.#home = home;
        const resolved = resolveApiKey(env, home);
        this.#apiKey = resolved.apiKey;
        this.keySource = resolved.source;
        this.keyPersisted = resolved.persisted;
        this.keyRcFile = resolved.rcFile;
        this.serverUrl = (env.PINECALL_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
        this.playgroundUrl = (env.PINECALL_PLAYGROUND_URL ?? DEFAULT_PLAYGROUND_URL).replace(/\/+$/, "");
    }

    /** A one-line, key-free note about where the key came from — or null. */
    keyNotice(): string | null {
        if (this.keySource !== "shell-rc") return null;
        return this.keyPersisted
            ? `Key was not in this server's env — found by reading ${this.keyRcFile} and saved to ~/.pinecall/credentials (0600), so this one-time scan will not be needed again.`
            : `Key was not in this server's env — found by reading ${this.keyRcFile}, but ~/.pinecall/credentials could not be written, so the scan will repeat next start.`;
    }

    hasApiKey(): boolean {
        return this.#apiKey.length > 0;
    }

    /** The only reader. Throws the actionable error instead of returning "". */
    apiKey(): string {
        if (!this.#apiKey) throw new MissingApiKeyError();
        return this.#apiKey;
    }

    /**
     * `set_api_key`. Returns whether it was persisted — never the key, which a
     * caller must not be able to read back.
     *
     * With `persist`, the key is written to ~/.pinecall/credentials at 0600:
     * the one sanctioned disk write, so the next session (and the CLI) find it
     * without the user re-pasting.
     */
    setApiKey(key: string, persist = false): boolean {
        this.#apiKey = key.trim();
        this.keySource = "session";
        this.keyRcFile = undefined;
        this.keyPersisted = persist ? writeCredentials(this.#apiKey, this.#home) : false;
        return this.keyPersisted;
    }

    /**
     * Scrub the key out of any string before it leaves the process.
     * Belt and braces: an upstream 401 body could quote the credential.
     */
    redact(text: string): string {
        let out = text;
        if (this.#apiKey) out = out.split(this.#apiKey).join("[redacted]");
        for (const secret of this.#secrets) out = out.split(secret).join("[redacted]");
        return out.replace(/\bpk_[A-Za-z0-9_-]{6,}/g, "pk_[redacted]");
    }

    /**
     * Secrets that are NOT the Pinecall key but pass through this process for
     * the length of one tool call — a provider key handed to `byok('set')`.
     * They must be scrubbed from anything outbound exactly like the API key is,
     * and they must not outlive the call, so registration is scoped: the secret
     * is added before `fn` runs and removed in `finally`, whether it threw or not.
     */
    #secrets = new Set<string>();

    async withSecret<T>(secret: string, fn: () => Promise<T>): Promise<T> {
        const value = (secret ?? "").trim();
        // A trivially short "secret" would turn common substrings into [redacted].
        const track = value.length >= 6;
        if (track) this.#secrets.add(value);
        try {
            return await fn();
        } catch (err) {
            // The envelope in server.ts redacts too, but it runs AFTER this scope
            // has dropped the secret — so an error carrying the key must be
            // scrubbed here, while the secret is still registered.
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(this.redact(message));
        } finally {
            if (track) this.#secrets.delete(value);
        }
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

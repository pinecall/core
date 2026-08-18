/**
 * Playground REST client — the management plane (`/api/*` on playground.pinecall.io).
 *
 * Orgs, keys, Twilio accounts, phones, usage and conversations all live on the
 * PLAYGROUND API, not on the voice server: they are account operations and
 * happen whether or not any agent is online. That is why this module takes its
 * own `playgroundUrl` instead of the `apiUrl` the rest of the SDK talks to.
 *
 * Failures arrive as a typed `PlaygroundApiError` with the HTTP `status` and
 * the raw body — `status === 0` plus `code === "NETWORK_ERROR"` means the host
 * was unreachable, exactly like `knowledge.ts`. Nothing here calls
 * `process.exit`: turning an error into a message and an exit code is the
 * CLI's job (see `src/cli/playground.ts`), and a library that exits cannot be
 * embedded.
 */

import { PinecallError } from "../kernel/errors.js";

export const DEFAULT_PLAYGROUND_URL = "https://playground.pinecall.io";

export interface PlaygroundApiOptions {
    apiKey: string;
    /**
     * Management API base. Trailing slashes are stripped, so
     * "http://localhost:3000/" and "http://localhost:3000" are the same host.
     */
    playgroundUrl: string;
}

/** Everything `fetch` takes, plus the one thing this client decides for you. */
export interface PlaygroundFetchInit extends RequestInit {
    /**
     * Send `Content-Type: application/json`. Default true.
     *
     * Set false for the read-only endpoints that have always been called with
     * nothing but an Authorization header — the header set on the wire is part
     * of what these commands are, and this keeps it byte-for-byte what it was.
     */
    jsonContentType?: boolean;
}

// ── Errors ───────────────────────────────────────────────────────────────

export class PlaygroundApiError extends PinecallError {
    constructor(
        message: string,
        public status: number,
        /** The response body, verbatim — the Playground answers in plain text. */
        public body: string = "",
        code?: string,
    ) {
        super(message, code);
        this.name = "PlaygroundApiError";
    }
}

// ── Transport ────────────────────────────────────────────────────────────

function baseUrl(opts: PlaygroundApiOptions): string {
    return (opts.playgroundUrl || DEFAULT_PLAYGROUND_URL).replace(/\/+$/, "");
}

/**
 * One request against the Playground API.
 *
 * `path` is relative to `/api` — "/orgs/me", not "/api/orgs/me".
 */
export async function playgroundFetch<T = any>(
    opts: PlaygroundApiOptions,
    path: string,
    init?: PlaygroundFetchInit,
): Promise<T> {
    const base = baseUrl(opts);
    const { jsonContentType = true, ...requestInit } = init ?? {};

    let res: Response;
    try {
        res = await fetch(`${base}/api${path}`, {
            ...requestInit,
            headers: {
                ...(jsonContentType ? { "Content-Type": "application/json" } : {}),
                Authorization: `Bearer ${opts.apiKey}`,
                ...(init?.headers as Record<string, string> | undefined),
            },
        });
    } catch (err) {
        throw new PlaygroundApiError(
            `Cannot reach the Playground at ${base}: ${(err as Error)?.message ?? err}`,
            0,
            "",
            "NETWORK_ERROR",
        );
    }

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new PlaygroundApiError(`Playground ${res.status}: ${body}`, res.status, body);
    }

    return (await res.json()) as T;
}

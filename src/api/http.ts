/**
 * HTTP — shared fetch wrapper for REST API calls.
 *
 * Centralizes error mapping and Authorization header injection.
 */

export const DEFAULT_API_URL = "https://voice.pinecall.io";

export interface HttpOptions {
    apiUrl?: string;
    apiKey?: string;
}

export interface ApiFetchOptions extends HttpOptions {
    query?: Record<string, string>;
    /** HTTP method. Defaults to GET (POST when a `body` is given). */
    method?: string;
    /** JSON body — serialised and sent as `application/json`. */
    body?: unknown;
    /** Aborts the request (and, for streaming endpoints, the work behind it). */
    signal?: AbortSignal;
    /** Extra request headers. Authorization is injected from `apiKey`. */
    headers?: Record<string, string>;
}

export async function apiFetch(
    path: string,
    opts: ApiFetchOptions = {},
): Promise<Response> {
    const base = opts.apiUrl ?? DEFAULT_API_URL;
    const url = new URL(path, base);
    if (opts.query) {
        for (const [k, v] of Object.entries(opts.query)) {
            url.searchParams.set(k, v);
        }
    }

    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.apiKey) headers["Authorization"] = `Bearer ${opts.apiKey}`;

    const hasBody = opts.body !== undefined;
    if (hasBody) headers["Content-Type"] = "application/json";

    const res = await fetch(url.toString(), {
        method: opts.method ?? (hasBody ? "POST" : "GET"),
        headers,
        ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return res;
}

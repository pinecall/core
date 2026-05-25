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

export async function apiFetch(
    path: string,
    opts: HttpOptions & { query?: Record<string, string> } = {},
): Promise<Response> {
    const base = opts.apiUrl ?? DEFAULT_API_URL;
    const url = new URL(path, base);
    if (opts.query) {
        for (const [k, v] of Object.entries(opts.query)) {
            url.searchParams.set(k, v);
        }
    }

    const headers: Record<string, string> = {};
    if (opts.apiKey) headers["Authorization"] = `Bearer ${opts.apiKey}`;

    const res = await fetch(url.toString(), { headers });
    return res;
}

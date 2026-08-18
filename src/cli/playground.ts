/**
 * CLI — the Playground API, spoken the way the terminal speaks.
 *
 * `src/api/playground.ts` throws; the CLI dies with a message. That line is
 * deliberate: a library that calls `process.exit` cannot be embedded, and a
 * command that makes the user read a stack trace is a bad command. This is the
 * one place the translation happens, so every command reports an unreachable
 * host or a 4xx with the SAME words.
 */

import { playgroundFetch, PlaygroundApiError, type PlaygroundFetchInit } from "../api/playground.js";
import type { CliConfig } from "./config.js";
import { error } from "./ui.js";

export interface PgInit extends PlaygroundFetchInit {
    /**
     * Override the message for an HTTP error status. `balance` and `calls`
     * have always said "Failed to fetch …: <status>" instead of echoing the
     * body, and the user's screen is not ours to change.
     */
    httpErrorMessage?: (err: PlaygroundApiError) => string;
}

/**
 * One Playground request, or exit with the message the user has always seen.
 *
 * `path` is relative to `/api` — "/orgs/me", not "/api/orgs/me".
 */
export async function pg<T = any>(config: CliConfig, path: string, init?: PgInit): Promise<T> {
    const { httpErrorMessage, ...fetchInit } = init ?? {};
    try {
        return await playgroundFetch<T>(
            { apiKey: config.apiKey, playgroundUrl: config.playground },
            path,
            fetchInit,
        );
    } catch (err) {
        if (err instanceof PlaygroundApiError) {
            if (err.code === "NETWORK_ERROR") {
                error(`Cannot reach Playground at ${config.playground}`);
            }
            error(httpErrorMessage ? httpErrorMessage(err) : `Playground ${err.status}: ${err.body}`);
        }
        throw err;
    }
}

/**
 * CLI — Config resolution.
 *
 * Resolves API key + server URL from CLI flags or env vars.
 */

import { readCredentials } from "../api/credentials.js";
import { error } from "./ui.js";

export interface CliConfig {
    apiKey: string;
    server: string;
    playground: string;
    json: boolean;
}

/**
 * Parse CLI args and resolve config.
 *
 * Priority:
 *   --api-key flag > PINECALL_API_KEY env > ~/.pinecall/credentials
 *   --server flag  > PINECALL_URL env > https://voice.pinecall.io
 *   --playground   > PINECALL_PLAYGROUND_URL env > http://localhost:4000
 */
export function resolveConfig(argv: string[], requireKey = true): CliConfig {
    let apiKey = "";
    let server = "";
    let playground = "";
    let json = false;

    for (const arg of argv) {
        if (arg === "--json") {
            json = true;
        } else if (arg.startsWith("--api-key=")) {
            apiKey = arg.slice("--api-key=".length);
        } else if (arg.startsWith("--server=")) {
            server = arg.slice("--server=".length);
        } else if (arg.startsWith("--playground=")) {
            playground = arg.slice("--playground=".length);
        }
    }

    if (!apiKey) apiKey = process.env.PINECALL_API_KEY ?? "";
    // The shared store, AFTER env — the same file the MCP server writes, so a
    // key saved from an editor works in the terminal and vice versa.
    if (!apiKey) apiKey = readCredentials();
    if (!server) server = process.env.PINECALL_URL ?? "https://voice.pinecall.io";
    if (!playground) playground = process.env.PINECALL_PLAYGROUND_URL ?? "https://playground.pinecall.io";

    // Strip trailing slash
    server = server.replace(/\/+$/, "");
    playground = playground.replace(/\/+$/, "");

    if (requireKey && !apiKey) {
        error(
            "Missing API key.\n\n" +
            "  Set PINECALL_API_KEY, pass --api-key=pk_..., or save one in\n" +
            "  ~/.pinecall/credentials as {\"api_key\": \"pk_...\"} (mode 0600).\n",
        );
    }

    return { apiKey, server, playground, json };
}


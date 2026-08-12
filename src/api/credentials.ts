/**
 * ~/.pinecall/credentials — the canonical on-disk key store.
 *
 * One file, JSON `{ "api_key": "pk_..." }`, mode 0600. It lives here rather
 * than in the MCP package because BOTH read it: the CLI (src/cli/config.ts,
 * after env) and the MCP server (mcp/src/credentials.ts, as step 2 of its
 * discovery chain). One file, one format, so the two never disagree about
 * which key the user meant.
 *
 * It is the only thing either of them ever writes, and it is written 0600 —
 * a key on disk that other local users can read is a key that has leaked.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function credentialsDir(home: string = homedir()): string {
    return join(home, ".pinecall");
}

export function credentialsPath(home: string = homedir()): string {
    return join(credentialsDir(home), "credentials");
}

/**
 * Read the stored key. Returns "" for missing, unreadable or malformed —
 * never throws, because a broken store must degrade to "no key here", not
 * take down the CLI or the MCP server at boot.
 */
export function readCredentials(home: string = homedir()): string {
    try {
        const parsed = JSON.parse(readFileSync(credentialsPath(home), "utf8")) as { api_key?: unknown };
        return typeof parsed.api_key === "string" ? parsed.api_key.trim() : "";
    } catch {
        return "";
    }
}

/**
 * Write the store at 0600, creating ~/.pinecall (0700) if needed.
 * Returns false instead of throwing: failing to save a key is a downgrade
 * (the key still works this session), not a reason to fail the command.
 */
export function writeCredentials(apiKey: string, home: string = homedir()): boolean {
    try {
        const dir = credentialsDir(home);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
        const file = credentialsPath(home);
        writeFileSync(file, `${JSON.stringify({ api_key: apiKey.trim() }, null, 2)}\n`, { mode: 0o600 });
        // writeFileSync's `mode` only applies when it CREATES the file; chmod
        // covers an existing file that was already there world-readable.
        chmodSync(file, 0o600);
        return true;
    } catch {
        return false;
    }
}

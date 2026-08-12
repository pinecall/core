/**
 * Key discovery — the fix for "it works in my terminal, not in my editor".
 *
 * An IDE spawns a stdio MCP server as a plain child process. On macOS a GUI
 * app is not a login shell and NEVER sources ~/.zshrc, so a key the user
 * exported in their terminal simply does not exist in this process's env.
 * That is not a bug in the IDE; it is how process env inheritance works.
 *
 * So the key is resolved in three steps, most trustworthy first:
 *
 *   1. `process.env.PINECALL_API_KEY` — the env the server was actually
 *      spawned with (an `env` block in mcp.json, a launchd/systemd unit, or
 *      on Windows a user variable set with `setx`, which DOES reach a GUI
 *      child process). Always wins.
 *   2. `~/.pinecall/credentials` — the canonical store, JSON `{ "api_key": … }`,
 *      mode 0600. Shared with the CLI (`src/cli/config.ts`) so both agree.
 *   3. A READ-ONLY scan of the login shell rc files for
 *      `export PINECALL_API_KEY=…`. The file is parsed with a regex — it is
 *      NEVER executed, sourced, or spawned. A hit here is used AND persisted
 *      to the store, so this fragile path runs exactly once.
 *
 * The store itself is owned by the SDK (src/api/credentials.ts) because the
 * CLI reads the same file; this module owns only the discovery chain. That
 * store write is the single sanctioned write of this package, and it is 0600.
 * The key still never appears in a tool result or a log line.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readCredentials, writeCredentials } from "../../src/api/credentials.js";

export {
    credentialsDir,
    credentialsPath,
    readCredentials,
    writeCredentials,
} from "../../src/api/credentials.js";

/** Where the key came from. Reported by `whoami` so the user can see the path. */
export type KeySource = "env" | "credentials" | "shell-rc" | "session" | "none";

export interface ResolvedKey {
    apiKey: string;
    source: KeySource;
    /** True when an rc-file hit was copied into the credentials store. */
    persisted: boolean;
    /** The rc file a "shell-rc" hit came from, for the one-line notice. */
    rcFile?: string;
}

/** The rc files a login shell would read, in the order a shell would read them. */
export const RC_FILES = [".zshenv", ".zshrc", ".bash_profile", ".bashrc", ".profile"] as const;

/**
 * `export PINECALL_API_KEY=…` in shell syntax: optional `export`, optional
 * single/double/no quotes, optional trailing comment. Anchored per line so a
 * commented-out line (`# export PINECALL_API_KEY=old`) does not match.
 */
const RC_EXPORT = /^[ \t]*(?:export[ \t]+)?PINECALL_API_KEY[ \t]*=[ \t]*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s#]+))/gm;

/** Parse one rc file's TEXT. Last assignment wins, as a shell would. */
export function scanRcText(text: string): string {
    let found = "";
    for (const m of text.matchAll(RC_EXPORT)) {
        const value = (m[1] ?? m[2] ?? m[3] ?? "").trim();
        if (value) found = value;
    }
    return found;
}

/** READ-ONLY scan of the rc files. Never executes anything. */
export function scanShellRcFiles(home: string = homedir()): { apiKey: string; file: string } | null {
    for (const name of RC_FILES) {
        const path = join(home, name);
        let text: string;
        try {
            text = readFileSync(path, "utf8");
        } catch {
            continue;
        }
        const key = scanRcText(text);
        if (key) return { apiKey: key, file: path };
    }
    return null;
}

/** The chain: env → credentials store → shell-rc scan (persisting an rc hit). */
export function resolveApiKey(
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir(),
): ResolvedKey {
    const fromEnv = (env.PINECALL_API_KEY ?? "").trim();
    if (fromEnv) return { apiKey: fromEnv, source: "env", persisted: false };

    const fromStore = readCredentials(home);
    if (fromStore) return { apiKey: fromStore, source: "credentials", persisted: false };

    const fromRc = scanShellRcFiles(home);
    if (fromRc) {
        const persisted = writeCredentials(fromRc.apiKey, home);
        return { apiKey: fromRc.apiKey, source: "shell-rc", persisted, rcFile: fromRc.file };
    }

    return { apiKey: "", source: "none", persisted: false };
}

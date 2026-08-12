/**
 * Reading and writing somebody else's config file.
 *
 * The rule this module exists to keep: pinecall owns exactly ONE key. The file
 * belongs to the person who wrote it — their other MCP servers, their unrelated
 * top-level settings and, in the TOML case, their comments all have to come out
 * the other side untouched.
 */

import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SERVER_NAME, type Platform, type ServerEntry } from "./platforms.js";

/** `null` means "remove pinecall". */
export type Entry = ServerEntry | null;

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function read(path: string): string {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/**
 * Is pinecall already in this file?
 *
 * Unreadable counts as unregistered: this answers a display question, and the
 * write path is where a broken file gets reported properly.
 */
export function isRegistered(path: string, platform: Platform): boolean {
    if (!existsSync(path)) return false;
    const text = read(path);
    if (platform.fmt === "toml") {
        return new RegExp(`^\\[${escapeRe(platform.key)}\\.${SERVER_NAME}\\]`, "m").test(text);
    }
    try {
        const loaded = JSON.parse(text || "{}");
        return SERVER_NAME in (loaded?.[platform.key] ?? {});
    } catch {
        return false;
    }
}

/**
 * Back the file up next to itself before it is touched.
 *
 * These are hand-maintained files a person may have spent an afternoon on;
 * `.bak` alongside means the undo is a `mv`, with no state kept anywhere else.
 */
function backup(path: string): void {
    if (existsSync(path)) copyFileSync(path, `${path}.bak`);
}

/** Add, replace or drop the pinecall entry, in the host's own format. */
export function write(path: string, platform: Platform, entry: Entry): void {
    const next = platform.fmt === "toml" ? renderToml(read(path), platform.key, entry) : renderJson(path, platform.key, entry);
    backup(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next, "utf8");
}

/**
 * Merge, never rewrite. The entry is REPLACED rather than updated in place: a
 * stale command from an older release is precisely what re-running this is
 * supposed to cure, and merging would preserve it.
 */
function renderJson(path: string, key: string, entry: Entry): string {
    let data: Record<string, unknown> = {};
    if (existsSync(path)) {
        const text = read(path);
        try {
            data = JSON.parse(text || "{}");
        } catch (err) {
            throw new Error(`${path} is not valid JSON — fix it first (${(err as Error).message})`);
        }
    }
    const servers = (data[key] as Record<string, unknown>) ?? {};
    if (entry === null) delete servers[SERVER_NAME];
    else servers[SERVER_NAME] = entry;
    // Removing the last server leaves the (now empty) table rather than the key
    // vanishing — the host wrote that key, not us.
    data[key] = servers;
    return JSON.stringify(data, null, 2) + "\n";
}

const tomlBlock = (key: string) => new RegExp(`^\\[${escapeRe(key)}\\.${SERVER_NAME}\\]\\n(?:(?!^\\[).*\\n?)*`, "m");

/**
 * A targeted section replace/append.
 *
 * The CLI takes no dependencies and there is no TOML writer in Node, so the
 * section is edited as text — which is also why it must match only up to the
 * next `[`, and never round-trip the whole document (that would eat comments).
 */
function renderToml(text: string, key: string, entry: Entry): string {
    const block = tomlBlock(key);
    if (entry === null) return text.replace(block, "");
    const args = entry.args.map((a) => JSON.stringify(a)).join(", ");
    const section = `[${key}.${SERVER_NAME}]\ncommand = ${JSON.stringify(entry.command)}\nargs = [${args}]\n`;
    if (block.test(text)) return text.replace(block, section);
    return text.trim() ? text.replace(/\n+$/, "") + "\n\n" + section : section;
}

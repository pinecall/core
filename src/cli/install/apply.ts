/**
 * What is on this machine, and writing pinecall into it.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRegistered, write } from "./configs.js";
import { PLATFORMS, entry, type ServerEntry } from "./platforms.js";

export interface HostRow {
    platform: string;
    label: string;
    path: string;
    installed: boolean;
    registered: boolean;
}

export interface HostResult extends HostRow {
    action: string;
}

export const REGISTERED = "registered";
export const REPAIRED = "repaired";
export const REMOVED = "removed";
export const DONE_ACTIONS = new Set([REGISTERED, REPAIRED, REMOVED]);

/** Every known assistant, whether it is here, and whether we are in it. */
export function detect(home = homedir()): HostRow[] {
    return Object.entries(PLATFORMS).map(([platform, p]) => {
        const path = join(home, p.path);
        return {
            platform,
            label: p.label,
            path,
            installed: existsSync(join(home, p.dirHint)) || existsSync(path),
            registered: isRegistered(path, p),
        };
    });
}

export interface ApplyOptions {
    /** Explicit platform keys. Empty = sweep everything detected as installed. */
    platforms?: string[];
    remove?: boolean;
    home?: string;
}

/**
 * Register pinecall — or with `remove`, take it out.
 *
 * Naming a platform WRITES it even when nothing was detected: asking for one by
 * name is a decision, and a config file that does not exist yet is the normal
 * state of a fresh install. Only the automatic sweep skips.
 */
export function apply({ platforms = [], remove = false, home = homedir() }: ApplyOptions = {}): HostResult[] {
    for (const name of platforms) {
        if (!(name in PLATFORMS)) {
            throw new Error(`unknown platform '${name}' — choose from: ${Object.keys(PLATFORMS).join(", ")}`);
        }
    }
    const written: ServerEntry | null = remove ? null : entry();
    const results: HostResult[] = [];
    for (const row of detect(home)) {
        if (platforms.length && !platforms.includes(row.platform)) continue;
        if (!platforms.length && !row.installed) {
            results.push({ ...row, action: "skipped (not installed)" });
            continue;
        }
        if (remove && !row.registered) {
            results.push({ ...row, action: "skipped (not registered)" });
            continue;
        }
        results.push({ ...row, action: writeOne(row, written, remove) });
    }
    return results;
}

/**
 * One host's outcome as a STRING, never an exception.
 *
 * Six configs are being touched and any one of them may be hand-edited into
 * something unparseable. Reporting that host and carrying on is the whole
 * difference between "five editors registered, fix Cursor" and a stack trace
 * that leaves the person guessing which ones were done.
 */
function writeOne(row: HostRow, written: ServerEntry | null, remove: boolean): string {
    try {
        write(row.path, PLATFORMS[row.platform]!, written);
    } catch (err) {
        return `FAILED: ${(err as Error).message}`;
    }
    if (remove) return REMOVED;
    return row.registered ? REPAIRED : REGISTERED;
}

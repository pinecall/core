/**
 * Logger — structured logging interface.
 *
 * Pinecall accepts an optional logger in its options; defaults to noopLogger.
 * fileLogger writes to PINECALL_LOG (port of old Pinecall._log).
 */

export interface Logger {
    debug(msg: string, meta?: Record<string, unknown>): void;
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
}

const noop = () => {};

export const noopLogger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
};

/**
 * File logger — appends JSON lines to a file.
 * Used when PINECALL_LOG env var is set.
 */
export function fileLogger(path: string): Logger {
    // Lazy import to stay browser-safe
    let appendFileSync: typeof import("node:fs").appendFileSync | null = null;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        appendFileSync = require("node:fs").appendFileSync;
    } catch {
        // Browser context — fall back to noop
        return noopLogger;
    }

    const write = (level: string, msg: string, meta?: Record<string, unknown>) => {
        const ts = new Date().toISOString();
        const line = meta
            ? `${ts} [${level}] ${msg} ${JSON.stringify(meta)}\n`
            : `${ts} [${level}] ${msg}\n`;
        try { appendFileSync!(path, line); } catch { /* ignore */ }
    };

    return {
        debug: (msg, meta) => write("DEBUG", msg, meta),
        info: (msg, meta) => write("INFO", msg, meta),
        warn: (msg, meta) => write("WARN", msg, meta),
        error: (msg, meta) => write("ERROR", msg, meta),
    };
}

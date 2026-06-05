/**
 * CLI — ANSI colors and table rendering.
 *
 * Zero dependencies — raw escape codes only.
 * Keeps @pinecall/sdk bundle size small.
 */

// ── Colors ───────────────────────────────────────────────────────────────

const enabled = process.env.NO_COLOR === undefined && process.stdout.isTTY !== false;

function wrap(open: string, close: string): (s: string) => string {
    if (!enabled) return (s) => s;
    return (s) => `${open}${s}${close}`;
}

export const c = {
    dim: wrap("\x1b[2m", "\x1b[22m"),
    bold: wrap("\x1b[1m", "\x1b[22m"),
    green: wrap("\x1b[32m", "\x1b[39m"),
    red: wrap("\x1b[31m", "\x1b[39m"),
    cyan: wrap("\x1b[36m", "\x1b[39m"),
    purple: wrap("\x1b[35m", "\x1b[39m"),
    yellow: wrap("\x1b[33m", "\x1b[39m"),
};

// ── Table ────────────────────────────────────────────────────────────────

/** Strip ANSI escape codes for width calculation. */
function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Render a formatted table to stdout.
 *
 * @param headers  Column headers
 * @param rows     Array of row arrays (same length as headers)
 * @param indent   Left padding (default: 2 spaces)
 */
export function table(headers: string[], rows: string[][], indent = 2): void {
    const pad = " ".repeat(indent);
    const gap = "  ";

    // Calculate column widths
    const widths = headers.map((h, i) => {
        const dataMax = rows.reduce((max, row) => {
            const len = stripAnsi(row[i] ?? "").length;
            return len > max ? len : max;
        }, 0);
        return Math.max(stripAnsi(h).length, dataMax);
    });

    // Header
    const headerLine = headers.map((h, i) => c.bold(h.padEnd(widths[i]!))).join(gap);
    console.log(`${pad}${headerLine}`);

    // Separator
    const sep = widths.map((w) => c.dim("─".repeat(w))).join(gap);
    console.log(`${pad}${sep}`);

    // Rows
    for (const row of rows) {
        const line = row.map((cell, i) => {
            const visible = stripAnsi(cell);
            const padding = widths[i]! - visible.length;
            return cell + " ".repeat(Math.max(0, padding));
        }).join(gap);
        console.log(`${pad}${line}`);
    }
}

// ── Errors & info ────────────────────────────────────────────────────────

export function error(msg: string): never {
    console.error(`\n  ${c.red("✗")} ${msg}\n`);
    process.exit(1);
}

export function info(msg: string): void {
    console.log(`\n  ${msg}\n`);
}

export function banner(): void {
    const version = "0.2.7";
    console.log(`\n  ${c.purple("⚡")} ${c.bold("pinecall")} ${c.dim(`v${version}`)}\n`);
}

// ── Section headers ──────────────────────────────────────────────────────

export function section(title: string, count?: number | string): void {
    const countStr = count !== undefined ? ` ${c.dim(`(${count})`)}` : "";
    console.log(`\n  ${c.cyan("▸")} ${c.bold(title)}${countStr}`);
}

export function kv(label: string, value: string, indent = 4): void {
    console.log(`${" ".repeat(indent)}${c.dim(label + ":")} ${value}`);
}

export function badge(text: string, color: "green" | "yellow" | "red" | "cyan" | "purple"): string {
    const fn = c[color];
    return fn(`[${text}]`);
}


/**
 * The two things a person reads: what was found, and what was done.
 */

import { c } from "../ui.js";
import { DONE_ACTIONS, type HostResult, type HostRow } from "./apply.js";

function pad(s: string, n: number): string {
    return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/**
 * The report. Every host gets a line, including the skipped ones — a list that
 * only shows successes cannot answer "why isn't Cursor in there".
 */
export function render(results: HostResult[], remove = false): string {
    const lines = results.map((r) => {
        const ok = DONE_ACTIONS.has(r.action);
        const failed = r.action.startsWith("FAILED");
        const mark = failed ? c.red("✗") : ok ? c.green("✓") : c.dim("·");
        const action = failed ? c.red(r.action) : ok ? c.green(r.action) : c.dim(r.action);
        return `  ${mark} ${c.bold(pad(r.label, 12))} ${pad(action, 24)} ${c.dim(r.path)}`;
    });
    const done = results.filter((r) => DONE_ACTIONS.has(r.action));
    const verb = remove ? "Unregistered" : "Registered";
    const head = done.length ? `${verb} pinecall in ${done.length} platform(s):` : "No platforms touched.";
    return `\n  ${c.bold(head)}\n` + lines.join("\n") + tail(done.length > 0 && !remove);
}

/**
 * The two things that are not obvious: a running assistant has already read its
 * config, and the API key lives in the environment, NOT in the file we just
 * wrote — so a host launched without it will start and then fail to authorise.
 */
function tail(worthSaying: boolean): string {
    if (!worthSaying) return "\n";
    return (
        `\n\n  ${c.dim("Backups written alongside each file as")} ${c.cyan(".bak")}${c.dim(".")}` +
        `\n  ${c.dim("Restart your assistant to pick it up.")}` +
        `\n  ${c.dim("No API key was written to any config — the server reads")} ${c.cyan("PINECALL_API_KEY")} ${c.dim("from its environment.")}\n`
    );
}

/**
 * `--list`: the same table, changing nothing.
 *
 * Three states, not two: a product that is absent, one that is here but
 * unregistered, and one already wired up. Collapsing the first two would send
 * someone to install an editor they already have.
 */
export function renderDetected(rows: HostRow[]): string {
    const lines = rows.map((r) => {
        const state = r.registered ? "registered" : r.installed ? "not registered" : "not installed";
        const mark = r.installed ? c.green("✓") : c.dim("·");
        const shown = r.registered ? c.green(pad(state, 16)) : c.dim(pad(state, 16));
        return `  ${mark} ${c.bold(pad(r.label, 12))} ${shown} ${c.dim(r.path)}`;
    });
    return `\n  ${c.bold("AI coding assistants on this machine:")}\n` + lines.join("\n") + "\n";
}

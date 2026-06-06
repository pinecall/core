/**
 * CLI — `pinecall calls`
 *
 * Shows call history with duration, credits consumed, and cost per call.
 * Uses GET /api/usage/calls from the Playground API.
 */

import type { CliConfig } from "../config.js";
import { c, table, info, error } from "../ui.js";

interface CallRecord {
    callId: string;
    credits: number;
    costUsd: number;
    duration: number;  // seconds
    events: number;
    startedAt: string;
    endedAt: string;
    services: { service: string; provider: string; model: string; credits: number }[];
}

const CALLS_HELP = `
  ${c.purple("⚡")} ${c.bold("pinecall calls")} — Call history

  ${c.bold("Usage:")}
    ${c.dim("$")} pinecall calls
    ${c.dim("$")} pinecall calls --limit=50
    ${c.dim("$")} pinecall calls --json

  Shows recent calls with duration and credit consumption.

  ${c.bold("See also:")}
    pinecall usage             ${c.dim("Credit usage breakdown by service")}
    pinecall balance           ${c.dim("Current credit balance")}
`;

function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m${s}s` : `${m}m`;
}

function formatTime(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor(diff / 60000);

    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;

    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export async function callsCommand(config: CliConfig, args?: string[]): Promise<void> {
    if (args && (args.includes("--help") || args.includes("-h"))) {
        console.log(CALLS_HELP);
        return;
    }

    const limitArg = (args || []).find(a => a.startsWith("--limit="));
    const limit = limitArg ? parseInt(limitArg.slice("--limit=".length)) : 20;

    let res: Response;
    try {
        res = await fetch(`${config.playground}/api/usage/calls?limit=${limit}`, {
            headers: { Authorization: `Bearer ${config.apiKey}` },
        });
    } catch {
        error(`Cannot reach Playground at ${config.playground}`);
    }

    if (!res!.ok) {
        error(`Failed to fetch call history: ${res!.status}`);
    }

    const data: { calls: CallRecord[] } = await res!.json();

    if (config.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
    }

    if (data.calls.length === 0) {
        console.log("");
        info("No calls recorded yet.");
        console.log("");
        return;
    }

    const headers = ["Call ID", "Duration", "Credits", "Cost", "When"];
    const rows = data.calls.map((call) => {
        const dur = formatDuration(call.duration);
        const credits = call.credits.toFixed(1);
        const cost = `$${call.costUsd.toFixed(4)}`;
        const when = formatTime(call.startedAt);
        const shortId = call.callId.slice(0, 12) + "…";
        return [c.dim(shortId), dur, c.green(credits), c.dim(cost), c.dim(when)];
    });

    console.log("");
    table(headers, rows);

    const totalCredits = data.calls.reduce((s, c) => s + c.credits, 0);
    const totalCost = data.calls.reduce((s, c) => s + c.costUsd, 0);
    const totalDuration = data.calls.reduce((s, c) => s + c.duration, 0);

    info(
        `${c.bold(String(data.calls.length))} calls  ${c.dim("·")}  ` +
        `${formatDuration(totalDuration)}  ${c.dim("·")}  ` +
        `${c.green(totalCredits.toFixed(1))} credits  ${c.dim("·")}  ` +
        `$${totalCost.toFixed(4)}`,
    );
    console.log("");
}

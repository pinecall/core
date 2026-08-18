/**
 * CLI — `pinecall balance`
 *
 * Shows Pinecall credit balance from the playground API.
 */

import type { CliConfig } from "../config.js";
import { pg } from "../playground.js";
import { c, kv } from "../ui.js";

export async function balanceCommand(config: CliConfig, args?: string[]): Promise<void> {
    if (args && (args.includes("--help") || args.includes("-h"))) {
        console.log(`
  ${c.purple("⚡")} ${c.bold("pinecall balance")} — Account balance

  ${c.bold("Usage:")}
    ${c.dim("$")} pinecall balance
    ${c.dim("$")} pinecall balance --json

  Shows your Pinecall credit balance and plan info.
`);
        return;
    }

    const org = await pg(config, "/orgs/me", {
        jsonContentType: false,
        httpErrorMessage: (err) => `Failed to fetch balance: ${err.status}`,
    });

    if (config.json) {
        console.log(JSON.stringify({
            org: org.name,
            plan: org.plan,
            credits: org.credits,
            creditLimit: org.creditLimit,
        }, null, 2));
        return;
    }

    const credits = Math.floor(org.credits ?? 0).toLocaleString();
    const limit = org.creditLimit ? Math.floor(org.creditLimit).toLocaleString() : "∞";
    const pct = org.creditLimit ? ((org.credits / org.creditLimit) * 100).toFixed(0) : null;
    const planLabel = (org.plan || "free").replace(/_/g, " ").replace(/\b\w/g, (l: string) => l.toUpperCase());

    // Color based on remaining percentage
    const creditColor = !pct ? c.green :
        Number(pct) < 10 ? c.red :
        Number(pct) < 25 ? c.yellow : c.green;

    console.log("");
    console.log(`  ${c.purple("⚡")} ${c.bold(org.name)}`);
    console.log("");
    kv("Plan", c.cyan(planLabel));
    kv("Credits", `${creditColor(credits)} ${c.dim("/")} ${c.dim(limit)}${pct ? c.dim(` (${pct}%)`) : ""}`);
    if (org.email) kv("Email", c.dim(org.email));
    console.log("");
}

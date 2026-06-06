/**
 * CLI — `pinecall agents`
 *
 * Lists all currently connected agents with their phone numbers and channels.
 * Uses GET /api/sdk/agents.
 */

import type { CliConfig } from "../config.js";
import { c, table, info, error } from "../ui.js";

interface AgentEntry {
    slug: string;
    org_id: string;
    phones: string[];
    channels: Record<string, { count: number; refs: string[] }>;
    active: boolean;
}

interface AgentsResponse {
    success: boolean;
    agents: AgentEntry[];
    total: number;
    phone_map: Record<string, string>;
    dev_overrides: Record<string, string> | null;
}

export async function agentsCommand(config: CliConfig, args?: string[]): Promise<void> {
    if (args && (args.includes("--help") || args.includes("-h"))) {
        console.log(`
  ${c.purple("⚡")} ${c.bold("pinecall agents")} — List connected agents

  ${c.bold("Usage:")}
    ${c.dim("$")} pinecall agents
    ${c.dim("$")} pinecall agents --json

  Shows all agents currently connected to the voice server,
  their registered phone numbers, and active channels.
`);
        return;
    }

    const url = `${config.server}/api/sdk/agents`;
    let res: Response;

    try {
        res = await fetch(url, {
            headers: { Authorization: `Bearer ${config.apiKey}` },
        });
    } catch {
        error(`Cannot reach server at ${config.server}`);
    }

    if (!res!.ok) {
        error(`Server returned ${res!.status}: ${await res!.text()}`);
    }

    const data: AgentsResponse = await res!.json();

    if (config.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
    }

    if (data.agents.length === 0) {
        info("No agents connected.");
        return;
    }

    const headers = ["Agent", "Phones", "Channels"];
    const rows = data.agents.map((a) => {
        const phones = a.phones.length > 0 ? a.phones.join(", ") : c.dim("—");
        const channels = Object.keys(a.channels).join(", ");
        return [c.purple(a.slug), phones, c.dim(channels)];
    });

    console.log("");
    table(headers, rows);

    // Dev overrides + callers
    const hasOverrides = data.dev_overrides && Object.keys(data.dev_overrides).length > 0;
    const devCallers = (data as any).dev_callers as string[] | null;

    if (hasOverrides || (devCallers && devCallers.length > 0)) {
        console.log("");
        for (const [phone, agent] of Object.entries(data.dev_overrides ?? {})) {
            const callersPart = devCallers?.length
                ? `  ${c.dim("←")} ${devCallers.map((n: string) => c.yellow(n)).join(c.dim(", "))}`
                : "";
            console.log(`  ${c.yellow("⚙")} ${c.purple(agent as string)} ${c.dim("on")} ${phone}${callersPart}`);
        }
    }

    info(`${c.bold(String(data.total))} agent${data.total !== 1 ? "s" : ""} connected`);
}

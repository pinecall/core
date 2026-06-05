/**
 * CLI — `pinecall phones`
 *
 * Lists phone numbers for the org with agent assignment info.
 * Uses GET /api/sdk/phone-numbers + GET /api/sdk/agents for cross-reference.
 */

import type { CliConfig } from "../config.js";
import { c, table, info, error } from "../ui.js";

interface PhoneEntry {
    number: string;
    name: string;
    sid: string;
    isSdk: boolean;
}

interface PhonesResponse {
    success: boolean;
    phones: PhoneEntry[];
    total: number;
}

interface AgentsResponse {
    success: boolean;
    phone_map: Record<string, string>;
}

export async function phonesCommand(config: CliConfig): Promise<void> {
    const headers = { Authorization: `Bearer ${config.apiKey}` };

    // Fetch phones + agents in parallel
    let phonesRes: Response;
    let agentsRes: Response;

    try {
        [phonesRes, agentsRes] = await Promise.all([
            fetch(`${config.server}/api/sdk/phone-numbers`, { headers }),
            fetch(`${config.server}/api/sdk/agents`, { headers }),
        ]);
    } catch {
        error(`Cannot reach server at ${config.server}`);
    }

    if (!phonesRes!.ok) {
        error(`Failed to fetch phones: ${phonesRes!.status}`);
    }

    const phonesData: PhonesResponse = await phonesRes!.json();
    let phoneMap: Record<string, string> = {};

    if (agentsRes!.ok) {
        const agentsData: AgentsResponse = await agentsRes!.json();
        phoneMap = agentsData.phone_map ?? {};
    }

    // Merge: start with DB phones, then add any agent phones not in DB
    const seen = new Set<string>();
    const merged: { number: string; name: string; agent?: string; source: "db" | "agent" }[] = [];

    for (const p of phonesData.phones) {
        seen.add(p.number);
        merged.push({
            number: p.number,
            name: p.name !== p.number ? p.name : "",
            agent: phoneMap[p.number],
            source: "db",
        });
    }

    // Add phones from connected agents that aren't in the DB
    for (const [phone, agent] of Object.entries(phoneMap)) {
        if (!seen.has(phone)) {
            merged.push({ number: phone, name: "", agent, source: "agent" });
        }
    }

    if (config.json) {
        console.log(JSON.stringify({ phones: merged, total: merged.length, phone_map: phoneMap }, null, 2));
        return;
    }

    if (merged.length === 0) {
        info("No phone numbers found.");
        return;
    }

    const tableHeaders = ["Phone", "Name", "Agent", "Source"];
    const rows = merged.map((p) => {
        const agentCol = p.agent ? c.purple(p.agent) : c.dim("— (available)");
        const name = p.name || c.dim("—");
        const source = p.source === "db" ? c.dim("db") : c.yellow("live");
        return [p.number, name, agentCol, source];
    });

    console.log("");
    table(tableHeaders, rows);

    const available = merged.filter((p) => !p.agent).length;
    const fromDb = merged.filter((p) => p.source === "db").length;
    const fromAgent = merged.filter((p) => p.source === "agent").length;
    const summary = `${c.bold(String(merged.length))} phone number${merged.length !== 1 ? "s" : ""}`;
    const sources = fromAgent > 0 ? ` ${c.dim(`(${fromDb} db, ${fromAgent} live)`)}` : "";
    const avail = available > 0 ? `, ${c.green(String(available))} available` : "";
    info(`${summary}${sources}${avail}`);
}

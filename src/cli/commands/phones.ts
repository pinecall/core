/**
 * CLI — `pinecall phones`
 *
 * Lists phone numbers from the org's Twilio account + connected agents.
 * Twilio phones come from GET /api/sdk/phone-numbers (Twilio API).
 * Agent assignment comes from GET /api/sdk/agents.
 */

import type { CliConfig } from "../config.js";
import { c, table, info, warn, error } from "../ui.js";

interface TwilioPhone {
    number: string;
    name: string;
}

interface PhonesResponse {
    success: boolean;
    phones: TwilioPhone[];
    total: number;
}

interface AgentsResponse {
    success: boolean;
    phone_map: Record<string, string>;
}

export async function phonesCommand(config: CliConfig): Promise<void> {
    const headers = { Authorization: `Bearer ${config.apiKey}` };

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

    // Agent phone map (always needed)
    let phoneMap: Record<string, string> = {};
    if (agentsRes!.ok) {
        const agentsData: AgentsResponse = await agentsRes!.json();
        phoneMap = agentsData.phone_map ?? {};
    }

    // Twilio phones (may fail if no Twilio creds)
    let twilioPhones: TwilioPhone[] = [];
    if (phonesRes!.ok) {
        const phonesData: PhonesResponse = await phonesRes!.json();
        twilioPhones = phonesData.phones ?? [];
    }

    // Merge: start with Twilio phones, then add agent-only phones
    const seen = new Set<string>();
    const merged: { number: string; name: string; agent?: string }[] = [];

    for (const p of twilioPhones) {
        seen.add(p.number);
        merged.push({
            number: p.number,
            name: p.name !== p.number ? p.name : "",
            agent: phoneMap[p.number],
        });
    }

    // Add phones from connected agents that aren't in Twilio
    for (const [phone, agent] of Object.entries(phoneMap)) {
        if (!seen.has(phone)) {
            merged.push({ number: phone, name: "", agent });
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

    const tableHeaders = ["Phone", "Name", "Agent"];
    const rows = merged.map((p) => {
        const agentCol = p.agent ? c.purple(p.agent) : c.dim("— (available)");
        const name = p.name || c.dim("—");
        return [p.number, name, agentCol];
    });

    console.log("");
    table(tableHeaders, rows);

    const available = merged.filter((p) => !p.agent).length;
    const summary = `${c.bold(String(merged.length))} phone number${merged.length !== 1 ? "s" : ""}`;
    const avail = available > 0 ? `, ${c.green(String(available))} available` : "";
    info(`${summary}${avail}`);
}

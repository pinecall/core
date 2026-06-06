/**
 * CLI — `pinecall phones`
 *
 * Phone number management:
 *   pinecall phones                List all phones + agent assignment
 *   pinecall phones add [n]        Show available Twilio phones / import one
 *   pinecall phones request        Request a managed number from Pinecall
 *   pinecall phones search         Search available managed numbers
 *   pinecall phones remove <n>     Remove a phone
 */

import type { CliConfig } from "../config.js";
import { c, table, info, warn, error, section, kv } from "../ui.js";

// ── Playground API helper ───────────────────────────────────────────────

async function pg(config: CliConfig, path: string, init?: RequestInit): Promise<any> {
    const url = `${config.playground}/api${path}`;
    let res: Response;
    try {
        res = await fetch(url, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.apiKey}`,
                ...(init?.headers || {}),
            },
        });
    } catch {
        error(`Cannot reach Playground at ${config.playground}`);
    }
    if (!res!.ok) {
        const body = await res!.text();
        error(`Playground ${res!.status}: ${body}`);
    }
    return res!.json();
}

// ── List phones ─────────────────────────────────────────────────────────

interface Phone { number: string; name: string; }
interface PhonesResponse { success: boolean; phones: Phone[]; total: number; }
interface AgentsResponse { success: boolean; phone_map: Record<string, string>; }

async function listPhones(config: CliConfig): Promise<void> {
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

    let phoneMap: Record<string, string> = {};
    if (agentsRes!.ok) {
        const agentsData: AgentsResponse = await agentsRes!.json();
        phoneMap = agentsData.phone_map ?? {};
    }

    let orgPhones: Phone[] = [];
    if (phonesRes!.ok) {
        const phonesData: PhonesResponse = await phonesRes!.json();
        orgPhones = phonesData.phones ?? [];
    }

    const seen = new Set<string>();
    const merged: { number: string; name: string; agent?: string }[] = [];

    for (const p of orgPhones) {
        seen.add(p.number);
        merged.push({
            number: p.number,
            name: p.name !== p.number ? p.name : "",
            agent: phoneMap[p.number],
        });
    }

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
        console.log("");
        info("No phone numbers found.");
        console.log(`\n  ${c.dim("Add from Twilio:")}     pinecall phones add`);
        console.log(`  ${c.dim("Request a number:")}   pinecall phones request`);
        console.log(`  ${c.dim("Link an account:")}    pinecall twilio link <SID> <Token>\n`);
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

    // Show outbound tip for managed numbers
    try {
        const org = await pg(config, "/orgs/me");
        if (!org.verified) {
            console.log(`  ${c.yellow("⚠")} ${c.dim("Outbound calls require a verified account.")}  ${c.cyan("info@pinecall.io")}`);
        }
    } catch {
        // Couldn't fetch org — skip tip
    }

    console.log(`  ${c.dim("Add:")}     pinecall phones add`);
    console.log(`  ${c.dim("Request:")} pinecall phones request`);
    console.log(`  ${c.dim("Remove:")}  pinecall phones remove <number>\n`);
}

// ── Add phone (BYOC — from linked Twilio) ───────────────────────────────

async function addPhone(config: CliConfig, number?: string): Promise<void> {
    const data = await pg(config, "/twilio?available=true");

    if (data.accounts.length === 0) {
        console.log("");
        console.log(`  ${c.dim("No Twilio accounts linked.")}`);
        console.log(`  ${c.dim("Link one first:")} ${c.cyan("pinecall twilio link <SID> <AuthToken>")}`);
        console.log(`\n  ${c.dim("Or request a managed number:")} ${c.cyan("pinecall phones request")}`);
        console.log("");
        return;
    }

    if (!number) {
        let hasAvailable = false;

        for (const a of data.accounts) {
            if (!a.availablePhones?.length) continue;
            const available = a.availablePhones.filter((p: any) => !p.imported);
            const imported = a.availablePhones.filter((p: any) => p.imported);

            if (available.length === 0 && imported.length === 0) continue;

            section(a.friendlyName || a.accountSid);

            if (imported.length > 0) {
                console.log(`    ${c.green("●")} ${c.bold("Already added")} ${c.dim(`(${imported.length})`)}`);
                table(
                    ["Number", "Name"],
                    imported.map((p: any) => [c.green(p.number), p.name || c.dim("—")]),
                    6,
                );
            }

            if (available.length > 0) {
                hasAvailable = true;
                console.log(`\n    ${c.yellow("○")} ${c.bold("Available")} ${c.dim(`(${available.length})`)}`);
                table(
                    ["Number", "Name", "Type"],
                    available.map((p: any) => [
                        c.yellow(p.number),
                        c.dim(p.name || "—"),
                        c.dim(p.type),
                    ]),
                    6,
                );
            }
        }

        if (hasAvailable) {
            console.log(`\n  ${c.dim("Add one:")} ${c.cyan("pinecall phones add +1234567890")}`);
        } else {
            console.log("");
            info("All Twilio phones are already added.");
        }
        console.log("");
        return;
    }

    // Import specific number
    let targetPhone: any = null;
    let targetAccount: any = null;

    for (const a of data.accounts) {
        if (!a.availablePhones) continue;
        const phone = a.availablePhones.find((p: any) =>
            p.number === number || p.number.endsWith(number),
        );
        if (phone) {
            targetPhone = phone;
            targetAccount = a;
            break;
        }
    }

    if (!targetPhone) {
        error(`Phone ${number} not found in any linked Twilio account.\n\n  Run ${c.dim("pinecall phones add")} to see available numbers.`);
    }

    if (targetPhone.imported) {
        info(`${c.green(targetPhone.number)} is already added.`);
        return;
    }

    const result = await pg(config, "/phones/import", {
        method: "POST",
        body: JSON.stringify({
            twilioAccountId: targetAccount.id,
            phones: [{
                number: targetPhone.number,
                sid: targetPhone.sid,
                type: targetPhone.type,
                friendlyName: targetPhone.name,
                ...(targetPhone.sipDomainSid && { sipDomainSid: targetPhone.sipDomainSid }),
                ...(targetPhone.sipDomainName && { sipDomainName: targetPhone.sipDomainName }),
            }],
            configureWebhooks: true,
        }),
    });

    if (config.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    console.log("");
    console.log(`  ${c.green("✓")} Added ${c.green(targetPhone.number)}`);
    kv("Name", targetPhone.name || "—");
    kv("Account", targetAccount.friendlyName || targetAccount.accountSid);
    kv("Webhook", result.imported?.[0]?.webhookConfigured ? c.green("configured") : c.yellow("skipped"));
    console.log("");
}

// ── Remove phone ────────────────────────────────────────────────────────

async function removePhone(config: CliConfig, number: string): Promise<void> {
    const data = await pg(config, "/phones");
    const phone = data.phones.find((p: any) => p.number === number || p.phoneNumber === number);

    if (!phone) {
        error(`Phone ${number} not found.\n\n  Run ${c.dim("pinecall phones")} to see your numbers.`);
    }

    const result = await pg(config, `/phones/${phone.id || phone._id}`, { method: "DELETE" });

    if (config.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    console.log("");
    console.log(`  ${c.green("✓")} Removed ${c.bold(number)}`);
    console.log(`  ${c.dim("Still on your Twilio account — just unlinked from Pinecall.")}`);
    console.log(`  ${c.dim("Re-add anytime:")} ${c.cyan("pinecall phones add " + number)}`);
    console.log("");
}

// ── Help ────────────────────────────────────────────────────────────────

const PHONES_HELP = `
  ${c.purple("⚡")} ${c.bold("pinecall phones")} — Phone number management

  ${c.bold("Commands:")}
    ${c.dim("(none)")}                     List all phone numbers
    add                        Show available Twilio numbers
    add <number>               Add a number from your Twilio account
    request                    Get a managed number from Pinecall
    search                     Search available managed numbers
    remove <number>            Remove a number from Pinecall

  ${c.bold("BYOC (Bring Your Own Carrier):")}
    ${c.dim("$")} pinecall phones add
    ${c.dim("$")} pinecall phones add +1234567890

  ${c.bold("Managed Numbers:")}
    ${c.dim("$")} pinecall phones search --country=US
    ${c.dim("$")} pinecall phones request --area-code=415

  ${c.bold("Note:")}
    Outbound calls from managed numbers require account verification.
    Contact ${c.cyan("info@pinecall.io")} to verify your account.

  ${c.bold("See also:")}
    pinecall twilio            ${c.dim("Manage Twilio accounts")}
    pinecall agents            ${c.dim("List connected agents")}
`;

// ── Entry point ─────────────────────────────────────────────────────────

export async function phonesCommand(config: CliConfig, args?: string[]): Promise<void> {
    if (args && (args.includes("--help") || args.includes("-h"))) {
        // Check if help is for a specific subcommand
        const positional = (args || []).filter((a) => !a.startsWith("-") && a !== "phones");
        const sub = positional[0];
        if (sub === "request" || sub === "search") {
            // Delegate to phone command for its own help
            const { phoneCommand } = await import("./phone.js");
            await phoneCommand(config, ["phone", sub, "--help"]);
            return;
        }
        console.log(PHONES_HELP);
        return;
    }

    const positional = (args || []).filter((a) => !a.startsWith("-") && a !== "phones");
    const sub = positional[0];

    switch (sub) {
        case "add": {
            const number = positional[1];
            await addPhone(config, number);
            break;
        }
        case "request":
        case "search": {
            // Delegate to phone.ts (managed numbers)
            const { phoneCommand } = await import("./phone.js");
            await phoneCommand(config, ["phone", ...positional, ...((args || []).filter(a => a.startsWith("-")))]);
            break;
        }
        case "remove": {
            const number = positional[1];
            if (!number) error(`Usage: pinecall phones remove <phone_number>`);
            await removePhone(config, number);
            break;
        }
        case undefined:
            await listPhones(config);
            break;
        default:
            error(`Unknown subcommand: ${sub}\n\n  Run ${c.dim("pinecall phones --help")} for usage.`);
    }
}

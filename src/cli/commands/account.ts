/**
 * CLI — `pinecall account`
 *
 * Shows org info, keys, Twilio accounts, phones, and usage.
 * Talks to the Playground API.
 */

import type { CliConfig } from "../config.js";
import { c, table, info, error } from "../ui.js";

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

// ── Subcommands ─────────────────────────────────────────────────────────

async function showAccount(config: CliConfig): Promise<void> {
    const org = await pg(config, "/orgs/me");
    const keysData = await pg(config, "/keys");
    const twilioData = await pg(config, "/twilio");
    const phonesData = await pg(config, "/phones");

    if (config.json) {
        console.log(JSON.stringify({ org, keys: keysData.keys, twilio: twilioData.accounts, phones: phonesData.phones }, null, 2));
        return;
    }

    console.log("");
    console.log(`  ${c.purple("⚡")} ${c.bold(org.name)} ${c.dim(`(${org.slug})`)}`);
    console.log(`  ${c.dim("Plan:")} ${org.plan}  ${c.dim("Balance:")} $${org.balance}`);
    console.log(`  ${c.dim("Email:")} ${org.email || "—"}`);

    // Keys
    if (keysData.keys.length > 0) {
        console.log(`\n  ${c.bold("API Keys")} ${c.dim(`(${keysData.keys.length})`)}`);
        table(
            ["Key", "Name", "Created"],
            keysData.keys.map((k: any) => [
                c.dim(k.keyPreview),
                k.name,
                c.dim(new Date(k.createdAt).toLocaleDateString()),
            ]),
        );
    }

    // Twilio
    if (twilioData.accounts.length > 0) {
        console.log(`\n  ${c.bold("Twilio Accounts")} ${c.dim(`(${twilioData.accounts.length})`)}`);
        table(
            ["SID", "Name", "Phones", "Verified"],
            twilioData.accounts.map((a: any) => [
                c.dim(a.accountSid.slice(0, 10) + "..."),
                a.friendlyName || "—",
                String(a.phoneCount),
                a.verified ? c.green("✓") : c.red("✗"),
            ]),
        );
    }

    // Phones
    if (phonesData.phones.length > 0) {
        console.log(`\n  ${c.bold("Phone Numbers")} ${c.dim(`(${phonesData.phones.length})`)}`);
        table(
            ["Number", "Name", "Type", "Webhook"],
            phonesData.phones.map((p: any) => [
                p.number,
                p.friendlyName || c.dim("—"),
                c.dim(p.type),
                p.webhookConfigured ? c.green("✓") : c.dim("—"),
            ]),
        );
    }

    console.log("");
}

async function showKeys(config: CliConfig): Promise<void> {
    const data = await pg(config, "/keys");
    if (config.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
    }
    if (data.keys.length === 0) {
        info("No API keys.");
        return;
    }
    console.log("");
    table(
        ["Key", "Name", "Created", "Last Used"],
        data.keys.map((k: any) => [
            c.dim(k.keyPreview),
            k.name,
            c.dim(new Date(k.createdAt).toLocaleDateString()),
            k.lastUsedAt ? c.dim(new Date(k.lastUsedAt).toLocaleDateString()) : c.dim("never"),
        ]),
    );
    info(`${c.bold(String(data.keys.length))} key${data.keys.length !== 1 ? "s" : ""}`);
}

async function createKey(config: CliConfig, name: string): Promise<void> {
    const data = await pg(config, "/keys", {
        method: "POST",
        body: JSON.stringify({ name: name || "CLI" }),
    });

    if (config.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
    }

    console.log("");
    console.log(`  ${c.green("✓")} Created key ${c.bold(data.name)}`);
    console.log("");
    console.log(`  ${c.bold(data.key)}`);
    console.log("");
    console.log(`  ${c.dim("Save this key — it won't be shown again.")}`);
    console.log("");
}

async function showTwilio(config: CliConfig): Promise<void> {
    const data = await pg(config, "/twilio?available=true");
    if (config.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
    }
    if (data.accounts.length === 0) {
        info("No Twilio accounts linked.");
        return;
    }

    for (const a of data.accounts) {
        const imported = a.importedCount ?? a.phoneCount ?? 0;
        const total = a.totalOnTwilio ?? "?";
        const status = a.verified ? c.green("✓") : c.red("✗");

        console.log("");
        console.log(`  ${c.bold(a.friendlyName || "Unnamed")} ${c.dim(`(${a.accountSid})`)}`);
        console.log(`  ${c.dim("Verified:")} ${status}  ${c.dim("Phones:")} ${imported} imported / ${total} on Twilio`);

        if (a.availablePhones?.length > 0) {
            const importedPhones = a.availablePhones.filter((p: any) => p.imported);
            const availablePhones = a.availablePhones.filter((p: any) => !p.imported);

            if (importedPhones.length > 0) {
                console.log(`\n  ${c.green("●")} ${c.bold("Imported")}`);
                table(
                    ["Number", "Name", "Type"],
                    importedPhones.map((p: any) => [p.number, p.name || c.dim("—"), c.dim(p.type)]),
                );
            }

            if (availablePhones.length > 0) {
                console.log(`\n  ${c.yellow("○")} ${c.bold("Available")} ${c.dim("(not imported)")}`);
                table(
                    ["Number", "Name", "Type"],
                    availablePhones.map((p: any) => [p.number, p.name || c.dim("—"), c.dim(p.type)]),
                );
            }
        }
    }

    info(`${c.bold(String(data.accounts.length))} Twilio account${data.accounts.length !== 1 ? "s" : ""}`);
}

async function showPhones(config: CliConfig): Promise<void> {
    const data = await pg(config, "/phones");
    if (config.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
    }
    if (data.phones.length === 0) {
        info("No phones imported.");
        return;
    }
    console.log("");
    table(
        ["Number", "Name", "Type", "Webhook"],
        data.phones.map((p: any) => [
            p.number,
            p.friendlyName || c.dim("—"),
            c.dim(p.type),
            p.webhookConfigured ? c.green("✓") : c.dim("—"),
        ]),
    );
    info(`${c.bold(String(data.phones.length))} phone${data.phones.length !== 1 ? "s" : ""}`);
}

async function showUsage(config: CliConfig): Promise<void> {
    const data = await pg(config, "/usage");
    const balance = await pg(config, "/usage/balance");

    if (config.json) {
        console.log(JSON.stringify({ ...data, balance }, null, 2));
        return;
    }

    console.log("");
    console.log(`  ${c.bold("Balance:")} $${balance.balance}`);

    if (balance.thisMonth) {
        console.log(`  ${c.bold("This month:")} ${balance.thisMonth.calls} calls, ${balance.thisMonth.minutes} min, $${balance.thisMonth.cost}`);
        if (balance.projectedMonthly) {
            console.log(`  ${c.dim("Projected:")} $${balance.projectedMonthly}/month`);
        }
    }

    if (data.events.length > 0) {
        console.log(`\n  ${c.bold("Recent calls")} ${c.dim(`(${data.summary.totalCalls} total)`)}`);
        table(
            ["Call ID", "Agent", "Duration", "Cost", "Date"],
            data.events.slice(0, 20).map((e: any) => [
                c.dim(e.callId.slice(0, 16) + (e.callId.length > 16 ? "..." : "")),
                e.agentSlug || c.dim("—"),
                `${e.durationSeconds}s`,
                `$${e.cost.toFixed(4)}`,
                c.dim(new Date(e.createdAt).toLocaleString()),
            ]),
        );
    }

    // Per-agent breakdown
    if (Object.keys(data.summary.byAgent || {}).length > 0) {
        console.log(`\n  ${c.bold("By agent")}`);
        table(
            ["Agent", "Calls", "Minutes"],
            Object.entries(data.summary.byAgent).map(([agent, stats]: [string, any]) => [
                c.purple(agent),
                String(stats.calls),
                String(stats.minutes),
            ]),
        );
    }

    console.log("");
}

async function showSession(config: CliConfig): Promise<void> {
    const data = await pg(config, "/session");
    if (config.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
    }

    console.log("");
    console.log(`  ${c.bold("Session")} ${c.dim(`(${data.orgName})`)}`);
    console.log(`  ${c.dim("Plan:")} ${data.plan}  ${c.dim("Valid:")} ${data.valid ? c.green("✓") : c.red("✗")}`);

    if (data.credentials?.twilio?.length > 0) {
        console.log(`\n  ${c.dim("Twilio:")} ${data.credentials.twilio.length} account(s)`);
    }

    const providers = Object.keys(data.credentials || {}).filter((k: string) => k !== "twilio");
    if (providers.length > 0) {
        console.log(`  ${c.dim("Providers:")} ${providers.join(", ")}`);
    }

    console.log(`  ${c.dim("Phones:")} ${data.phones?.length || 0}`);
    console.log(`  ${c.dim("Limits:")} ${data.limits?.concurrentCalls || "?"} concurrent, ${data.limits?.dailyCalls || "?"}/day`);
    console.log("");
}

// ── Main ────────────────────────────────────────────────────────────────

const ACCOUNT_HELP = `
  ${c.bold("pinecall account")} — Manage your Pinecall organization

  ${c.bold("Subcommands:")}
    ${c.dim("(none)")}               Show full account overview
    keys                   List API keys
    keys create [name]     Create a new API key
    twilio                 List linked Twilio accounts
    phones                 List imported phone numbers
    usage                  Show usage + billing
    session                Show resolved session (for debugging)

  ${c.bold("Examples:")}
    ${c.dim("$")} pinecall account
    ${c.dim("$")} pinecall account keys
    ${c.dim("$")} pinecall account keys create "Production"
    ${c.dim("$")} pinecall account usage --json
`;

export async function accountCommand(config: CliConfig, args: string[]): Promise<void> {
    // Find subcommand (skip flags and "account" itself)
    const positional = args.filter((a) => !a.startsWith("-") && a !== "account");
    const sub = positional[0];

    if (args.includes("--help") || args.includes("-h")) {
        console.log(ACCOUNT_HELP);
        return;
    }

    switch (sub) {
        case undefined:
            await showAccount(config);
            break;
        case "keys": {
            const sub2 = positional[1];
            if (sub2 === "create") {
                const name = positional[2] || "CLI";
                await createKey(config, name);
            } else {
                await showKeys(config);
            }
            break;
        }
        case "twilio":
            await showTwilio(config);
            break;
        case "phones":
            await showPhones(config);
            break;
        case "usage":
            await showUsage(config);
            break;
        case "session":
            await showSession(config);
            break;
        default:
            error(`Unknown subcommand: ${sub}\n\n  Run ${c.dim("pinecall account --help")} for usage.`);
    }
}

/**
 * CLI — `pinecall account`
 *
 * Shows org info, keys, Twilio accounts, phones, and usage.
 * Talks to the Playground API.
 */

import type { CliConfig } from "../config.js";
import { c, table, info, error, section, kv, badge } from "../ui.js";

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

    // ── Header ──
    console.log("");
    console.log(`  ${c.purple("⚡")} ${c.bold(org.name)} ${c.dim(`— ${org.slug}`)}`);
    console.log(`    ${c.dim("Plan")} ${c.cyan(org.plan)}  ${c.dim("·")}  ${c.dim("Balance")} ${c.green("$" + org.balance)}  ${c.dim("·")}  ${c.dim("Email")} ${org.email || "—"}`);

    // ── Keys ──
    if (keysData.keys.length > 0) {
        section("API Keys", keysData.keys.length);
        table(
            ["Key", "Name", "Created"],
            keysData.keys.map((k: any) => [
                c.dim(k.keyPreview),
                c.bold(k.name),
                c.dim(new Date(k.createdAt).toLocaleDateString()),
            ]),
            4,
        );
    }

    // ── Twilio ──
    if (twilioData.accounts.length > 0) {
        section("Twilio", twilioData.accounts.length);
        table(
            ["Account", "SID", "Imported", "Balance", "Status"],
            twilioData.accounts.map((a: any) => [
                c.bold(a.friendlyName || "—"),
                c.dim(a.accountSid.slice(0, 14) + "…"),
                c.cyan(String(a.phoneCount) + " phones"),
                a.balance && a.balance !== "?" ? c.green("$" + Number(a.balance).toFixed(2)) : c.dim("—"),
                a.verified ? c.green("verified") : c.red("unverified"),
            ]),
            4,
        );
    }

    // ── Phones ──
    if (phonesData.phones.length > 0) {
        section("Phones", phonesData.phones.length);
        table(
            ["Number", "Name", "Type"],
            phonesData.phones.map((p: any) => [
                c.green(p.number),
                p.friendlyName || c.dim("—"),
                c.dim(p.type),
            ]),
            4,
        );
    }

    console.log("");
    console.log(`  ${c.dim("Run")} ${c.cyan("pinecall twilio")} ${c.dim("for phone import details")}`);
    console.log(`  ${c.dim("Run")} ${c.cyan("pinecall account keys")}${c.dim(",")} ${c.cyan("usage")}${c.dim(",")} ${c.cyan("session")} ${c.dim("for more")}`);
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
    section("API Keys", data.keys.length);
    table(
        ["Key", "Name", "Created", "Last Used"],
        data.keys.map((k: any) => [
            c.dim(k.keyPreview),
            c.bold(k.name),
            c.dim(new Date(k.createdAt).toLocaleDateString()),
            k.lastUsedAt ? c.dim(new Date(k.lastUsedAt).toLocaleDateString()) : c.dim("never"),
        ]),
        4,
    );
    console.log("");
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
    console.log(`    ${c.bold(data.key)}`);
    console.log("");
    console.log(`    ${c.dim("⚠ Save this — it won't be shown again.")}`);
    console.log("");
}

async function showTwilio(config: CliConfig): Promise<void> {
    const data = await pg(config, "/twilio?available=true");
    if (config.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
    }
    if (data.accounts.length === 0) {
        console.log("");
        console.log(`  ${c.dim("No Twilio accounts linked.")}`)
        console.log(`  ${c.dim("Link one with:")} ${c.cyan("pinecall twilio link <SID> <AuthToken>")}`);
        console.log("");
        return;
    }

    for (const a of data.accounts) {
        const imported = a.importedCount ?? a.phoneCount ?? 0;
        const total = a.totalOnTwilio ?? "?";
        const status = a.verified ? c.green("verified") : c.red("unverified");

        section(a.friendlyName || "Unnamed");
        kv("SID", c.dim(a.accountSid));
        kv("Status", status);
        if (a.balance && a.balance !== "?") {
            kv("Balance", c.green("$" + Number(a.balance).toFixed(2)));
        }
        kv("Phones", `${c.green(String(imported))} imported  ${c.dim("/")}  ${c.yellow(String(total))} on Twilio`);

        if (a.availablePhones?.length > 0) {
            const importedPhones = a.availablePhones.filter((p: any) => p.imported);
            const availablePhones = a.availablePhones.filter((p: any) => !p.imported);

            if (importedPhones.length > 0) {
                console.log(`\n    ${c.green("●")} ${c.bold("Imported")}`);
                table(
                    ["Number", "Name", "Type"],
                    importedPhones.map((p: any) => [
                        c.green(p.number),
                        p.name || c.dim("—"),
                        c.dim(p.type),
                    ]),
                    6,
                );
            }

            if (availablePhones.length > 0) {
                console.log(`\n    ${c.yellow("○")} ${c.dim("Available")} ${c.dim("— import with")} ${c.cyan("pinecall twilio import <number>")}`);
                table(
                    ["Number", "Name", "Type"],
                    availablePhones.map((p: any) => [
                        c.yellow(p.number),
                        c.dim(p.name || "—"),
                        c.dim(p.type),
                    ]),
                    6,
                );
            }
        }
    }


    console.log("");
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
    section("Imported Phones", data.phones.length);
    table(
        ["Number", "Name", "Type", "Webhook"],
        data.phones.map((p: any) => [
            c.green(p.number),
            p.friendlyName || c.dim("—"),
            c.dim(p.type),
            p.webhookConfigured ? c.green("✓") : c.dim("—"),
        ]),
        4,
    );
    console.log("");
}

async function showUsage(config: CliConfig): Promise<void> {
    const data = await pg(config, "/usage");
    const balance = await pg(config, "/usage/balance");

    if (config.json) {
        console.log(JSON.stringify({ ...data, balance }, null, 2));
        return;
    }

    section("Usage & Billing");
    kv("Balance", c.green(`$${balance.balance}`));

    if (balance.thisMonth) {
        kv("This month", `${balance.thisMonth.calls} calls  ${c.dim("·")}  ${balance.thisMonth.minutes} min  ${c.dim("·")}  $${balance.thisMonth.cost}`);
        if (balance.projectedMonthly) {
            kv("Projected", c.dim(`$${balance.projectedMonthly}/month`));
        }
    }

    if (data.events?.length > 0) {
        console.log("");
        console.log(`    ${c.bold("Recent")} ${c.dim(`(${data.summary.totalCalls} total)`)}`);
        table(
            ["Call ID", "Agent", "Duration", "Cost", "Date"],
            data.events.slice(0, 15).map((e: any) => [
                c.dim(e.callId.slice(0, 12) + "…"),
                e.agentSlug ? c.purple(e.agentSlug) : c.dim("—"),
                `${e.durationSeconds}s`,
                c.dim(`$${e.cost.toFixed(4)}`),
                c.dim(new Date(e.createdAt).toLocaleString()),
            ]),
            6,
        );
    }

    if (data.summary?.byAgent && Object.keys(data.summary.byAgent).length > 0) {
        console.log("");
        console.log(`    ${c.bold("By Agent")}`);
        table(
            ["Agent", "Calls", "Minutes"],
            Object.entries(data.summary.byAgent).map(([agent, stats]: [string, any]) => [
                c.purple(agent),
                String(stats.calls),
                String(stats.minutes),
            ]),
            6,
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

    section("Session");
    kv("Org", c.bold(data.orgName));
    kv("Plan", c.cyan(data.plan));
    kv("Valid", data.valid ? c.green("✓ yes") : c.red("✗ no"));

    if (data.credentials?.twilio?.length > 0) {
        kv("Twilio", `${data.credentials.twilio.length} account(s)`);
    }
    const providers = Object.keys(data.credentials || {}).filter((k: string) => k !== "twilio");
    if (providers.length > 0) {
        kv("Providers", providers.join(", "));
    }
    kv("Phones", String(data.phones?.length || 0));
    kv("Limits", `${data.limits?.concurrentCalls || "?"} concurrent  ${c.dim("·")}  ${data.limits?.dailyCalls || "?"}/day`);
    console.log("");
}

// ── Twilio write operations ─────────────────────────────────────────────

async function linkTwilio(config: CliConfig, accountSid: string, authToken: string, name?: string): Promise<void> {
    const body: any = { accountSid, authToken };
    if (name) body.friendlyName = name;

    const data = await pg(config, "/twilio", {
        method: "POST",
        body: JSON.stringify(body),
    });

    if (config.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
    }

    console.log("");
    console.log(`  ${c.green("✓")} Linked ${c.bold(data.friendlyName || data.accountSid)}`);
    kv("SID", c.dim(data.accountSid));
    kv("Verified", data.verified ? c.green("yes") : c.red("no"));

    if (data.availablePhones?.length > 0) {
        console.log(`\n  ${c.bold("Available phones")} ${c.dim(`(${data.availablePhones.length})`)}`);
        table(
            ["Number", "Name", "Type"],
            data.availablePhones.map((p: any) => [
                c.yellow(p.number),
                p.name || c.dim("—"),
                c.dim(p.type),
            ]),
            4,
        );
        console.log(`\n  ${c.dim("Import with:")} ${c.cyan("pinecall twilio import <number>")}`);
    }

    console.log("");
}

async function importPhone(config: CliConfig, number: string): Promise<void> {
    // Find the phone in available phones across all Twilio accounts
    const data = await pg(config, "/twilio?available=true");

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
        error(`Phone ${number} not found in any linked Twilio account.\n\n  Run ${c.dim("pinecall twilio")} to see available phones.`);
    }

    if (targetPhone.imported) {
        info(`${c.green(targetPhone.number)} is already imported.`);
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
    console.log(`  ${c.green("✓")} Imported ${c.green(targetPhone.number)}`);
    kv("Name", targetPhone.name || "—");
    kv("Account", targetAccount.friendlyName || targetAccount.accountSid);
    kv("Webhook", result.imported?.[0]?.webhookConfigured ? c.green("configured") : c.yellow("skipped"));
    console.log("");
}

async function unlinkTwilio(config: CliConfig, accountId: string): Promise<void> {
    // Find account by SID or ID
    const data = await pg(config, "/twilio");
    const account = data.accounts.find((a: any) =>
        a.id === accountId || a.accountSid === accountId || a.accountSid.startsWith(accountId),
    );

    if (!account) {
        error(`Twilio account ${accountId} not found.\n\n  Run ${c.dim("pinecall twilio")} to see linked accounts.`);
    }

    const result = await pg(config, `/twilio/${account.id}`, { method: "DELETE" });

    if (config.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    console.log("");
    console.log(`  ${c.green("✓")} Unlinked ${c.bold(account.friendlyName || account.accountSid)}`);
    if (result.phonesRemoved > 0) {
        console.log(`  ${c.dim(`Removed ${result.phonesRemoved} imported phone(s)`)}`);
    }
    console.log("");
}

// ── Help texts ──────────────────────────────────────────────────────────

const ACCOUNT_HELP = `
  ${c.purple("⚡")} ${c.bold("pinecall account")} — Org overview

  ${c.bold("Subcommands:")}
    ${c.dim("(none)")}               Full account overview
    keys                   List API keys
    keys create [name]     Create a new API key
    phones                 List imported phone numbers
    usage                  Usage + billing
    session                Debug session resolution

  ${c.bold("Related:")}
    ${c.cyan("pinecall twilio")}      Twilio accounts + phone management

  ${c.bold("Examples:")}
    ${c.dim("$")} pinecall account
    ${c.dim("$")} pinecall account keys
    ${c.dim("$")} pinecall account keys create "Production"
    ${c.dim("$")} pinecall account usage --json
`;

const TWILIO_HELP = `
  ${c.purple("⚡")} ${c.bold("pinecall twilio")} — Twilio account management

  ${c.bold("Subcommands:")}
    ${c.dim("(none)")}               List accounts + imported/available phones
    link <SID> <Token>     Link a Twilio account
    import <number>        Import an available phone number
    unlink <SID>           Unlink a Twilio account

  ${c.bold("Getting Started:")}
    ${c.dim("1.")} Link your Twilio account:
       ${c.dim("$")} pinecall twilio link AC1234... your_auth_token

    ${c.dim("2.")} See available phone numbers:
       ${c.dim("$")} pinecall twilio

    ${c.dim("3.")} Import the ones you want to use:
       ${c.dim("$")} pinecall twilio import +1234567890

  ${c.bold("Legend:")}
    ${c.green("● Imported")}   Phone is active in Pinecall
    ${c.yellow("○ Available")}  Phone exists on Twilio but not yet imported

  ${c.bold("No Twilio account?")}
    ${c.dim("Pinecall can provision a shared number for you.")} ${c.dim("(coming soon)")}
`;

const SUBCOMMAND_HELP: Record<string, string> = {
    twilio: TWILIO_HELP,
};

// ── Main ────────────────────────────────────────────────────────────────

export async function accountCommand(config: CliConfig, args: string[]): Promise<void> {
    const positional = args.filter((a) => !a.startsWith("-") && a !== "account");
    const sub = positional[0];
    const wantsHelp = args.includes("--help") || args.includes("-h");

    // Per-subcommand help
    if (wantsHelp) {
        const helpText = (sub && SUBCOMMAND_HELP[sub]) || ACCOUNT_HELP;
        console.log(helpText);
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
        case "twilio": {
            const sub2 = positional[1];
            if (sub2 === "link") {
                const sid = positional[2];
                const token = positional[3];
                if (!sid || !token) error(`Usage: pinecall twilio link <AccountSID> <AuthToken> [name]`);
                await linkTwilio(config, sid, token, positional[4]);
            } else if (sub2 === "import") {
                const num = positional[2];
                if (!num) error(`Usage: pinecall twilio import <phone_number>`);
                await importPhone(config, num);
            } else if (sub2 === "unlink") {
                const sid = positional[2];
                if (!sid) error(`Usage: pinecall twilio unlink <AccountSID>`);
                await unlinkTwilio(config, sid);
            } else {
                await showTwilio(config);
            }
            break;
        }
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

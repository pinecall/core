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

    // Plan + credits line
    const planLabel = org.planDetails?.display || org.plan || "—";
    const credits = org.credits ?? 0;
    const maxCredits = org.planDetails?.credits || credits || 1;
    const creditPct = maxCredits > 0 ? Math.round((credits / maxCredits) * 100) : 0;
    const creditBar = creditPct > 50 ? c.green(`${credits.toLocaleString()}`) : creditPct > 20 ? c.yellow(`${credits.toLocaleString()}`) : c.red(`${credits.toLocaleString()}`);

    console.log(`    ${c.dim("Plan")} ${c.cyan(planLabel)}  ${c.dim("·")}  ${c.dim("Credits")} ${creditBar}${org.planDetails ? c.dim(`/${org.planDetails.credits.toLocaleString()}`) : ""}  ${c.dim("·")}  ${c.dim("Email")} ${org.email || "—"}`);

    // Trial countdown
    if (org.trialEndsAt) {
        const daysLeft = Math.max(0, Math.ceil((new Date(org.trialEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
        if (daysLeft > 0) {
            console.log(`    ${c.yellow("⏱")}  ${c.yellow(`Trial: ${daysLeft} days remaining`)}  ${c.dim("·")}  ${c.dim("Upgrade:")} ${c.cyan("pinecall account upgrade")}`);
        } else {
            console.log(`    ${c.red("⚠")}  ${c.red("Trial expired")}  ${c.dim("·")}  ${c.dim("Upgrade:")} ${c.cyan("pinecall account upgrade")}`);
        }
    }

    // Verified + outbound status
    if (org.verified) {
        console.log(`    ${c.green("✓")} ${c.green("Verified")} ${c.dim("— outbound calls enabled on managed numbers")}`);
    } else {
        console.log(`    ${c.dim("○")} ${c.dim("Not verified — outbound calls restricted")}`);
    }

    // Limits
    if (org.planDetails?.limits) {
        const lim = org.planDetails.limits;
        const stats = await pg(config, "/orgs/me/stats").catch(() => null);
        const phonesUsed = stats?.managedPhones ?? 0;
        const phonesMax = lim.phones >= 999 ? "∞" : String(lim.phones);
        const concurrent = lim.concurrentCalls >= 999 ? "∞" : String(lim.concurrentCalls);
        const agents = lim.agents >= 999 ? "∞" : String(lim.agents);

        console.log(`    ${c.dim("Limits:")} ${c.dim("phones")} ${phonesUsed}/${phonesMax}  ${c.dim("·")}  ${c.dim("concurrent")} ${concurrent}  ${c.dim("·")}  ${c.dim("agents")} ${agents}`);
    }

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
            ["Number", "Name", "Type", "Source"],
            phonesData.phones.map((p: any) => [
                c.green(p.number),
                p.friendlyName || c.dim("—"),
                c.dim(p.type),
                p.managed ? c.cyan("managed") : c.dim("imported"),
            ]),
            4,
        );
    }

    console.log("");
    console.log(`  ${c.dim("Run")} ${c.cyan("pinecall twilio")} ${c.dim("for phone import details")}`);
    console.log(`  ${c.dim("Run")} ${c.cyan("pinecall account usage")} ${c.dim("for credit breakdown")}`);
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

    // Fetch agent phone map for usage status
    let phoneMap: Record<string, string> = {};
    try {
        const agentsRes = await fetch(`${config.server}/api/sdk/agents`, {
            headers: { Authorization: `Bearer ${config.apiKey}` },
        });
        if (agentsRes.ok) {
            const agentsData = await agentsRes.json();
            phoneMap = agentsData.phone_map ?? {};
        }
    } catch {
        // Server unreachable — skip agent info
    }

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
                    ["Number", "Name", "Agent"],
                    importedPhones.map((p: any) => {
                        const agent = phoneMap[p.number];
                        return [
                            c.green(p.number),
                            p.name || c.dim("—"),
                            agent ? c.purple(agent) : c.dim("—"),
                        ];
                    }),
                    6,
                );
            }

            if (availablePhones.length > 0) {
                console.log(`\n    ${c.yellow("○")} ${c.dim("Available")} ${c.dim("— add with")} ${c.cyan("pinecall phones add <number>")}`);
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
    const org = await pg(config, "/orgs/me");
    const summary = await pg(config, "/usage/summary?days=30");

    if (config.json) {
        console.log(JSON.stringify({ org: { plan: org.plan, credits: org.credits }, ...summary }, null, 2));
        return;
    }

    section("Credits & Usage");

    // Credits bar
    const credits = org.credits ?? 0;
    const maxCredits = org.planDetails?.credits || credits || 1;
    const pct = maxCredits > 0 ? Math.round((credits / maxCredits) * 100) : 0;
    const barWidth = 30;
    const filled = Math.round(barWidth * pct / 100);
    const bar = c.green("█".repeat(filled)) + c.dim("░".repeat(barWidth - filled));

    kv("Plan", c.cyan(org.planDetails?.display || org.plan || "—"));
    kv("Credits", `${bar}  ${credits.toLocaleString()}/${maxCredits.toLocaleString()} (${pct}%)`);

    if (org.trialEndsAt) {
        const daysLeft = Math.max(0, Math.ceil((new Date(org.trialEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
        kv("Trial", daysLeft > 0 ? c.yellow(`${daysLeft} days left`) : c.red("Expired"));
    }

    if (org.creditsResetAt) {
        const resetDays = Math.max(0, Math.ceil((new Date(org.creditsResetAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
        kv("Resets in", c.dim(`${resetDays} days`));
    }

    // Usage breakdown by service
    if (summary.byService?.length > 0) {
        console.log("");
        console.log(`    ${c.bold("Usage by Service")} ${c.dim(`(last ${summary.period.days} days)`)}`);

        const serviceColors: Record<string, (s: string) => string> = {
            stt: c.cyan,
            tts: c.purple,
            llm: c.green,
            telephony: c.yellow,
            platform: c.dim,
        };

        table(
            ["Service", "Credits", "Cost", "Events", ""],
            summary.byService.map((s: any) => {
                const color = serviceColors[s.service] || c.dim;
                const svcBar = "█".repeat(Math.max(1, Math.round(s.percentage / 5)));
                return [
                    color(s.service.toUpperCase()),
                    s.credits.toLocaleString(),
                    c.dim(`$${s.costUsd.toFixed(4)}`),
                    c.dim(String(s.events)),
                    color(svcBar) + c.dim(` ${s.percentage}%`),
                ];
            }),
            6,
        );

        console.log("");
        kv("Total consumed", `${summary.total.credits.toLocaleString()} credits  ${c.dim("·")}  $${summary.total.costUsd.toFixed(4)}`);
    } else {
        console.log("");
        info("No usage recorded yet.");
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
        console.log(`\n  ${c.dim("Add with:")} ${c.cyan("pinecall phones add <number>")}`);
    }

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

  ${c.bold("Commands:")}
    ${c.dim("(none)")}               List linked accounts + phone status
    link <SID> <Token>     Link a Twilio account
    unlink <SID>           Unlink a Twilio account

  ${c.bold("Examples:")}
    ${c.dim("$")} pinecall twilio
    ${c.dim("$")} pinecall twilio link AC1234... your_auth_token
    ${c.dim("$")} pinecall twilio unlink AC1234...

  ${c.bold("Phone management:")}
    ${c.dim("Use")} ${c.cyan("pinecall phones")} ${c.dim("to add/remove phone numbers.")}
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

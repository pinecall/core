/**
 * CLI — `pinecall phone`
 *
 * Manage phone numbers — request managed numbers from Pinecall.
 * Talks to the Playground API.
 */

import type { CliConfig } from "../config.js";
import { c, table, info, error, section, kv } from "../ui.js";

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

async function requestPhone(config: CliConfig, args: string[]): Promise<void> {
    // Parse flags
    const countryArg = args.find((a) => a.startsWith("--country="));
    const areaCodeArg = args.find((a) => a.startsWith("--area-code="));
    const nameArg = args.find((a) => a.startsWith("--name="));

    const country = countryArg ? countryArg.slice("--country=".length) : "US";
    const areaCode = areaCodeArg ? areaCodeArg.slice("--area-code=".length) : undefined;
    const friendlyName = nameArg ? nameArg.slice("--name=".length) : undefined;

    const body: any = { country };
    if (areaCode) body.areaCode = areaCode;
    if (friendlyName) body.friendlyName = friendlyName;

    const data = await pg(config, "/phones/provision", {
        method: "POST",
        body: JSON.stringify(body),
    });

    if (config.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
    }

    console.log("");
    console.log(`  ${c.green("✓")} Number provisioned!`);
    console.log("");
    console.log(`  ${c.bold(c.green(data.phone.number))}`);
    console.log("");
    kv("Name", data.phone.friendlyName || "—");
    kv("Type", "managed");
    kv("Rate", c.yellow(data.phone.rate));
    kv("Webhook", data.phone.webhookConfigured ? c.green("configured") : c.dim("pending"));
    console.log("");
    console.log(`  ${c.dim("This number is ready to receive calls.")}`);
    console.log(`  ${c.dim("Connect an agent and assign it with")} ${c.cyan("agent.phone()")}`);
    console.log("");
}

async function searchPhones(config: CliConfig, args: string[]): Promise<void> {
    const countryArg = args.find((a) => a.startsWith("--country="));
    const areaCodeArg = args.find((a) => a.startsWith("--area-code="));
    const country = countryArg ? countryArg.slice("--country=".length) : "US";
    const areaCode = areaCodeArg ? areaCodeArg.slice("--area-code=".length) : undefined;

    const params = new URLSearchParams({ country });
    if (areaCode) params.set("areaCode", areaCode);

    const data = await pg(config, `/phones/search?${params}`);

    if (config.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
    }

    if (!data.numbers || data.numbers.length === 0) {
        info(`No numbers available in ${country}${areaCode ? ` (${areaCode})` : ""}`);
        return;
    }

    section("Available Numbers", data.numbers.length);
    table(
        ["Number", "Name", "Location"],
        data.numbers.map((n: any) => [
            c.cyan(n.number),
            n.friendlyName || c.dim("—"),
            c.dim([n.locality, n.region].filter(Boolean).join(", ") || "—"),
        ]),
        4,
    );
    console.log(`\n  ${c.dim("Request one with:")} ${c.cyan("pinecall phone request")}`);
    console.log("");
}

const PHONE_HELP = `
  ${c.purple("⚡")} ${c.bold("pinecall phone")} — Phone number management

  ${c.bold("Subcommands:")}
    request                Provision a managed number from Pinecall
    search                 Search available numbers before requesting

  ${c.bold("Options:")}
    --country=XX           Country code (default: US)
    --area-code=NNN        Preferred area code
    --name=NAME            Friendly name for the number

  ${c.bold("Examples:")}
    ${c.dim("$")} pinecall phone search --country=US
    ${c.dim("$")} pinecall phone search --area-code=415
    ${c.dim("$")} pinecall phone request
    ${c.dim("$")} pinecall phone request --country=US --area-code=312 --name="Support"

  ${c.bold("BYOC?")} ${c.dim("If you have your own Twilio account, use")}
    ${c.cyan("pinecall twilio link")} ${c.dim("instead.")}
`;

export async function phoneCommand(config: CliConfig, args: string[]): Promise<void> {
    const positional = args.filter((a) => !a.startsWith("-") && a !== "phone");
    const sub = positional[0];

    if (args.includes("--help") || args.includes("-h")) {
        console.log(PHONE_HELP);
        return;
    }

    switch (sub) {
        case "request":
            await requestPhone(config, args);
            break;
        case "search":
            await searchPhones(config, args);
            break;
        case undefined:
            console.log(PHONE_HELP);
            break;
        default:
            error(`Unknown subcommand: ${sub}\n\n  Run ${c.dim("pinecall phone --help")} for usage.`);
    }
}

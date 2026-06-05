/**
 * CLI — `pinecall signup`
 *
 * Creates a new org + API key. No auth required.
 * Talks to the Playground API.
 */

import type { CliConfig } from "../config.js";
import { c, error, section, kv } from "../ui.js";

export async function signupCommand(config: CliConfig, args: string[]): Promise<void> {
    const positional = args.filter((a) => !a.startsWith("-") && a !== "signup");
    const name = positional[0];

    if (args.includes("--help") || args.includes("-h")) {
        console.log(SIGNUP_HELP);
        return;
    }

    if (!name) {
        error(`Usage: pinecall signup <org-name> [--email=you@example.com]`);
    }

    // Parse optional email
    const emailArg = args.find((a) => a.startsWith("--email="));
    const email = emailArg ? emailArg.slice("--email=".length) : undefined;

    const body: any = { name };
    if (email) body.email = email;

    // Signup doesn't need auth — POST directly to playground
    const url = `${config.playground}/api/orgs`;
    let res: Response;

    try {
        res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    } catch {
        error(`Cannot reach Playground at ${config.playground}`);
    }

    if (!res!.ok) {
        const err = await res!.text();
        error(`Signup failed: ${err}`);
    }

    const data = await res!.json();

    if (config.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
    }

    console.log("");
    console.log(`  ${c.green("✓")} Organization created!`);

    section(data.org.name);
    kv("Slug", c.dim(data.org.slug));
    kv("Plan", c.cyan(data.org.plan));
    if (data.org.email) kv("Email", data.org.email);

    console.log("");
    console.log(`  ${c.bold("Your API Key:")}`);
    console.log(`  ${c.green(data.apiKey.key)}`);
    console.log("");
    console.log(`  ${c.dim("⚠ Save this — it won't be shown again.")}`);
    console.log("");
    console.log(`  ${c.bold("Next steps:")}`);
    console.log(`    ${c.dim("1.")} Export your key:`);
    console.log(`       ${c.cyan("export PINECALL_API_KEY=" + data.apiKey.key)}`);
    console.log(`    ${c.dim("2.")} Link Twilio ${c.dim("(if you have one)")}:`);
    console.log(`       ${c.cyan("pinecall twilio link <SID> <Token>")}`);
    console.log(`    ${c.dim("3.")} Or get a managed number:`);
    console.log(`       ${c.cyan("pinecall phone request")}`);
    console.log("");
}

const SIGNUP_HELP = `
  ${c.purple("⚡")} ${c.bold("pinecall signup")} — Create a new organization

  ${c.bold("Usage:")}
    ${c.dim("$")} pinecall signup "My Company"
    ${c.dim("$")} pinecall signup "My Company" --email=me@example.com

  ${c.bold("What happens:")}
    ${c.dim("1.")} Creates your organization
    ${c.dim("2.")} Generates your first API key
    ${c.dim("3.")} You're ready to connect agents

  ${c.dim("No API key needed — this is the first step.")}
`;

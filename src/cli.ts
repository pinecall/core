/**
 * pinecall — CLI entry point.
 *
 * Inspect connected agents, phone numbers, voices, and Twilio balance.
 * Built as a separate tsup entry → dist/cli.js with shebang.
 *
 * Usage:
 *   pinecall agents                     List connected agents
 *   pinecall phones                     List phone numbers
 *   pinecall voices [--provider] [--language]  List TTS voices
 *   pinecall chat [agent]               Chat with a connected agent
 *   pinecall balance                    Show Twilio balance
 *   pinecall account                    Org overview (keys, twilio, phones)
 *   pinecall twilio                     Twilio accounts + phone import status
 *
 * Options:
 *   --api-key=pk_...   Override PINECALL_API_KEY
 *   --server=URL       Override server (default: https://voice.pinecall.io)
 *   --json             Raw JSON output
 *   -h, --help         Show help
 *   -v, --version      Show version
 */

import { resolveConfig } from "./cli/config.js";
import { c, error } from "./cli/ui.js";

const VERSION = "0.2.7";

const HELP = `
  ${c.purple("⚡")} ${c.bold("pinecall")} ${c.dim(`v${VERSION}`)}

  ${c.bold("Voice Server")}
    agents                 ${c.dim("List connected agents + phones")}
    phones                 ${c.dim("List phone numbers (with agent assignment)")}
    voices                 ${c.dim("List available TTS voices")}
    chat [agent]           ${c.dim("Chat with a connected agent")}
    test <path>            ${c.dim("Run agent specs (YAML test files)")}
    balance                ${c.dim("Show Twilio account balance")}

  ${c.bold("Account Management")}
    signup                 ${c.dim("Create a new organization")}
    account                ${c.dim("Org overview (keys, twilio, phones)")}
    account keys           ${c.dim("List / create API keys")}
    account usage          ${c.dim("Usage + billing")}
    twilio                 ${c.dim("List Twilio accounts + phone status")}
    twilio link            ${c.dim("Link a Twilio account")}
    twilio import          ${c.dim("Import a phone number")}
    phone request          ${c.dim("Get a managed number from Pinecall")}
    phone search           ${c.dim("Search available numbers")}

  ${c.bold("Options")}
    --api-key=pk_...       ${c.dim("Override PINECALL_API_KEY env var")}
    --server=URL           ${c.dim("Override voice server URL")}
    --playground=URL       ${c.dim("Override playground URL")}
    --json                 ${c.dim("Output raw JSON")}

  ${c.bold("Environment")}
    PINECALL_API_KEY       ${c.dim("Your Pinecall API key")}
    PINECALL_URL           ${c.dim("Voice server URL")}
    PINECALL_PLAYGROUND_URL ${c.dim("Playground API URL")}
`;

// Commands that handle their own --help
const SELF_HELP_COMMANDS = new Set(["account", "twilio", "voices", "test", "chat", "signup", "phone"]);

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const command = args.find((a) => !a.startsWith("-"));

    // Version
    if (args.includes("--version") || args.includes("-v")) {
        console.log(VERSION);
        return;
    }

    // Global help — only if no command or command doesn't handle its own help
    const wantsHelp = args.includes("--help") || args.includes("-h");
    if (args.length === 0 || (wantsHelp && (!command || !SELF_HELP_COMMANDS.has(command)))) {
        console.log(HELP);
        return;
    }

    if (!command) {
        console.log(HELP);
        return;
    }

    // Signup doesn't need API key — handle before resolveConfig
    if (command === "signup") {
        const { resolveConfig: rc } = await import("./cli/config.js");
        // Build a config without requiring API key
        const playgroundArg = args.find(a => a.startsWith("--playground="));
        const playground = playgroundArg
            ? playgroundArg.slice("--playground=".length)
            : process.env.PINECALL_PLAYGROUND_URL ?? "http://localhost:4000";
        const config = { apiKey: "", server: "", playground: playground.replace(/\/+$/, ""), json: args.includes("--json") };
        const { signupCommand } = await import("./cli/commands/signup.js");
        await signupCommand(config, args);
        return;
    }

    // Resolve config (api key, server, json flag)
    const config = resolveConfig(args);

    switch (command) {
        case "agents": {
            const { agentsCommand } = await import("./cli/commands/agents.js");
            await agentsCommand(config);
            break;
        }
        case "phones": {
            const { phonesCommand } = await import("./cli/commands/phones.js");
            await phonesCommand(config);
            break;
        }
        case "voices": {
            const { voicesCommand } = await import("./cli/commands/voices.js");
            await voicesCommand(config, args);
            break;
        }
        case "balance": {
            const { balanceCommand } = await import("./cli/commands/balance.js");
            await balanceCommand(config);
            break;
        }
        case "chat": {
            const { chatCommand } = await import("./cli/commands/chat.js");
            await chatCommand(config, args);
            break;
        }
        case "test": {
            const { testCommand } = await import("./cli/commands/test.js");
            await testCommand(config, args);
            break;
        }
        case "account": {
            const { accountCommand } = await import("./cli/commands/account.js");
            await accountCommand(config, args);
            break;
        }
        case "twilio": {
            // Top-level alias → delegates to account twilio
            const { accountCommand } = await import("./cli/commands/account.js");
            await accountCommand(config, ["account", "twilio", ...args.filter(a => a !== "twilio")]);
            break;
        }
        case "phone": {
            const { phoneCommand } = await import("./cli/commands/phone.js");
            await phoneCommand(config, args);
            break;
        }
        default:
            error(`Unknown command: ${command}\n\n  Run ${c.dim("pinecall --help")} for usage.`);
    }
}

main().catch((err) => {
    console.error(`\n  ${c.red("✗")} ${err.message ?? err}\n`);
    process.exit(1);
});

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
 *
 * Options:
 *   --api-key=pk_...   Override PINECALL_API_KEY
 *   --server=URL       Override server (default: https://voice.pinecall.io)
 *   --json             Raw JSON output
 *   -h, --help         Show help
 *   -v, --version      Show version
 */

import { resolveConfig } from "./cli/config.js";
import { banner, c, error } from "./cli/ui.js";

const VERSION = "0.2.7";

const HELP = `
  ${c.purple("⚡")} ${c.bold("pinecall")} ${c.dim(`v${VERSION}`)}

  ${c.bold("Commands:")}
    agents                 ${c.dim("List connected agents + phones")}
    phones                 ${c.dim("List phone numbers (with agent assignment)")}
    voices                 ${c.dim("List available TTS voices")}
    chat [agent]           ${c.dim("Chat with a connected agent")}
    test <path>            ${c.dim("Run agent specs (YAML test files)")}
    balance                ${c.dim("Show Twilio account balance")}
    account [sub]          ${c.dim("Manage org, keys, twilio, phones, usage")}

  ${c.bold("Options:")}
    --api-key=pk_...       ${c.dim("Override PINECALL_API_KEY env var")}
    --server=URL           ${c.dim("Override server URL")}
    --json                 ${c.dim("Output raw JSON")}
    -h, --help             ${c.dim("Show this help")}
    -v, --version          ${c.dim("Show version")}

  ${c.bold("Voices options:")}
    --provider=NAME        ${c.dim("Filter by provider (elevenlabs, cartesia)")}
    --language=CODE        ${c.dim("Filter by language code (en, es, ...)")}

  ${c.bold("Environment:")}
    PINECALL_API_KEY       ${c.dim("Your Pinecall API key")}
    PINECALL_URL           ${c.dim("Custom server URL")}
    PINECALL_PLAYGROUND_URL ${c.dim("Custom playground URL")}

  ${c.bold("Examples:")}
    ${c.dim("$")} pinecall agents
    ${c.dim("$")} pinecall phones
    ${c.dim("$")} pinecall voices --provider=elevenlabs --language=es
    ${c.dim("$")} pinecall chat mara
    ${c.dim("$")} pinecall balance --json
    ${c.dim("$")} pinecall account
    ${c.dim("$")} pinecall account keys
    ${c.dim("$")} pinecall account usage
`;

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const command = args.find((a) => !a.startsWith("-"));

    // Help / version
    if (args.includes("--help") || args.includes("-h") || args.length === 0) {
        console.log(HELP);
        return;
    }
    if (args.includes("--version") || args.includes("-v")) {
        console.log(VERSION);
        return;
    }

    if (!command) {
        console.log(HELP);
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
        default:
            error(`Unknown command: ${command}\n\n  Run ${c.dim("pinecall --help")} for usage.`);
    }
}

main().catch((err) => {
    console.error(`\n  ${c.red("✗")} ${err.message ?? err}\n`);
    process.exit(1);
});

/**
 * configure_agent — create or hot-reload a DEV agent from the editor.
 *
 * Two hard facts shape this tool:
 *
 * 1. `pc.agent(slug, config)` hot-reloads the LIVE agent under that name. It is
 *    not a draft and there is no staging step. Pointing it at a production slug
 *    either clobbers the running config or fights the pm2 process that owns the
 *    name — and that process wins on its next reconnect. So: slugs must start
 *    with `dev-`. No flag turns this off.
 *
 * 2. The registration lives in the server's memory for exactly as long as the
 *    socket that made it (see agent-hosts.ts for the citation). So the client
 *    is HELD for the MCP session — `heldBySession: true` — and the agent stops
 *    existing when this MCP server exits.
 */

import { z } from "zod";
import { defineTool } from "./types.js";
import { agentHosts } from "../agent-hosts.js";
import type { AgentConfig } from "../../../src/config/agent.js";

export const DEV_PREFIX = "dev-";

export class ProdSlugRefused extends Error {
    constructor(slug: string) {
        super(
            `Refusing to configure "${slug}": configure_agent only accepts slugs starting with "${DEV_PREFIX}".\n\n` +
            `This is not a safety rail that can be switched off — it is the mechanics:\n` +
            `  · pc.agent(slug, config) HOT-RELOADS the LIVE agent under that name. There is no ` +
            `draft, no staging, no publish step: the next call/chat on "${slug}" uses whatever ` +
            `config was pushed last.\n` +
            `  · A production slug is owned by a long-running SDK process (pm2, a container). Even ` +
            `if this tool won the name for a moment, that process re-registers "${slug}" on its ` +
            `next reconnect and RE-CLOBBERS your config — so the change is both dangerous and ` +
            `not durable.\n` +
            `  · Production agents are deployed from code, from their own repo. Never from an MCP tool.\n\n` +
            `Do this instead: configure_agent("${DEV_PREFIX}${slug.replace(/^dev-/, "")}", {...}), ` +
            `iterate on it with chat, then copy the settled config into the agent's source and deploy it.`,
        );
        this.name = "ProdSlugRefused";
    }
}

const schema = {
    slug: z
        .string()
        .min(1)
        .describe('Agent id. MUST start with "dev-" — production slugs are refused.'),
    prompt: z.string().optional().describe("System prompt for the LLM."),
    llm: z.string().optional().describe('Server-side LLM, e.g. "openai/gpt-4.1-mini" (see list_models).'),
    stt: z.string().optional().describe('Speech-to-text, e.g. "deepgram/flux" (see list_models).'),
    voice: z.string().optional().describe('TTS voice as "provider/friendly-id", e.g. "elevenlabs/sarah" (see list_voices).'),
    language: z.string().optional().describe('ISO language code, e.g. "es". Affects STT and TTS model defaults.'),
    greeting: z.string().optional().describe("Spoken/sent on every inbound call before the user says anything."),
    phoneNumber: z
        .string()
        .optional()
        .describe("E.164 number this dev agent should answer on (see list_phones). It is released when the session ends."),
};

export default defineTool({
    name: "configure_agent",
    description:
        "Create or hot-reload a DEV agent (slug must start with dev-) and hold it live for this session, so chat and calls can reach it.",
    schema,
    manual: [
        "**`configure_agent`** — the create→chat→iterate loop.",
        "",
        "1. `configure_agent({ slug: \"dev-<name>\", prompt, llm, voice, language, greeting })`",
        "2. `chat` against that same slug and read what it actually says.",
        "3. Not right? Call `configure_agent` again with the corrected prompt — same slug. It",
        "   hot-reloads in place; the next chat turn uses the new config. Repeat until it behaves.",
        "   ⚠️ A re-configure REPLACES the whole config, it does not merge: pass every field you",
        "   still want (llm, voice, language, …), not only the one you are changing.",
        "4. When it settles, copy the config into the project's own SDK source",
        "   (`pc.agent(...)` in a file run by `pinecall run`) and deploy it from there.",
        "",
        "**Only `dev-` slugs.** A non-`dev-` slug is refused, always, with no override — this is",
        "mechanics, not policy: `pc.agent()` hot-reloads the LIVE agent, and a production slug is",
        "owned by a long-running process that re-registers (and re-clobbers) it on its next",
        "reconnect. Production agents are deployed from code.",
        "",
        "**The agent lives only while this MCP session lives.** Pinecall keeps registrations in",
        "memory, bound to the SDK socket that made them, so this server holds one connection open",
        "per configured slug (`heldBySession: true` in the result). When the editor closes the MCP",
        "server, the dev agent disappears and its phone number is freed. That is expected, and it",
        "is why `dev-` agents never need cleaning up by hand.",
        "",
        "**Code tools cannot travel over MCP.** `tools:` / `skills:` are JavaScript functions that",
        "execute in YOUR process when the model calls them — there is nothing to send over a JSON",
        "tool call. An agent with tools needs a real SDK process (`pinecall run agent.ts`); see the",
        "`tool()` guide in the docs (`docs_search(\"tools\")`). Everything else — prompt, llm, stt,",
        "voice, language, greeting, phoneNumber — is configurable from here.",
    ].join("\n"),
    async handler(args: any, { session }) {
        const slug = String(args.slug ?? "").trim();
        if (!slug.startsWith(DEV_PREFIX)) throw new ProdSlugRefused(slug);

        const config: AgentConfig = {};
        if (args.prompt !== undefined) config.prompt = args.prompt;
        if (args.llm !== undefined) config.llm = args.llm;
        if (args.stt !== undefined) config.stt = args.stt;
        if (args.voice !== undefined) config.voice = args.voice;
        if (args.language !== undefined) config.language = args.language;
        if (args.greeting !== undefined) config.greeting = args.greeting;
        if (args.phoneNumber !== undefined) config.phoneNumber = args.phoneNumber;

        const host = await agentHosts.configure(slug, config, {
            apiKey: session.apiKey(),
            apiUrl: session.serverUrl,
        });

        return {
            slug,
            live: true,
            heldBySession: true,
            revision: host.revision,
            applied: Object.keys(config).sort(),
            phoneNumber: config.phoneNumber ?? null,
            note:
                host.revision > 1
                    ? "Hot-reloaded in place — the next chat turn uses this config."
                    : "Registered and held open by this MCP session. It disappears when the session ends; deploy from code for anything permanent.",
        };
    },
});

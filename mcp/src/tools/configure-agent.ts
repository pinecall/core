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
 *
 * 3. `phoneNumber` is NOT a stored config field — it becomes a `channel.add`
 *    frame, which is fire-and-forget and can be REFUSED with a `PHONE_IN_USE`
 *    error event that the SDK only console.warns about. So this tool verifies
 *    the claim by reading the server's routing state back before reporting
 *    anything. See phone-routing.ts for the mechanism and the incident.
 */

import { z } from "zod";
import { defineTool } from "./types.js";
import { agentHosts } from "../agent-hosts.js";
import { verifyPhoneRouting, type PhoneRouting, type RoutingState } from "../phone-routing.js";
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
    manual:
        "A re-configure REPLACES the config: resend every field you still want. Non-`dev-` refused; `heldBySession` for this session. No `tools` param — code tools need an SDK process (`run_agent` / `pinecall run`, `docs_search` it). `phoneNumber` is verified against live routing: the server refuses (`PHONE_IN_USE`) a number another dev agent holds, so `routed:false` + `routedTo` means take a free `list_phones` number. Relay `dialThisNumber`; never invite a call when it is null.",
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

        // A phone claim is fire-and-forget on the wire and can be REFUSED
        // silently (PHONE_IN_USE). Never report it as applied on faith —
        // read the server's routing state back and say what is true.
        // The schema only accepts a string, so this is always the E.164 form.
        const requestedPhone = typeof config.phoneNumber === "string" ? config.phoneNumber : undefined;
        let phone: PhoneRouting | undefined;
        if (requestedPhone !== undefined) {
            phone = await verifyPhoneRouting(slug, requestedPhone, () =>
                session.server<RoutingState>("/api/sdk/agents"),
            );
        }

        // `applied` is a claim of effect, so a refused number must not appear in it.
        const applied = Object.keys(config)
            .filter((k) => k !== "phoneNumber" || phone?.routed)
            .sort();

        return {
            slug,
            live: true,
            heldBySession: true,
            revision: host.revision,
            applied,
            ...(phone
                ? {
                      phoneNumber: phone.routed ? phone.number : null,
                      routed: phone.routed,
                      ...(phone.routedTo ? { routedTo: phone.routedTo } : {}),
                      reason: phone.reason,
                      dialThisNumber: phone.dial,
                      ...(phone.callersWhitelist ? { callersWhitelist: phone.callersWhitelist } : {}),
                  }
                : { phoneNumber: null }),
            note:
                host.revision > 1
                    ? "Hot-reloaded in place — the next chat turn uses this config."
                    : "Registered and held open by this MCP session. It disappears when the session ends; deploy from code for anything permanent.",
        };
    },
});

/**
 * whoami — who this API key belongs to.
 *
 * Same call the CLI's `pinecall account` / `pinecall balance` make:
 * GET {playground}/api/orgs/me.
 */

import { defineTool } from "./types.js";

export default defineTool({
    name: "whoami",
    description: "The org this API key belongs to — name, slug, plan/tier and remaining credits.",
    schema: {},
    manual: [
        "**`whoami`** — call it FIRST, before anything else. It is the auth probe: it",
        "proves the key works and tells you which org you are about to change.",
        "Returns `{ org, slug, plan, credits, creditLimit, trialEndsAt, server, playground }`.",
        "If it errors with a missing key, call `set_api_key`. If it 401s, the key is wrong —",
        "do not retry the other tools, they will all fail the same way.",
    ].join("\n"),
    async handler(_args, { session }) {
        const org = await session.playground<any>("/orgs/me");
        return {
            org: org.name ?? null,
            slug: org.slug ?? null,
            plan: org.planDetails?.display ?? org.plan ?? null,
            credits: org.credits ?? null,
            creditLimit: org.creditLimit ?? org.planDetails?.credits ?? null,
            trialEndsAt: org.trialEndsAt ?? null,
            verified: org.verified ?? null,
            server: session.serverUrl,
            playground: session.playgroundUrl,
        };
    },
});

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
    manual: "Call it FIRST — the auth probe. A 401 means every other tool fails the same way.",
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

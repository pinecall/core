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
    manual:
        "Call it FIRST — the auth probe; a 401 means every tool fails the same. `keySource` names where the key came from; on `shell-rc` relay the `notice`.",
    async handler(_args, { session }) {
        const org = await session.playground<any>("/orgs/me");
        const notice = session.keyNotice();
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
            // Where the key came from — a provenance label, never the key.
            keySource: session.keySource,
            ...(session.keySource === "shell-rc" ? { persisted: session.keyPersisted } : {}),
            ...(notice ? { notice } : {}),
        };
    },
});

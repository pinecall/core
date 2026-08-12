/**
 * Live proof for tk-051a52 — run against the REAL server, not a mock.
 *
 *   npx tsx scripts/verify-phone-routing.ts            # the three assertions
 *   FREE_NUM=+1... HOLD_MS=900000 npx tsx scripts/...  # then hold it open for a real call
 *
 * It exercises the actual configure_agent handler three ways:
 *   A) claim a number another live `dev-` agent holds -> must report routed:false + routedTo
 *   B) claim a free number                            -> must report routed:true + dialThisNumber
 *   C) a SECOND dev slug claims B's number            -> must report routed:false + routedTo A
 *
 * Unit tests pin the judgement; this pins that the SERVER really behaves the way
 * the judgement assumes (a refused claim is silent on the wire — see
 * src/phone-routing.ts for the citation).
 *
 * TAKEN_NUM must be a number some other live dev agent is holding; pick it from
 * `list_phones` (a row with a `dev_override` that is not yours). FREE_NUM must be
 * a row with `agent: null` and no override.
 */
import configureAgent from "../src/tools/configure-agent.js";
import { Session } from "../src/session.js";
import { agentHosts } from "../src/agent-hosts.js";

const TAKEN = process.env.TAKEN_NUM ?? "+13186330963";
const FREE = process.env.FREE_NUM ?? "+18604131735";
const ctx = { session: new Session() };

const run = async (label: string, args: any) => {
    const res = await configureAgent.handler(args, ctx as any);
    console.log(`\n=== ${label} ===\n` + JSON.stringify(res, null, 2));
    return res as any;
};

const main = async () => {
    const a = await run("A: claim a number another live dev agent holds", {
        slug: "dev-fixphone-a",
        prompt: "You are a test agent for tk-051a52.",
        phoneNumber: TAKEN,
    });

    const b = await run("B: claim a free number", {
        slug: "dev-fixphone-a",
        prompt: "You are a test agent for tk-051a52. If asked who you are, say: fixphone A.",
        greeting: "This is fixphone A, the tk-051a52 verification agent.",
        phoneNumber: FREE,
    });

    const c = await run("C: a second dev agent claims the same free number", {
        slug: "dev-fixphone-b",
        prompt: "second agent",
        phoneNumber: FREE,
    });

    const ok =
        a.routed === false && typeof a.routedTo === "string" && a.dialThisNumber === null &&
        !a.applied.includes("phoneNumber") && a.phoneNumber === null &&
        b.routed === true && b.dialThisNumber === FREE && b.applied.includes("phoneNumber") &&
        c.routed === false && c.routedTo === "dev-fixphone-a" && c.dialThisNumber === null;
    console.log(`\nRESULT: ${ok ? "ALL THREE CORRECT" : "MISMATCH"}`);

    if (process.env.HOLD_MS) {
        // Free the second slug so only dev-fixphone-a owns the route, then wait
        // for a human to dial FREE and prove the routing end to end.
        await agentHosts.release("dev-fixphone-b");
        console.log(`Holding ${FREE} on dev-fixphone-a for ${process.env.HOLD_MS}ms — call it now.`);
        await new Promise((r) => setTimeout(r, Number(process.env.HOLD_MS)));
    }
    await agentHosts.releaseAll();
    process.exit(ok ? 0 : 1);
};
main();

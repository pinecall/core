/**
 * Live proof for tk-051a52 — one shot against the REAL server, not a mock.
 *
 *   TAKEN_NUM=+1... FREE_NUM=+1... npx tsx scripts/verify-phone-routing.ts
 *
 * It registers, asserts, releases everything and exits. It never stays
 * resident and never holds a number.
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

    // One shot: never leave a dev agent holding a number after it exits. To
    // prove routing with a REAL inbound call, register the agent the normal way
    // (`configure_agent` in a live MCP session) and watch it with `observe` —
    // that is the tool that exists so nobody hand-rolls a polling loop.
    await agentHosts.releaseAll();
    process.exit(ok ? 0 : 1);
};
main();

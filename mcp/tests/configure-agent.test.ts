/**
 * configure_agent — the dev-only rule.
 *
 * The refusal must happen BEFORE any network work, so these tests need no
 * server and no key: a prod slug never reaches the SDK at all.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import configureAgent, { ProdSlugRefused, DEV_PREFIX } from "../src/tools/configure-agent.js";
import { tools } from "../src/tools/index.js";
import { Session } from "../src/session.js";
import { agentHosts } from "../src/agent-hosts.js";
import type { RoutingState } from "../src/phone-routing.js";

const ctx = { session: new Session({ PINECALL_API_KEY: "pk_test_never_used" } as any) };

const NUM = "+13186330963";

/** A ctx whose server reads return one fixed routing state, and a stubbed register. */
function stubbed(state: RoutingState) {
    const session = new Session({ PINECALL_API_KEY: "pk_test_never_used" } as any);
    vi.spyOn(session, "server").mockResolvedValue(state as any);
    vi.spyOn(agentHosts, "configure").mockResolvedValue({ revision: 1 } as any);
    return { session };
}

describe("configure_agent — dev-only", () => {
    it("refuses a production slug", async () => {
        await expect(configureAgent.handler({ slug: "bernardo", prompt: "hi" }, ctx))
            .rejects.toBeInstanceOf(ProdSlugRefused);
    });

    it("the refusal explains the dev- rule and the clobber mechanics", async () => {
        const err: any = await configureAgent.handler({ slug: "bernardo", prompt: "hi" }, ctx).catch((e) => e);
        expect(err.message).toContain(`"${DEV_PREFIX}"`);
        expect(err.message).toMatch(/hot-reload/i);
        expect(err.message).toMatch(/re-?clobber/i);
        expect(err.message).toContain("dev-bernardo");
    });

    it.each(["prod-agent", "Dev-upper", "  bernardo  ", "devnodash", "mara", "my-dev-agent"])(
        "refuses %s",
        async (slug) => {
            await expect(configureAgent.handler({ slug }, ctx)).rejects.toBeInstanceOf(ProdSlugRefused);
        },
    );

    it("has no override parameter of any kind", () => {
        const keys = Object.keys(configureAgent.schema);
        expect(keys).toEqual([
            "slug", "prompt", "llm", "stt", "voice", "language", "greeting", "phoneNumber",
        ]);
        expect(keys.some((k) => /force|prod|override|allow/i.test(k))).toBe(false);
    });

    it("takes no tools param — code tools need an SDK process, and the manual says so", () => {
        expect(configureAgent.schema).not.toHaveProperty("tools");
        expect(configureAgent.manual).toMatch(/pinecall run/);
        expect(configureAgent.manual).toMatch(/docs_search/);
    });

    it("is registered and its manual documents the held lifetime", () => {
        expect(tools.map((t) => t.name)).toContain("configure_agent");
        expect(configureAgent.manual).toMatch(/heldBySession/);
    });
});

describe("configure_agent — a phone claim is reported truthfully", () => {
    beforeEach(() => vi.restoreAllMocks());

    it("never reports a bare success when another dev slug holds the override", async () => {
        const res: any = await configureAgent.handler(
            { slug: "dev-e2e-fable", phoneNumber: NUM },
            stubbed({ dev_overrides: { [NUM]: "dev-bistro" } }) as any,
        );
        expect(res.routed).toBe(false);
        expect(res.routedTo).toBe("dev-bistro");
        // The exact lie from the incident: both of these used to claim the number.
        expect(res.phoneNumber).toBeNull();
        expect(res.applied).not.toContain("phoneNumber");
        expect(res.dialThisNumber).toBeNull();
    });

    it("names the number to dial when it really does hold it", async () => {
        const res: any = await configureAgent.handler(
            { slug: "dev-e2e-fable", prompt: "hi", phoneNumber: "+1 318-633-0963" },
            stubbed({ dev_overrides: { [NUM]: "dev-e2e-fable" } }) as any,
        );
        expect(res.routed).toBe(true);
        expect(res.phoneNumber).toBe(NUM);
        expect(res.dialThisNumber).toBe(NUM);
        expect(res.applied).toContain("phoneNumber");
    });

    it("says nothing about routing when no number was asked for", async () => {
        const res: any = await configureAgent.handler(
            { slug: "dev-e2e-fable", prompt: "hi" },
            stubbed({}) as any,
        );
        expect(res).not.toHaveProperty("routed");
        expect(res.phoneNumber).toBeNull();
    });

    it("the manual tells the agent to relay the number and never invent one", () => {
        expect(configureAgent.manual).toMatch(/dialThisNumber/);
        expect(configureAgent.manual).toMatch(/PHONE_IN_USE/);
        expect(configureAgent.manual).toMatch(/routedTo/);
    });
});

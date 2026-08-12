/**
 * configure_agent — the dev-only rule.
 *
 * The refusal must happen BEFORE any network work, so these tests need no
 * server and no key: a prod slug never reaches the SDK at all.
 */

import { describe, it, expect } from "vitest";
import configureAgent, { ProdSlugRefused, DEV_PREFIX } from "../src/tools/configure-agent.js";
import { tools } from "../src/tools/index.js";
import { Session } from "../src/session.js";

const ctx = { session: new Session({ PINECALL_API_KEY: "pk_test_never_used" } as any) };

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

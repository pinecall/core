/**
 * list_agents — the shaping rules, plus a live run against the real org when
 * PINECALL_API_KEY is present (the milestone requires real-server proof; the
 * live block skips rather than fails on a machine with no key).
 */

import { describe, it, expect } from "vitest";
import listAgents, { shapeAgents, isDevSlug } from "../src/tools/list-agents.js";
import { Session } from "../src/session.js";

describe("list_agents shaping", () => {
    it("marks dev-* slugs as sandboxes and everything else as not", () => {
        expect(isDevSlug("dev-bistro")).toBe(true);
        expect(isDevSlug("bernardo")).toBe(false);
        expect(isDevSlug("developer")).toBe(false);
    });

    it("flags a registered agent online, with its channels and phones", () => {
        const out = shapeAgents({
            agents: [
                {
                    slug: "bernardo",
                    active: true,
                    channels: { webrtc: { count: 1, refs: ["webrtc"] } },
                    phones: [],
                    model: "gpt-4.1-mini",
                    voice: "sarah",
                },
            ],
        });
        expect(out.agents).toEqual([
            {
                slug: "bernardo",
                online: true,
                dev: false,
                channels: ["webrtc"],
                model: "gpt-4.1-mini",
                voice: "sarah",
            },
        ]);
        expect(out).toMatchObject({ total: 1, online: 1, offline: 0, dev: 0 });
    });

    it("flags OFFLINE an agent claimed by a phone route with no live registration", () => {
        const out = shapeAgents({
            agents: [{ slug: "dev-bistro", active: true, channels: { phone: { count: 1, refs: ["+1"] } }, phones: ["+1"] }],
            phone_map: { "+1": "dev-bistro", "+2": "ghost-agent" },
            dev_overrides: { "+3": "dev-ghost" },
        });
        const byslug = Object.fromEntries(out.agents.map((a) => [a.slug, a]));
        expect(byslug["dev-bistro"].online).toBe(true);
        expect(byslug["ghost-agent"]).toMatchObject({ online: false, dev: false, channels: [] });
        expect(byslug["dev-ghost"]).toMatchObject({ online: false, dev: true });
        expect(out).toMatchObject({ total: 3, online: 1, offline: 2, dev: 2 });
        expect(out.devOverrides).toEqual({ "+3": "dev-ghost" });
    });

    it("respects active:false and never invents an online flag", () => {
        const out = shapeAgents({ agents: [{ slug: "stale", active: false }] });
        expect(out.agents[0].online).toBe(false);
        expect(out.offline).toBe(1);
    });

    it("orders online first, then dev sandboxes, then alphabetically", () => {
        const out = shapeAgents({
            agents: [
                { slug: "zulu", active: true },
                { slug: "dev-a", active: true },
                { slug: "alpha", active: true },
                { slug: "gone", active: false },
            ],
        });
        expect(out.agents.map((a) => a.slug)).toEqual(["alpha", "zulu", "dev-a", "gone"]);
    });

    it("omits empty phones rather than emitting []", () => {
        const out = shapeAgents({ agents: [{ slug: "a", active: true, phones: [] }] });
        expect("phones" in out.agents[0]).toBe(false);
    });
});

const live = process.env.PINECALL_API_KEY ? describe : describe.skip;

live("list_agents against the real org", () => {
    it("shows bernardo online and dev- sandboxes", async () => {
        const session = new Session(process.env, "/pinecall-tests-no-home");
        const out: any = await listAgents.handler({}, { session });

        expect(out.total).toBeGreaterThan(0);
        const slugs = out.agents.map((a: any) => a.slug);
        expect(slugs).toContain("bernardo");
        expect(out.agents.find((a: any) => a.slug === "bernardo").online).toBe(true);
        expect(slugs.some((s: string) => s.startsWith("dev-"))).toBe(true);
        expect(out.dev).toBeGreaterThan(0);

        // Every entry carries an explicit boolean — offline is never implied.
        for (const a of out.agents) {
            expect(typeof a.online).toBe("boolean");
            expect(Array.isArray(a.channels)).toBe(true);
        }
        expect(out.online + out.offline).toBe(out.total);

        // No key can leak through a result.
        expect(JSON.stringify(out)).not.toContain(process.env.PINECALL_API_KEY!);
    }, 20000);
});

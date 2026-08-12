import { describe, it, expect } from "vitest";
import subscribe, { buildPlanRows } from "../src/tools/subscribe.js";

const CATALOGUE = [
    { name: "free_trial", display: "Free Trial", price: 0, credits: 3500 },
    { name: "starter", display: "Starter", price: 2900, credits: 40000 },
    { name: "enterprise", display: "Enterprise", price: 99900, credits: 800000 },
];

/** A Session stand-in: only `playground` and `redact` are used by the tool. */
function fakeSession(routes: Record<string, any>) {
    const calls: string[] = [];
    return {
        calls,
        session: {
            redact: (s: string) => s.replace(/pk_[A-Za-z0-9_-]+/g, "pk_[redacted]"),
            async playground(path: string, init?: RequestInit) {
                calls.push(`${init?.method ?? "GET"} ${path}`);
                const r = routes[path];
                if (typeof r === "function") return r(init);
                if (r === undefined) throw new Error(`no route ${path}`);
                return r;
            },
        } as any,
    };
}

describe("buildPlanRows", () => {
    it("turns cents into USD and flags the current plan only", () => {
        const rows = buildPlanRows(CATALOGUE, "starter");
        expect(rows.map((r) => r.priceUsd)).toEqual([0, 29, 999]);
        expect(rows.filter((r) => r.current).map((r) => r.name)).toEqual(["starter"]);
    });

    it("flags nothing when the org's plan is not in the catalogue", () => {
        expect(buildPlanRows(CATALOGUE, "legacy").some((r) => r.current)).toBe(false);
        expect(buildPlanRows([], null)).toEqual([]);
    });
});

describe("subscribe", () => {
    const org = {
        plan: "starter",
        planDetails: { display: "Starter", credits: 40000 },
        credits: 1234,
        creditsResetAt: "2026-09-01T00:00:00.000Z",
    };

    it("with no plan: reports the org and returns the portal URL, changing nothing", async () => {
        const { session, calls } = fakeSession({
            "/orgs/me": org,
            "/plans": { plans: CATALOGUE },
            "/billing/portal": { url: "https://billing.stripe.com/p/session/test_1" },
        });
        const r: any = await subscribe.handler({}, { session });
        expect(r.plan).toBe("starter");
        expect(r.credits).toBe(1234);
        expect(r.creditLimit).toBe(40000);
        expect(r.portalUrl).toBe("https://billing.stripe.com/p/session/test_1");
        expect(calls).not.toContain("POST /billing/checkout");
    });

    it("with no plan and no Stripe customer: portal is null with a reason, not a throw", async () => {
        const { session } = fakeSession({
            "/orgs/me": org,
            "/plans": { plans: CATALOGUE },
            "/billing/portal": () => {
                throw new Error(
                    'Playground 400 on /billing/portal: {"error":"No billing account yet — buy credits or a plan first","code":"NO_CUSTOMER"}',
                );
            },
        });
        const r: any = await subscribe.handler({}, { session });
        expect(r.portalUrl).toBeNull();
        expect(r.portalUnavailableCode).toBe("NO_CUSTOMER");
        expect(r.portalUnavailable).toMatch(/No billing account yet/);
    });

    it("with a plan: returns the checkout URL for a new subscriber", async () => {
        const { session } = fakeSession({
            "/orgs/me": org,
            "/plans": { plans: CATALOGUE },
            "/billing/checkout": { url: "https://checkout.stripe.com/c/pay/cs_test_1" },
        });
        const r: any = await subscribe.handler({ plan: "enterprise" }, { session });
        expect(r.checkoutUrl).toBe("https://checkout.stripe.com/c/pay/cs_test_1");
        expect(r.requestedPlan).toBe("enterprise");
    });

    it("with a plan: reports an in-place change when there is no checkout page", async () => {
        const { session } = fakeSession({
            "/orgs/me": org,
            "/plans": { plans: CATALOGUE },
            "/billing/checkout": { applied: true, plan: "enterprise", changed: "upgrade" },
        });
        const r: any = await subscribe.handler({ plan: "enterprise" }, { session });
        expect(r).toMatchObject({ applied: true, changed: "upgrade" });
        expect(r.checkoutUrl).toBeUndefined();
    });

    it("refuses an unknown plan locally — no billing call at all", async () => {
        const { session, calls } = fakeSession({ "/orgs/me": org, "/plans": { plans: CATALOGUE } });
        const r: any = await subscribe.handler({ plan: "platinum" }, { session });
        expect(r.error).toMatch(/free_trial, starter, enterprise/);
        expect(calls).toEqual(["GET /orgs/me", "GET /plans"]);
    });

    it("redacts a key that an upstream error echoed back", async () => {
        const { session } = fakeSession({
            "/orgs/me": org,
            "/plans": { plans: CATALOGUE },
            "/billing/checkout": () => {
                throw new Error("Playground 401 on /billing/checkout: bad key pk_livesecret123456");
            },
        });
        const r: any = await subscribe.handler({ plan: "starter" }, { session });
        expect(r.error).not.toMatch(/pk_livesecret/);
        expect(r.error).toMatch(/pk_\[redacted\]/);
    });
});

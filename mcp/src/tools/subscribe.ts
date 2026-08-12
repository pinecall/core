/**
 * subscribe — what plan this org is on, and the LINK a human opens to change it.
 *
 * The MCP never touches card data. Everything money-shaped already exists in the
 * Playground and is reused as-is (see mcp/README.md § subscribe):
 *
 *   GET  /api/orgs/me          → current plan, credits, allowance
 *   GET  /api/plans            → the catalogue (public, no auth)
 *   POST /api/billing/portal   → a Stripe Billing Portal URL for this org
 *   POST /api/billing/checkout → { url } for a NEW subscriber, or an applied
 *                                in-place change for an existing one
 *
 * The Stripe secret lives in the Playground process (STRIPE_SECRET_KEY) and is
 * never seen here — what crosses the wire is a hosted-page URL, which is the
 * whole point: the human clicks it, Stripe collects the card.
 */

import { z } from "zod";
import { defineTool } from "./types.js";

/** One row of the plan catalogue — small on purpose, the agent does not need Stripe ids. */
export interface PlanRow {
    name: string;
    display: string;
    /** USD per month. The API stores cents. */
    priceUsd: number;
    credits: number;
    current?: true;
}

/** Shape the /api/plans payload into rows, flagging the org's current plan. */
export function buildPlanRows(plans: any[], currentName?: string | null): PlanRow[] {
    return (plans ?? []).map((p) => {
        const row: PlanRow = {
            name: p.name,
            display: p.display ?? p.name,
            priceUsd: (p.price ?? 0) / 100,
            credits: p.credits ?? 0,
        };
        if (currentName && p.name === currentName) row.current = true;
        return row;
    });
}

/**
 * The billing routes answer 400/503 with `{ error, code }`. `session.playground`
 * throws on a non-2xx, so turn that back into a reportable reason instead of
 * failing the whole tool — "no billing account yet" is an ANSWER, not a crash.
 */
function reasonFrom(err: unknown): { code: string; message: string } {
    const text = err instanceof Error ? err.message : String(err);
    const m = text.match(/\{.*\}$/s);
    if (m) {
        try {
            const body = JSON.parse(m[0]);
            if (body?.error) return { code: body.code ?? "ERROR", message: body.error };
        } catch { /* not JSON — fall through */ }
    }
    return { code: "ERROR", message: text };
}

export default defineTool({
    name: "subscribe",
    description:
        "The org's plan and credits, the plan catalogue, and a Stripe link the human opens to subscribe, upgrade or manage billing.",
    schema: {
        plan: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Plan name to move to, e.g. starter / pro / enterprise. Omit to just report the current plan and hand back the billing-portal link.",
            ),
    },
    manual:
        "No-arg = read-only: plan, credits, catalogue, `portalUrl` (Stripe portal; null until the org has ever paid — normal). With `plan`: `checkoutUrl` for a first subscription, but an EXISTING subscriber is switched in place with proration — a real billing change, ask the human first. Hand URLs over verbatim; never touch or request card data; expired link → call again.",
    async handler(args: { plan?: string }, { session }) {
        const [org, catalogue] = await Promise.all([
            session.playground<any>("/orgs/me"),
            session.playground<any>("/plans"),
        ]);

        const plans = buildPlanRows(catalogue?.plans ?? [], org?.plan);
        const base = {
            plan: org.plan ?? null,
            planDisplay: org.planDetails?.display ?? org.plan ?? null,
            credits: org.credits ?? null,
            creditLimit: org.creditLimit ?? org.planDetails?.credits ?? null,
            creditsResetAt: org.creditsResetAt ?? null,
            plans,
        };

        // ── Report + portal link ────────────────────────────────────────────
        if (!args.plan) {
            try {
                const portal = await session.playground<any>("/billing/portal", { method: "POST" });
                return { ...base, portalUrl: portal.url ?? null };
            } catch (err) {
                const reason = reasonFrom(err);
                return {
                    ...base,
                    portalUrl: null,
                    portalUnavailable: session.redact(reason.message),
                    portalUnavailableCode: reason.code,
                };
            }
        }

        // ── Change plan ─────────────────────────────────────────────────────
        const wanted = plans.find((p) => p.name === args.plan);
        if (!wanted) {
            return {
                ...base,
                error: `No plan named "${args.plan}". Choose one of: ${plans.map((p) => p.name).join(", ")}.`,
            };
        }

        try {
            const r = await session.playground<any>("/billing/checkout", {
                method: "POST",
                body: JSON.stringify({ plan: wanted.name }),
            });
            if (r.url) return { ...base, requestedPlan: wanted.name, checkoutUrl: r.url };
            return {
                ...base,
                requestedPlan: wanted.name,
                applied: true,
                changed: r.changed ?? null,
                note: "Applied in place on the existing subscription — no checkout page. Call subscribe again to see the new plan and credits.",
            };
        } catch (err) {
            const reason = reasonFrom(err);
            return {
                ...base,
                requestedPlan: wanted.name,
                error: session.redact(reason.message),
                code: reason.code,
            };
        }
    },
});

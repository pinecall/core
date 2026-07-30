/**
 * Registration-retry backoff math — the anti-storm contract.
 *
 * Born from the 2026-07-30 logs: a dev machine held `pines` against prod and
 * three processes retried agent.create every ~20-40s for HOURS, each attempt
 * shipping the full agent payload. The delay now honors the server's
 * retry_after_s, grows to minutes when the holder is ALIVE, and stays fast
 * when the registration is merely stale.
 */

import { describe, it, expect } from "vitest";
import {
    computeRegisterRetryDelay,
    planConflictRetry,
    RETRY_CAP_HELD_MS,
    RETRY_CAP_STALE_MS,
    CONFLICT_RETRY_BUDGET_MS,
    SERVER_LIVENESS_WINDOW_MS,
} from "../src/kernel/backoff.js";

const noJitter = () => 0.5; // (0.85 + 0.5*0.3) = 1.0 → exact base

describe("computeRegisterRetryDelay", () => {
    it("honors the server's retry_after_s", () => {
        expect(computeRegisterRetryDelay(0, true, 120, noJitter)).toBe(120_000);
    });

    it("caps a held name at 10 minutes even with a huge server hint", () => {
        expect(computeRegisterRetryDelay(0, true, 9999, noJitter)).toBe(RETRY_CAP_HELD_MS);
    });

    it("legacy exponential growth without a hint: 5s → 10s → 20s → 40s", () => {
        expect([0, 1, 2, 3].map((a) => computeRegisterRetryDelay(a, false, undefined, noJitter)))
            .toEqual([5_000, 10_000, 20_000, 40_000]);
    });

    it("stale holder stays capped at 60s (fast recovery when the server frees it)", () => {
        expect(computeRegisterRetryDelay(10, false, undefined, noJitter)).toBe(RETRY_CAP_STALE_MS);
    });

    it("a held name grows past 60s up to 10 min locally too (old server, no hint)", () => {
        expect(computeRegisterRetryDelay(6, true, undefined, noJitter)).toBe(320_000);
        expect(computeRegisterRetryDelay(20, true, undefined, noJitter)).toBe(RETRY_CAP_HELD_MS);
    });

    it("applies ±15% jitter", () => {
        expect(computeRegisterRetryDelay(0, false, undefined, () => 0)).toBe(4_250);
        expect(computeRegisterRetryDelay(0, false, undefined, () => 1)).toBe(5_750);
    });
});

/**
 * The retry BUDGET — conflicts must reach a terminal state.
 *
 * Retrying forever is what turned a held name into an unbounded storm of
 * full agent.create payloads on the same WS path as live calls. The whole
 * episode now gets 2× the server's stale-registration window: long enough for
 * any stale registration to be reaped, and not one attempt more.
 */
describe("planConflictRetry — bounded episode", () => {
    const mkState = (startedAt: number) => ({ attempt: 0, holderAlive: false, startedAt });

    it("derives the budget from the server's liveness window (not a magic number)", () => {
        expect(CONFLICT_RETRY_BUDGET_MS).toBe(2 * SERVER_LIVENESS_WINDOW_MS);
    });

    it("retries while the budget lasts", () => {
        const s = mkState(1_000);
        expect(planConflictRetry(s, undefined, 1_000, noJitter)).toEqual({ action: "retry", delayMs: 5_000 });
        expect(planConflictRetry(s, undefined, 6_000, noJitter)).toEqual({ action: "retry", delayMs: 10_000 });
    });

    it("never schedules past the budget — the last attempt lands exactly on it", () => {
        const s = { attempt: 4, holderAlive: false, startedAt: 0 };
        const plan = planConflictRetry(s, undefined, CONFLICT_RETRY_BUDGET_MS - 3_000, noJitter);
        expect(plan).toEqual({ action: "retry", delayMs: 3_000 });
    });

    it("goes terminal once the budget is exhausted", () => {
        const s = { attempt: 6, holderAlive: true, startedAt: 0 };
        expect(planConflictRetry(s, undefined, CONFLICT_RETRY_BUDGET_MS, noJitter)).toEqual({ action: "terminal" });
        expect(planConflictRetry(s, undefined, CONFLICT_RETRY_BUDGET_MS + 60_000, noJitter)).toEqual({ action: "terminal" });
    });

    it("holder_alive:false resets to fast retries AND restarts the budget clock", () => {
        const s = { attempt: 6, holderAlive: true, startedAt: 0 };
        const now = CONFLICT_RETRY_BUDGET_MS + 10_000; // would be terminal otherwise
        expect(planConflictRetry(s, { holderAlive: false }, now, noJitter))
            .toEqual({ action: "retry", delayMs: 5_000 });
        expect(s.holderAlive).toBe(false);
        expect(s.startedAt).toBe(now);
    });

    it("an old server (no hint at all) still gets the budget — half the fix, uncoordinated", () => {
        const s = mkState(0);
        let now = 0;
        let attempts = 0;
        for (;;) {
            const plan = planConflictRetry(s, undefined, now, noJitter);
            if (plan.action === "terminal") break;
            attempts++;
            now += plan.delayMs;
            expect(attempts).toBeLessThan(50); // must not loop forever
        }
        expect(now).toBe(CONFLICT_RETRY_BUDGET_MS);
    });
});

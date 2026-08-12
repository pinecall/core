/**
 * phone-routing — the tool must never claim a number it does not hold.
 *
 * The bug this pins: configure_agent('dev-e2e-fable', {phoneNumber:'+13186330963'})
 * reported the number as applied while the server's dev override still pointed at
 * dev-bistro, and a real inbound call went to dev-bistro.
 */

import { describe, it, expect } from "vitest";
import {
    normalizePhone,
    judgeRouting,
    verifyPhoneRouting,
    type RoutingState,
} from "../src/phone-routing.js";

const NUM = "+13186330963";
const noSleep = async () => {};

describe("normalizePhone — mirrors the server's key", () => {
    it.each([
        ["+1 318-633-0963", NUM],
        ["1(318)6330963", NUM],
        ["  +13186330963  ", NUM],
        ["sip:18392228133@trunk.twilio.com", "+18392228133"],
        ["sip:222@zenitel.local", "sip:222@zenitel.local"],
    ])("%s -> %s", (input, expected) => {
        expect(normalizePhone(input)).toBe(expected);
    });
});

describe("judgeRouting", () => {
    it("another dev agent holds the override: routed false + routedTo, and nothing to dial", () => {
        const r = judgeRouting("dev-e2e-fable", "+1 318 633 0963", {
            dev_overrides: { [NUM]: "dev-bistro" },
        });
        expect(r.routed).toBe(false);
        expect(r.routedTo).toBe("dev-bistro");
        expect(r.dial).toBeNull();
        expect(r.reason).toMatch(/PHONE_IN_USE/);
        expect(r.reason).toMatch(/pinecall kick dev-bistro/);
    });

    it("we hold it: routed true and the number is the one to dial", () => {
        const r = judgeRouting("dev-e2e-fable", NUM, { dev_overrides: { [NUM]: "dev-e2e-fable" } });
        expect(r.routed).toBe(true);
        expect(r.routedTo).toBeUndefined();
        expect(r.dial).toBe(NUM);
    });

    it("we hold it but a caller whitelist is active: the caveat is surfaced", () => {
        const r = judgeRouting("dev-e2e-fable", NUM, {
            dev_overrides: { [NUM]: "dev-e2e-fable" },
            dev_callers: ["+34607827824"],
            phone_map: { [NUM]: "bernardo" },
        });
        expect(r.routed).toBe(true);
        expect(r.callersWhitelist).toEqual(["+34607827824"]);
        expect(r.reason).toMatch(/\+34607827824/);
        expect(r.reason).toMatch(/bernardo/);
    });

    it("no override at all but a prod owner answers: routed false, routedTo the prod slug", () => {
        const r = judgeRouting("dev-x", NUM, { phone_map: { [NUM]: "bernardo" } });
        expect(r.routed).toBe(false);
        expect(r.routedTo).toBe("bernardo");
        expect(r.dial).toBeNull();
    });

    it("the number is nowhere in the routing state: routed false, no owner, points at list_phones", () => {
        const r = judgeRouting("dev-x", NUM, {});
        expect(r.routed).toBe(false);
        expect(r.routedTo).toBeUndefined();
        expect(r.dial).toBeNull();
        expect(r.reason).toMatch(/list_phones/);
    });

    it("null maps (the server sends null, not {}) are handled", () => {
        const r = judgeRouting("dev-x", NUM, { dev_overrides: null, dev_callers: null });
        expect(r.routed).toBe(false);
    });
});

describe("verifyPhoneRouting", () => {
    it("polls past the write lag — channel.add lands after agent.created", async () => {
        const states: RoutingState[] = [{}, {}, { dev_overrides: { [NUM]: "dev-x" } }];
        let i = 0;
        const r = await verifyPhoneRouting("dev-x", NUM, async () => states[i++] ?? {}, {
            sleep: noSleep,
        });
        expect(r.routed).toBe(true);
        expect(i).toBe(3);
    });

    it("stops immediately on a settled rejection — a refusal is stable, not lag", async () => {
        let reads = 0;
        const r = await verifyPhoneRouting(
            "dev-e2e-fable",
            NUM,
            async () => {
                reads++;
                return { dev_overrides: { [NUM]: "dev-bistro" } };
            },
            { sleep: noSleep },
        );
        expect(r.routedTo).toBe("dev-bistro");
        expect(reads).toBe(1);
    });

    it("gives up after `attempts` and reports the honest not-routed", async () => {
        let reads = 0;
        const r = await verifyPhoneRouting(
            "dev-x",
            NUM,
            async () => {
                reads++;
                return {};
            },
            { attempts: 3, sleep: noSleep },
        );
        expect(reads).toBe(3);
        expect(r.routed).toBe(false);
    });
});

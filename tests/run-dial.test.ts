/**
 * `pinecall run agent.mjs --call +34…` — the agent rings you.
 *
 * The dial itself is the SDK's own `agent.dial`; what is tested here is the
 * layer around it, because that is where a developer gets stuck: is the number
 * dialable, does the agent have a number to call FROM, and when the carrier
 * says "busy" does the terminal say something a human can act on.
 *
 * No network: the agent is a fake whose `dial` resolves or rejects on command.
 */

import { describe, it, expect, vi } from "vitest";
import { isDialable, phoneChannels, refusal, ringMe, type DialAgentLike } from "../src/cli/console/dial.js";
import { describeAgent } from "../src/cli/console/server.js";

function fakeAgent(
    id: string,
    channels: Array<{ type: string; ref?: string }>,
    dial: (o: any) => Promise<any> = async () => ({ id: "call_1" }),
): DialAgentLike & { dial: ReturnType<typeof vi.fn> } {
    return {
        id,
        _getChannels: () => new Map(channels.map((ch, i) => [`${ch.type}:${ch.ref ?? i}`, ch])),
        dial: vi.fn(dial),
    } as any;
}

describe("--call", () => {
    it("dials through the SDK with the console marker and reports the number", async () => {
        const agent = fakeAgent("nova", [{ type: "phone", ref: "+13186330963" }]);
        const result = await ringMe(agent, " +34600000000 ");

        expect(agent.dial).toHaveBeenCalledWith({
            to: "+34600000000",
            metadata: { console: true },
        });
        expect(result.ok).toBe(true);
        expect(result.to).toBe("+34600000000");
        expect(result.message).toContain("+34600000000");
        expect(result.message).toContain("+13186330963");   // …from which number
    });

    it("refuses a number that is not E.164 — and never reaches the carrier", async () => {
        const agent = fakeAgent("nova", [{ type: "phone", ref: "+13186330963" }]);
        const result = await ringMe(agent, "600000000");

        expect(result.ok).toBe(false);
        expect(result.reason).toBe("bad_number");
        expect(result.message).toContain("E.164");
        expect(agent.dial).not.toHaveBeenCalled();
    });

    it("accepts a SIP URI", () => {
        expect(isDialable("sip:bot@trunk.twilio.com")).toBe(true);
        expect(isDialable("sip:")).toBe(false);
        expect(isDialable("+1")).toBe(false);
        expect(isDialable("+13186330963")).toBe(true);
    });

    it("says so when the agent has no number to call FROM, with the fix", async () => {
        const agent = fakeAgent("nova", [{ type: "webrtc" }, { type: "chat" }]);
        const result = await ringMe(agent, "+34600000000");

        expect(result.ok).toBe(false);
        expect(result.reason).toBe("no_phone");
        expect(result.message).toContain("phoneNumber");
        expect(agent.dial).not.toHaveBeenCalled();
    });

    it("turns the carrier's word into a sentence instead of throwing", async () => {
        const agent = fakeAgent("nova", [{ type: "phone", ref: "+1318" }], async () => {
            throw new Error("busy");
        });
        const result = await ringMe(agent, "+34600000000");
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("refused");
        expect(result.message).toBe("+34600000000 is busy");
    });

    it("passes an unknown refusal through rather than inventing one", () => {
        expect(refusal("+1", new Error("no-answer"))).toContain("did not answer");
        expect(refusal("+1", new Error("Dial timeout"))).toContain("still connected");
        expect(refusal("+1", new Error("outbound requires a paid plan"))).toContain("not enabled on this plan");
        expect(refusal("+1", new Error("weird server thing"))).toContain("weird server thing");
    });

    it("lists the agent's phone channels once, in order", () => {
        const agent = fakeAgent("nova", [
            { type: "phone", ref: "+1" }, { type: "webrtc" }, { type: "phone", ref: "+1" }, { type: "phone", ref: "+2" },
        ]);
        expect(phoneChannels(agent)).toEqual(["+1", "+2"]);
    });
});

// ── The web console's half of the same fact ──────────────────────────────

describe("/api/agents advertises whether the agent can call out", () => {
    const describe1 = (channels: Array<{ type: string; ref?: string }>) =>
        describeAgent({
            id: "nova",
            getConfig: () => ({}),
            _getChannels: () => new Map(channels.map((ch, i) => [`${ch.type}:${ch.ref ?? i}`, ch])),
            call: () => undefined,
        });

    it("canCall is true exactly when there is a number to dial from", () => {
        expect(describe1([{ type: "phone", ref: "+13186330963" }]).canCall).toBe(true);
        expect(describe1([{ type: "webrtc" }]).canCall).toBe(false);
        // …and it agrees with what --call decides, so the button and the flag
        // can never disagree about the same agent.
        expect(describe1([{ type: "webrtc" }]).canCall)
            .toBe(phoneChannels(fakeAgent("nova", [{ type: "webrtc" }])).length > 0);
    });
});

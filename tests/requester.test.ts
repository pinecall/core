/**
 * Requester — the request/response machine Call and WhatsAppSession share.
 *
 * The four things that used to break, one test each: two requests in flight
 * resolving each other's callers, a server that does not echo `request_id`, an
 * ack that never arrives, and an ack that carries an `error`.
 */

import { describe, it, expect, vi } from "vitest";
import { Requester, REQUEST_TIMEOUT_MS } from "../src/kernel/requester.js";
import { PinecallError } from "../src/kernel/errors.js";

function makeRequester(scopeLabel = "call c1") {
    const sent: Array<Record<string, unknown>> = [];
    const requester = new Requester({
        send: (data) => { sent.push(data); },
        scopeId: "c1",
        scopeLabel,
    });
    return { requester, sent };
}

describe("Requester", () => {
    it("sends the wire frame with event, call_id and request_id", () => {
        const { requester, sent } = makeRequester();
        Requester.handled(requester.request("history.set", "history.updated", { messages: [] }));
        expect(sent).toHaveLength(1);
        expect(sent[0].event).toBe("history.set");
        expect(sent[0].call_id).toBe("c1");
        expect(String(sent[0].request_id)).toMatch(/^rq_/);
        expect(sent[0].messages).toEqual([]);
    });

    it("resolves the right caller when two requests are in flight", async () => {
        const { requester, sent } = makeRequester();
        // Both key on "history.updated" — only request_id can tell them apart.
        const first = requester.request("history.add", "history.updated");
        const second = requester.request("history.set", "history.updated");
        const firstId = sent[0].request_id as string;
        const secondId = sent[1].request_id as string;
        expect(firstId).not.toBe(secondId);

        expect(requester.applyResponse("history.updated", { request_id: secondId, count: 2 })).toBe(true);
        await expect(second).resolves.toMatchObject({ count: 2 });

        expect(requester.applyResponse("history.updated", { request_id: firstId, count: 1 })).toBe(true);
        await expect(first).resolves.toMatchObject({ count: 1 });
    });

    it("falls back to the event name when the server does not echo request_id", async () => {
        const { requester } = makeRequester();
        const pending = requester.request("history.get", "history.data");
        expect(requester.applyResponse("history.data", { messages: [{ role: "user", content: "hi" }] })).toBe(true);
        await expect(pending).resolves.toMatchObject({ messages: [{ role: "user", content: "hi" }] });
    });

    it("reports no match when nothing is pending", () => {
        const { requester } = makeRequester();
        expect(requester.applyResponse("history.updated", {})).toBe(false);
    });

    it("rejects with REQUEST_TIMEOUT when the ack never arrives", async () => {
        vi.useFakeTimers();
        try {
            const { requester } = makeRequester();
            const pending = requester.request("history.set_vars", "history.updated", { vars: {} });
            const assertion = expect(pending).rejects.toMatchObject({
                code: "REQUEST_TIMEOUT",
                message: `Timed out after ${REQUEST_TIMEOUT_MS}ms waiting for "history.updated" ` +
                    `in reply to "history.set_vars" on call c1.`,
            });
            await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejects with REQUEST_REJECTED when the ack carries an error", async () => {
        const { requester } = makeRequester("WhatsApp session wa-x");
        const pending = requester.request("history.add_context", "history.updated", { text: "x" });
        requester.applyResponse("history.updated", { error: "no handler for session" });
        await expect(pending).rejects.toBeInstanceOf(PinecallError);
        await expect(pending).rejects.toMatchObject({
            code: "REQUEST_REJECTED",
            message: '"history.add_context" was rejected by the server on WhatsApp session wa-x: no handler for session',
        });
    });

    it("handled() swallows the rejection for a fire-and-forget caller", async () => {
        const { requester } = makeRequester();
        const pending = Requester.handled(requester.request("history.clear", "history.updated"));
        requester.applyResponse("history.updated", { error: "nope" });
        // The awaiting caller still sees it — handled() only pre-attaches a catch.
        await expect(pending).rejects.toMatchObject({ code: "REQUEST_REJECTED" });
    });
});

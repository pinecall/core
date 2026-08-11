/**
 * createToken URL snapshot.
 *
 * Spec §8: `createToken("webrtc"|"chat")` keeps working. The scope/callId
 * parameters are additive — a call that does not pass them must produce the
 * byte-identical URL it produced before they existed. These snapshots are
 * the pin: changing one is changing the wire.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createToken } from "../src/api/tokens.js";

function captureURL(): { urls: string[]; headers: (Record<string, string> | undefined)[] } {
    const urls: string[] = [];
    const headers: (Record<string, string> | undefined)[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string> }) => {
        urls.push(url);
        headers.push(init?.headers);
        return {
            ok: true,
            json: async () => ({ token: "tk_1", server: "https://voice.pinecall.io", expires_in: 60 }),
        } as unknown as Response;
    });
    return { urls, headers };
}

afterEach(() => { vi.unstubAllGlobals(); });

const API = "https://api.example.test";

describe("createToken — today's URLs are frozen", () => {
    it("webrtc, no scope: byte-identical to before this feature", async () => {
        const cap = captureURL();
        await createToken({ channel: "webrtc", agentId: "lucia", apiKey: "sk_x", apiUrl: API });
        expect(cap.urls[0]).toBe(`${API}/webrtc/token?agent_id=lucia`);
    });

    it("chat, no scope", async () => {
        const cap = captureURL();
        await createToken({ channel: "chat", agentId: "lucia", apiKey: "sk_x", apiUrl: API });
        expect(cap.urls[0]).toBe(`${API}/chat/token?agent_id=lucia`);
    });

    it("stream, no scope — the channel→endpoint map is untouched", async () => {
        const cap = captureURL();
        await createToken({ channel: "stream", agentId: "lucia", apiKey: "sk_x", apiUrl: API });
        expect(cap.urls[0]).toBe(`${API}/stream/token?agent_id=lucia`);
    });

    it("metadata still serializes exactly as before", async () => {
        const cap = captureURL();
        await createToken({
            channel: "webrtc", agentId: "lucia", apiKey: "sk_x", apiUrl: API,
            metadata: { tenantId: "acme" },
        });
        expect(cap.urls[0]).toBe(
            `${API}/webrtc/token?agent_id=lucia&metadata=${encodeURIComponent('{"tenantId":"acme"}')}`,
        );
    });

    it("an empty metadata object adds nothing (unchanged)", async () => {
        const cap = captureURL();
        await createToken({
            channel: "webrtc", agentId: "lucia", apiKey: "sk_x", apiUrl: API, metadata: {},
        });
        expect(cap.urls[0]).toBe(`${API}/webrtc/token?agent_id=lucia`);
    });
});

describe("createToken — scope and callId (§5)", () => {
    it("appends scope when asked", async () => {
        const cap = captureURL();
        await createToken({
            channel: "stream", agentId: "lucia", apiKey: "sk_x", apiUrl: API, scope: "observe",
        });
        expect(cap.urls[0]).toBe(`${API}/stream/token?agent_id=lucia&scope=observe`);
    });

    it("appends call_id (snake_case on the wire)", async () => {
        const cap = captureURL();
        await createToken({
            channel: "stream", agentId: "lucia", apiKey: "sk_x", apiUrl: API,
            scope: "supervise", callId: "CA_abc",
        });
        expect(cap.urls[0]).toBe(
            `${API}/stream/token?agent_id=lucia&scope=supervise&call_id=CA_abc`,
        );
    });

    it("orders metadata, scope, call_id deterministically", async () => {
        const cap = captureURL();
        await createToken({
            channel: "webrtc", agentId: "lu cia", apiKey: "sk_x", apiUrl: API,
            metadata: { a: 1 }, scope: "participate", callId: "CA/1",
        });
        expect(cap.urls[0]).toBe(
            `${API}/webrtc/token?agent_id=lu%20cia` +
            `&metadata=${encodeURIComponent('{"a":1}')}` +
            `&scope=participate&call_id=${encodeURIComponent("CA/1")}`,
        );
    });
});

describe("createToken — the agent set (§5 visibility)", () => {
    const API = "https://api.example.test";

    it("a single agent mints today's byte-identical URL", async () => {
        const cap = captureURL();
        await createToken({ channel: "stream", agentId: "lucia", apiKey: "sk_x", apiUrl: API });
        expect(cap.urls[0]).toBe(`${API}/stream/token?agent_id=lucia`);
    });

    it("an agent set serializes comma-separated, order preserved", async () => {
        const cap = captureURL();
        await createToken({ channel: "stream", agentId: ["lucia", "bruno"], apiKey: "sk_x", apiUrl: API });
        expect(cap.urls[0]).toBe(`${API}/stream/token?agent_id=lucia%2Cbruno`);
    });

    it("a set with scope keeps the set first, scope after", async () => {
        const cap = captureURL();
        await createToken({
            channel: "stream",
            agentId: ["lucia", "bruno"],
            apiKey: "sk_x",
            apiUrl: API,
            scope: "observe",
        });
        expect(cap.urls[0]).toBe(`${API}/stream/token?agent_id=lucia%2Cbruno&scope=observe`);
    });
});

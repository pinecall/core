/**
 * The auth seam, in-process: the key is reachable only through apiKey(),
 * the missing-key error names the fix, and redact() scrubs.
 */

import { describe, it, expect } from "vitest";
import { Session, MissingApiKeyError } from "../src/session.js";
import { buildInstructions, PLAYBOOK } from "../src/instructions.js";
import { tools } from "../src/tools/index.js";

describe("Session", () => {
    it("has no key when the env has none, and says how to fix it", () => {
        const s = new Session({} as NodeJS.ProcessEnv, "/pinecall-tests-no-home");
        expect(s.hasApiKey()).toBe(false);
        expect(() => s.apiKey()).toThrow(MissingApiKeyError);
        expect(() => s.apiKey()).toThrow(/set_api_key/);
    });

    it("takes the key from PINECALL_API_KEY and from set_api_key", () => {
        const s = new Session({ PINECALL_API_KEY: "pk_env" } as NodeJS.ProcessEnv);
        expect(s.apiKey()).toBe("pk_env");
        s.setApiKey("  pk_session  ");
        expect(s.apiKey()).toBe("pk_session");
    });

    it("keeps the key off its own JSON representation", () => {
        const s = new Session({ PINECALL_API_KEY: "pk_secret_value" } as NodeJS.ProcessEnv);
        expect(JSON.stringify(s)).not.toContain("pk_secret_value");
    });

    it("redacts the live key and any pk_ token from outbound text", () => {
        const s = new Session({ PINECALL_API_KEY: "pk_secret_value" } as NodeJS.ProcessEnv);
        const out = s.redact("401 for pk_secret_value and also pk_other_key_abc");
        expect(out).not.toContain("pk_secret_value");
        expect(out).not.toContain("pk_other_key_abc");
    });

    it("defaults to the same endpoints the CLI uses", () => {
        const s = new Session({} as NodeJS.ProcessEnv, "/pinecall-tests-no-home");
        expect(s.serverUrl).toBe("https://voice.pinecall.io");
        expect(s.playgroundUrl).toBe("https://playground.pinecall.io");
    });
});

describe("instructions assembly", () => {
    it("is the playbook plus exactly one section per registered tool", () => {
        const text = buildInstructions(tools);
        expect(text.startsWith(PLAYBOOK)).toBe(true);
        const headings = [...text.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
        expect(headings).toEqual(tools.map((t) => t.name));
    });

    /**
     * HARD CAP. The instructions load into EVERY client's context window on
     * connect, before the user has asked anything — so this is a budget, not a
     * style rule. A new tool pays for its section by shortening someone's
     * manual, never by growing the total.
     */
    it("fits the 6000-char context budget", () => {
        // 4000 held at 14 tools; the catalog keeps growing (subscribe, byok,
        // phase 2) and the per-manual pin below is what keeps each entry terse.
        // 6000 is the ceiling for the full phase-1 registry — raising it again
        // needs a conversation, not a bigger number.
        expect(buildInstructions(tools).length).toBeLessThanOrEqual(6000);
    });

    it("keeps every manual short enough to read at a glance", () => {
        for (const t of tools) {
            expect(t.manual.split("\n").length, t.name).toBeLessThanOrEqual(10);
            expect(t.manual.trim().length, t.name).toBeGreaterThan(0);
        }
    });
});

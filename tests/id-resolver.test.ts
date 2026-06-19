import { describe, it, expect } from "vitest";
import { StandardAgentIdResolver } from "../src/protocol/id-resolver.js";

const r = new StandardAgentIdResolver();

describe("StandardAgentIdResolver", () => {
    it("matches a plain lowercase slug directly", () => {
        expect(r.resolve("florencia", new Set(["florencia"]))).toBe("florencia");
    });

    it("resolves a server slug back to a camelCase local id (the phone-registration bug)", () => {
        expect(r.resolve("futbolagent", new Set(["futbolAgent"]))).toBe("futbolAgent");
    });

    it("resolves spaced and underscored ids via slugify", () => {
        expect(r.resolve("my-agent", new Set(["My Agent"]))).toBe("My Agent");
        expect(r.resolve("receptionist-bot-v2", new Set(["receptionist_bot_v2"]))).toBe("receptionist_bot_v2");
    });

    it("strips the org compound-key prefix", () => {
        expect(r.resolve("org123:futbolagent", new Set(["futbolAgent"]))).toBe("futbolAgent");
    });

    it("returns null when nothing matches", () => {
        expect(r.resolve("unknown", new Set(["futbolAgent"]))).toBeNull();
    });
});

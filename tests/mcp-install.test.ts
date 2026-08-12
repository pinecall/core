/**
 * `pinecall mcp install` — the config writers.
 *
 * Everything runs against a throwaway $HOME so the assertions are about real
 * files on disk, not mocks: the whole point of this feature is that it edits
 * somebody else's hand-written config without damaging it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, detect } from "../src/cli/install/apply.js";
import { entry } from "../src/cli/install/platforms.js";

let home: string;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pinecall-install-"));
});
afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("detection", () => {
    it("reports nothing installed in an empty home", () => {
        expect(detect(home).every((r) => !r.installed)).toBe(true);
    });

    it("a bare ~/.gemini/antigravity does NOT make Gemini CLI look installed", () => {
        mkdirSync(join(home, ".gemini/antigravity"), { recursive: true });
        const rows = Object.fromEntries(detect(home).map((r) => [r.platform, r]));
        expect(rows.antigravity!.installed).toBe(true);
        expect(rows.gemini!.installed).toBe(false);
    });

    it("Gemini CLI is detected by its settings FILE", () => {
        mkdirSync(join(home, ".gemini"), { recursive: true });
        writeFileSync(join(home, ".gemini/settings.json"), "{}");
        const rows = Object.fromEntries(detect(home).map((r) => [r.platform, r]));
        expect(rows.gemini!.installed).toBe(true);
    });
});

describe("JSON hosts", () => {
    it("writes the entry with npx and NO api key", () => {
        apply({ platforms: ["cursor"], home });
        const cfg = readJson(join(home, ".cursor/mcp.json"));
        expect(cfg.mcpServers.pinecall).toEqual(entry());
        expect(JSON.stringify(cfg)).not.toContain("PINECALL_API_KEY");
        expect(cfg.mcpServers.pinecall.env).toBeUndefined();
    });

    it("leaves other servers and unrelated settings alone", () => {
        const path = join(home, ".claude.json");
        writeFileSync(
            path,
            JSON.stringify({ numStartups: 42, mcpServers: { other: { command: "other-bin", args: [] } } }, null, 2),
        );
        apply({ platforms: ["claude"], home });
        const cfg = readJson(path);
        expect(cfg.numStartups).toBe(42);
        expect(cfg.mcpServers.other).toEqual({ command: "other-bin", args: [] });
        expect(cfg.mcpServers.pinecall).toEqual(entry());
    });

    it("backs the file up before writing", () => {
        const path = join(home, ".cursor/mcp.json");
        mkdirSync(join(home, ".cursor"));
        writeFileSync(path, '{"mcpServers":{}}');
        apply({ platforms: ["cursor"], home });
        expect(readFileSync(`${path}.bak`, "utf8")).toBe('{"mcpServers":{}}');
    });

    it("repairs a drifted entry instead of adding a second one", () => {
        const path = join(home, ".cursor/mcp.json");
        mkdirSync(join(home, ".cursor"));
        writeFileSync(path, JSON.stringify({ mcpServers: { pinecall: { command: "node", args: ["/old/checkout.js"] } } }));
        const [res] = apply({ platforms: ["cursor"], home });
        expect(res!.action).toBe("repaired");
        const cfg = readJson(path);
        expect(Object.keys(cfg.mcpServers)).toEqual(["pinecall"]);
        expect(cfg.mcpServers.pinecall).toEqual(entry());
    });

    it("is idempotent — three runs, one entry, byte-identical", () => {
        const path = join(home, ".cursor/mcp.json");
        apply({ platforms: ["cursor"], home });
        const once = readFileSync(path, "utf8");
        apply({ platforms: ["cursor"], home });
        apply({ platforms: ["cursor"], home });
        expect(readFileSync(path, "utf8")).toBe(once);
        expect(Object.keys(readJson(path).mcpServers)).toEqual(["pinecall"]);
    });

    it("--remove takes out exactly the pinecall key", () => {
        const path = join(home, ".claude.json");
        writeFileSync(path, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x", args: [] } } }));
        apply({ platforms: ["claude"], home });
        const [res] = apply({ platforms: ["claude"], remove: true, home });
        expect(res!.action).toBe("removed");
        const cfg = readJson(path);
        expect(cfg.mcpServers.pinecall).toBeUndefined();
        expect(cfg.mcpServers.other).toEqual({ command: "x", args: [] });
        expect(cfg.theme).toBe("dark");
    });

    it("reports a broken config instead of throwing", () => {
        const path = join(home, ".cursor/mcp.json");
        mkdirSync(join(home, ".cursor"));
        writeFileSync(path, "{ not json");
        const [res] = apply({ platforms: ["cursor"], home });
        expect(res!.action).toMatch(/^FAILED/);
    });
});

describe("TOML host (Codex)", () => {
    const path = () => join(home, ".codex/config.toml");

    it("renders a valid section", () => {
        apply({ platforms: ["codex"], home });
        expect(readFileSync(path(), "utf8")).toBe(
            '[mcp_servers.pinecall]\ncommand = "npx"\nargs = ["-y", "@pinecall/mcp"]\n',
        );
    });

    it("appends after existing content, keeping comments and other servers", () => {
        mkdirSync(join(home, ".codex"), { recursive: true });
        writeFileSync(path(), '# my codex\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\nargs = []\n');
        apply({ platforms: ["codex"], home });
        const text = readFileSync(path(), "utf8");
        expect(text).toContain("# my codex");
        expect(text).toContain("[mcp_servers.other]");
        expect(text).toContain("[mcp_servers.pinecall]");
    });

    it("replaces a drifted section rather than duplicating it, and is idempotent", () => {
        mkdirSync(join(home, ".codex"), { recursive: true });
        writeFileSync(path(), '[mcp_servers.pinecall]\ncommand = "old"\nargs = []\n\n[mcp_servers.other]\ncommand = "o"\n');
        apply({ platforms: ["codex"], home });
        const once = readFileSync(path(), "utf8");
        apply({ platforms: ["codex"], home });
        const twice = readFileSync(path(), "utf8");
        expect(twice).toBe(once);
        expect(twice.match(/\[mcp_servers\.pinecall\]/g)!.length).toBe(1);
        expect(twice).not.toContain('command = "old"');
        expect(twice).toContain("[mcp_servers.other]");
    });

    it("--remove drops only the pinecall section", () => {
        mkdirSync(join(home, ".codex"), { recursive: true });
        writeFileSync(path(), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "o"\n');
        apply({ platforms: ["codex"], home });
        apply({ platforms: ["codex"], remove: true, home });
        const text = readFileSync(path(), "utf8");
        expect(text).not.toContain("pinecall");
        expect(text).toContain("[mcp_servers.other]");
        expect(text).toContain('model = "gpt-5"');
    });
});

describe("the sweep", () => {
    it("with no platforms named, writes only what is installed", () => {
        mkdirSync(join(home, ".cursor"), { recursive: true });
        const results = Object.fromEntries(apply({ home }).map((r) => [r.platform, r.action]));
        expect(results.cursor).toBe("registered");
        expect(results.codex).toMatch(/^skipped/);
        expect(existsSync(join(home, ".codex/config.toml"))).toBe(false);
    });

    it("naming a platform writes it even when undetected", () => {
        const [res] = apply({ platforms: ["windsurf"], home });
        expect(res!.action).toBe("registered");
        expect(existsSync(join(home, ".codeium/windsurf/mcp_config.json"))).toBe(true);
    });

    it("rejects an unknown platform by name", () => {
        expect(() => apply({ platforms: ["emacs"], home })).toThrow(/unknown platform/);
    });
});

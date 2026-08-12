/**
 * Key discovery — the chain an IDE actually needs.
 *
 * Every test runs against a THROWAWAY home directory in os.tmpdir(); the real
 * HOME is never read and never written, so running this suite can neither
 * leak the developer's key nor clobber their ~/.pinecall/credentials.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    RC_FILES,
    credentialsPath,
    readCredentials,
    resolveApiKey,
    scanRcText,
    scanShellRcFiles,
    writeCredentials,
} from "../src/credentials.js";
import { Session } from "../src/session.js";

let home: string;
const noEnv = {} as NodeJS.ProcessEnv;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pinecall-cred-"));
});
afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

/** Mode bits only — the type bits are not ours to assert. */
const mode = (p: string) => statSync(p).mode & 0o777;

describe("the credentials store", () => {
    it("round-trips the key and writes it 0600", () => {
        expect(writeCredentials("pk_stored", home)).toBe(true);
        expect(readCredentials(home)).toBe("pk_stored");
        expect(mode(credentialsPath(home))).toBe(0o600);
    });

    it("tightens an already-loose file instead of leaving it readable", () => {
        mkdirSync(join(home, ".pinecall"), { recursive: true });
        writeFileSync(credentialsPath(home), '{"api_key":"pk_old"}', { mode: 0o644 });
        writeCredentials("pk_new", home);
        expect(mode(credentialsPath(home))).toBe(0o600);
        expect(readCredentials(home)).toBe("pk_new");
    });

    it("treats a missing or malformed store as simply no key", () => {
        expect(readCredentials(home)).toBe("");
        mkdirSync(join(home, ".pinecall"), { recursive: true });
        writeFileSync(credentialsPath(home), "not json at all");
        expect(readCredentials(home)).toBe("");
        writeFileSync(credentialsPath(home), '{"api_key": 42}');
        expect(readCredentials(home)).toBe("");
    });
});

describe("the rc scan", () => {
    it("reads the key through every quoting style a shell allows", () => {
        expect(scanRcText('export PINECALL_API_KEY="pk_double"')).toBe("pk_double");
        expect(scanRcText("export PINECALL_API_KEY='pk_single'")).toBe("pk_single");
        expect(scanRcText("export PINECALL_API_KEY=pk_bare")).toBe("pk_bare");
        expect(scanRcText("PINECALL_API_KEY=pk_no_export")).toBe("pk_no_export");
        expect(scanRcText("  export   PINECALL_API_KEY = pk_spaced ")).toBe("pk_spaced");
        expect(scanRcText("export PINECALL_API_KEY=pk_commented # my key")).toBe("pk_commented");
    });

    it("ignores a commented-out line and takes the last real assignment", () => {
        expect(scanRcText("# export PINECALL_API_KEY=pk_dead\n")).toBe("");
        expect(scanRcText("export PINECALL_API_KEY=pk_first\nexport PINECALL_API_KEY=pk_last\n")).toBe("pk_last");
    });

    it("does not confuse a different variable for this one", () => {
        expect(scanRcText("export MY_PINECALL_API_KEY=pk_other\n")).toBe("");
        expect(scanRcText("export PINECALL_API_KEY_OLD=pk_other\n")).toBe("");
    });

    it("walks the rc files in shell order — .zshenv before .zshrc", () => {
        writeFileSync(join(home, ".zshrc"), "export PINECALL_API_KEY=pk_zshrc\n");
        expect(scanShellRcFiles(home)).toEqual({ apiKey: "pk_zshrc", file: join(home, ".zshrc") });
        writeFileSync(join(home, ".zshenv"), "export PINECALL_API_KEY=pk_zshenv\n");
        expect(scanShellRcFiles(home)?.apiKey).toBe("pk_zshenv");
    });

    it("finds the key in any of the supported rc files", () => {
        for (const name of RC_FILES) {
            const h = mkdtempSync(join(tmpdir(), "pinecall-rc-"));
            writeFileSync(join(h, name), `export PINECALL_API_KEY=pk_${name}\n`);
            expect(scanShellRcFiles(h)?.file).toBe(join(h, name));
            rmSync(h, { recursive: true, force: true });
        }
    });

    it("returns null when nothing in the home dir mentions the key", () => {
        writeFileSync(join(home, ".zshrc"), "alias ll='ls -la'\n");
        expect(scanShellRcFiles(home)).toBeNull();
    });
});

describe("resolveApiKey — the precedence, pinned", () => {
    it("env beats the store and the rc file", () => {
        writeCredentials("pk_store", home);
        writeFileSync(join(home, ".zshrc"), "export PINECALL_API_KEY=pk_rc\n");
        const r = resolveApiKey({ PINECALL_API_KEY: "pk_env" } as NodeJS.ProcessEnv, home);
        expect(r).toMatchObject({ apiKey: "pk_env", source: "env", persisted: false });
    });

    it("the store beats the rc file", () => {
        writeCredentials("pk_store", home);
        writeFileSync(join(home, ".zshrc"), "export PINECALL_API_KEY=pk_rc\n");
        const r = resolveApiKey(noEnv, home);
        expect(r).toMatchObject({ apiKey: "pk_store", source: "credentials", persisted: false });
    });

    it("falls back to the rc file and persists the hit 0600, so the scan is one-time", () => {
        writeFileSync(join(home, ".zshrc"), 'export PINECALL_API_KEY="pk_from_rc"\n');
        const r = resolveApiKey(noEnv, home);
        expect(r).toMatchObject({
            apiKey: "pk_from_rc",
            source: "shell-rc",
            persisted: true,
            rcFile: join(home, ".zshrc"),
        });
        expect(mode(credentialsPath(home))).toBe(0o600);
        // The second start no longer needs the fragile path.
        expect(resolveApiKey(noEnv, home)).toMatchObject({ apiKey: "pk_from_rc", source: "credentials" });
    });

    it("reports no key at all rather than throwing", () => {
        expect(resolveApiKey(noEnv, home)).toMatchObject({ apiKey: "", source: "none" });
    });

    it("never writes anything when the key came from env or the store", () => {
        resolveApiKey({ PINECALL_API_KEY: "pk_env" } as NodeJS.ProcessEnv, home);
        expect(existsSync(credentialsPath(home))).toBe(false);
    });
});

describe("Session over the chain", () => {
    it("boots from a fake ~/.zshrc when the env is empty, and says so without the key", () => {
        writeFileSync(join(home, ".zshrc"), "export PINECALL_API_KEY=pk_rc_boot\n");
        const s = new Session(noEnv, home);
        expect(s.hasApiKey()).toBe(true);
        expect(s.apiKey()).toBe("pk_rc_boot");
        expect(s.keySource).toBe("shell-rc");
        expect(s.keyPersisted).toBe(true);
        expect(readCredentials(home)).toBe("pk_rc_boot");
        expect(mode(credentialsPath(home))).toBe(0o600);

        const notice = s.keyNotice()!;
        expect(notice).toContain(".zshrc");
        expect(notice).toContain("~/.pinecall/credentials");
        expect(notice).not.toContain("pk_rc_boot");
    });

    it("labels an env key `env` and stays silent — nothing to warn about", () => {
        const s = new Session({ PINECALL_API_KEY: "pk_env" } as NodeJS.ProcessEnv, home);
        expect(s.keySource).toBe("env");
        expect(s.keyNotice()).toBeNull();
    });

    it("set_api_key stays in memory by default and writes 0600 only when asked", () => {
        const s = new Session(noEnv, home);
        expect(s.setApiKey("pk_mem")).toBe(false);
        expect(s.keySource).toBe("session");
        expect(existsSync(credentialsPath(home))).toBe(false);

        expect(s.setApiKey("pk_persisted", true)).toBe(true);
        expect(readCredentials(home)).toBe("pk_persisted");
        expect(mode(credentialsPath(home))).toBe(0o600);
    });

    it("keeps a discovered key off its own serialization", () => {
        writeFileSync(join(home, ".zshrc"), "export PINECALL_API_KEY=pk_rc_secret\n");
        const s = new Session(noEnv, home);
        expect(JSON.stringify(s)).not.toContain("pk_rc_secret");
    });
});

describe("the whoami result", () => {
    it("carries the provenance and the notice, never the key", async () => {
        writeFileSync(join(home, ".zshrc"), "export PINECALL_API_KEY=pk_rc_whoami\n");
        const session = new Session(noEnv, home);
        // Stub the one network call so this stays a unit test of the shape.
        (session as any).playground = async () => ({ name: "Acme", slug: "acme", credits: 10 });

        const whoami = (await import("../src/tools/whoami.js")).default;
        const out: any = await whoami.handler({}, { session } as any);

        expect(out.keySource).toBe("shell-rc");
        expect(out.persisted).toBe(true);
        expect(out.notice).toContain("~/.pinecall/credentials");
        expect(JSON.stringify(out)).not.toContain("pk_rc_whoami");
    });
});

describe("the CLI reads the same store", () => {
    it("resolveConfig picks up ~/.pinecall/credentials after env", async () => {
        writeCredentials("pk_cli_store", home);
        const realHome = process.env.HOME;
        const realKey = process.env.PINECALL_API_KEY;
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        delete process.env.PINECALL_API_KEY;
        try {
            // Imported here so os.homedir() is read after HOME is redirected.
            const { resolveConfig } = await import("../../src/cli/config.js");
            expect(resolveConfig([]).apiKey).toBe("pk_cli_store");
            // …and env still wins over it.
            process.env.PINECALL_API_KEY = "pk_cli_env";
            expect(resolveConfig([]).apiKey).toBe("pk_cli_env");
            // …and an explicit flag wins over both.
            expect(resolveConfig(["--api-key=pk_flag"]).apiKey).toBe("pk_flag");
        } finally {
            if (realHome === undefined) delete process.env.HOME;
            else process.env.HOME = realHome;
            if (realKey === undefined) delete process.env.PINECALL_API_KEY;
            else process.env.PINECALL_API_KEY = realKey;
        }
    });
});

describe("the store file itself", () => {
    it("is the documented JSON shape, so the CLI and the MCP agree byte for byte", () => {
        writeCredentials("pk_shape", home);
        expect(JSON.parse(readFileSync(credentialsPath(home), "utf8"))).toEqual({ api_key: "pk_shape" });
    });
});

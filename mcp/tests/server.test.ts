/**
 * Boots the real server over a real stdio transport with a real MCP client.
 * No mocks of the protocol — if the wiring is wrong, this fails.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tools } from "../src/tools/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "src", "index.ts");

async function connect(env: Record<string, string> = {}) {
    const client = new Client({ name: "test", version: "0" });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", entry],
        env: { PATH: process.env.PATH ?? "", ...env },
        stderr: "pipe",
    });
    await client.connect(transport);
    return client;
}

describe("@pinecall/mcp server over stdio", () => {
    let client: Client;

    beforeAll(async () => {
        client = await connect();
    });

    afterAll(async () => {
        await client?.close();
    });

    it("boots and lists every registered tool with a schema", async () => {
        const listed = await client.listTools();
        const names = listed.tools.map((t) => t.name).sort();
        expect(names).toContain("whoami");
        expect(names).toContain("set_api_key");
        expect(names).toEqual(tools.map((t) => t.name).sort());

        for (const t of listed.tools) {
            expect(t.description, `${t.name} has no description`).toBeTruthy();
            expect(t.inputSchema, `${t.name} has no inputSchema`).toBeTruthy();
            expect(t.inputSchema.type).toBe("object");
        }

        const setKey = listed.tools.find((t) => t.name === "set_api_key")!;
        expect(Object.keys(setKey.inputSchema.properties ?? {})).toContain("key");
    });

    it("serves instructions: the playbook preamble + one manual per tool", async () => {
        const instructions = client.getInstructions() ?? "";
        expect(instructions).toContain("zero to a production voice agent");
        expect(instructions).toContain("The journey");
        expect(instructions).toContain("Chat IS the testing story");
        expect(instructions).toContain("dev-");
        for (const t of tools) {
            expect(instructions, `no manual section for ${t.name}`).toContain(`### ${t.name}`);
            expect(instructions).toContain(t.manual.split("\n")[0]);
        }
    });

    it("without a key, a tool errors naming set_api_key and echoes no key", async () => {
        const bare = await connect({ PINECALL_API_KEY: "" });
        try {
            const res: any = await bare.callTool({ name: "whoami", arguments: {} });
            expect(res.isError).toBe(true);
            const text = res.content.map((c: any) => c.text).join("\n");
            expect(text).toContain("set_api_key");
            expect(text).not.toMatch(/pk_[A-Za-z0-9]/);
        } finally {
            await bare.close();
        }
    });

    it("never echoes the key back, even when the key is set", async () => {
        const secret = "pk_test_shouldneverappear123456";
        const withKey = await connect({
            PINECALL_API_KEY: secret,
            // Point at a dead host so the call fails fast and we inspect the ERROR path,
            // which is where a credential would realistically leak.
            PINECALL_PLAYGROUND_URL: "http://127.0.0.1:1",
        });
        try {
            const res: any = await withKey.callTool({ name: "whoami", arguments: {} });
            const text = JSON.stringify(res);
            expect(text).not.toContain(secret);
        } finally {
            await withKey.close();
        }
    });
});

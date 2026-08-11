/**
 * `@pinecall/sdk/log` must be shippable to a browser.
 *
 * The root entrypoint imports `ws` and node builtins, which is why the
 * package has been node-only. The Call Log contract is the piece a browser
 * needs, so its subpath carries NOTHING from outside `src/log/**`. That is a
 * claim about the module graph, so it is asserted against a real bundle
 * rather than by reading imports.
 *
 * esbuild is already in the tree (tsup depends on it) — no new dependency.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const LOG_DIR = fileURLToPath(new URL("../src/log", import.meta.url));
const ENTRY = fileURLToPath(new URL("../src/log/index.ts", import.meta.url));

const NODE_BUILTINS = [
    "node:fs", "node:http", "node:https", "node:net", "node:tls", "node:path",
    "node:os", "node:crypto", "node:child_process", "node:stream", "node:url",
    "node:buffer", "node:events", "node:worker_threads", "node:process",
    "fs", "http", "https", "net", "tls", "child_process", "worker_threads",
];

describe("@pinecall/sdk/log is browser-clean", () => {
    it("bundles for the browser with no external resolutions at all", async () => {
        const result = await build({
            entryPoints: [ENTRY],
            bundle: true,
            write: false,
            format: "esm",
            platform: "browser",
            target: "es2020",
            metafile: true,
            // Nothing is marked external: any import it cannot inline is a
            // dependency, and a dependency is a failure of this test.
        });

        const inputs = Object.keys(result.metafile.inputs);
        // every file in the graph lives under src/log/
        for (const f of inputs) {
            expect(f.replace(/\\/g, "/")).toMatch(/src\/log\//);
        }
        expect(inputs.length).toBeGreaterThan(0);

        const code = result.outputFiles[0]!.text;
        expect(code).not.toMatch(/\bfrom\s*["']ws["']/);
        expect(code).not.toMatch(/require\(["']ws["']\)/);
        for (const mod of NODE_BUILTINS) {
            expect(code).not.toContain(`"${mod}"`);
            expect(code).not.toContain(`'${mod}'`);
        }
        // No node globals leaked in.
        expect(code).not.toMatch(/\bprocess\.env\b/);
        expect(code).not.toMatch(/\brequire\s*\(/);
    });

    it("has no import that escapes src/log/ (source-level guard)", () => {
        const files = readdirSync(LOG_DIR).filter((f) => f.endsWith(".ts"));
        expect(files.length).toBeGreaterThan(0);
        for (const f of files) {
            const src = readFileSync(`${LOG_DIR}/${f}`, "utf8")
                // Doc comments carry `import … from "@pinecall/sdk/log"` examples.
                .replace(/\/\*[\s\S]*?\*\//g, "")
                .replace(/^\s*\/\/.*$/gm, "");
            const specifiers = [...src.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]!);
            for (const s of specifiers) {
                // Only relative, same-directory imports are legal here.
                expect(s.startsWith("./"), `${f} imports "${s}"`).toBe(true);
                expect(s.includes("..")).toBe(false);
            }
        }
    });
});

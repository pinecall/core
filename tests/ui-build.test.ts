/**
 * The built console (dist/ui) — a smoke test, skipped before `npm run build`.
 *
 * What it guards is what the package promises: `npm i @pinecall/sdk` and the
 * runner has a console to serve — an index.html that boots local assets only
 * (no CDN script, no remote bundle) and stays small enough that shipping it
 * inside the SDK is free.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../dist/ui/", import.meta.url));
const built = existsSync(join(DIST, "index.html"));

/** Total gzipped weight of the app, in bytes — the whole thing is downloaded once. */
const BUDGET = 1.5 * 1024 * 1024;

describe.skipIf(!built)("the built web console", () => {
    const html = () => readFileSync(join(DIST, "index.html"), "utf8");

    it("ships an index.html that loads local assets", () => {
        const page = html();
        expect(page).toContain('<div id="root">');
        expect(page).toMatch(/<script[^>]+src="\.\/assets\/[^"]+\.js"/);
        expect(page).toMatch(/<link[^>]+href="\.\/assets\/[^"]+\.css"/);
        // Nothing is fetched from a CDN: the runner may have no internet at all.
        expect(page).not.toMatch(/src="https?:\/\//);
    });

    it("has its assets on disk", () => {
        const assets = readdirSync(join(DIST, "assets"));
        expect(assets.some((f) => f.endsWith(".js"))).toBe(true);
        expect(assets.some((f) => f.endsWith(".css"))).toBe(true);
    });

    it("stays inside the size budget", () => {
        let total = 0;
        const walk = (dir: string) => {
            for (const entry of readdirSync(dir)) {
                const path = join(dir, entry);
                if (statSync(path).isDirectory()) walk(path);
                else total += gzipSync(readFileSync(path)).length;
            }
        };
        walk(DIST);
        expect(total).toBeGreaterThan(1024); // an empty build is not a build
        expect(total).toBeLessThan(BUDGET);
    });
});

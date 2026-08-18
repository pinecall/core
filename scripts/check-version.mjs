/**
 * Fails if src/version.ts's fallback literal has drifted from package.json.
 *
 * The shipped bundles get the version injected by tsup's `define`, so they are
 * safe by construction. The literal in src/version.ts is what vitest and tsx
 * see, and nothing at build time would catch it going stale — this does.
 * Wired into `prepublishOnly`.
 */

import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const src = readFileSync(new URL("src/version.ts", root), "utf8");

const match = src.match(/__PKG_VERSION__\s*:\s*"([^"]+)"/);
if (!match) {
    console.error("check:version — no fallback literal found in src/version.ts");
    process.exit(1);
}

if (match[1] !== pkg.version) {
    console.error(
        `check:version — src/version.ts says "${match[1]}", package.json says "${pkg.version}". ` +
        "Update the fallback in src/version.ts to match.",
    );
    process.exit(1);
}

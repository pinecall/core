import { defineConfig } from "tsup";

export default defineConfig([
    // ── SDK library ──────────────────────────────────────────────────────
    {
        entry: ["src/index.ts"],
        format: ["esm", "cjs"],
        dts: true,
        splitting: false,
        sourcemap: true,
        clean: true,
        target: "es2020",
        minify: false,
        external: ["ws", "./runner.js", "./runner.cjs"],
    },
    // ── CLI binary ───────────────────────────────────────────────────────
    {
        entry: ["src/cli.ts"],
        format: ["esm"],
        banner: { js: "#!/usr/bin/env node" },
        dts: false,
        splitting: false,
        sourcemap: false,
        clean: false,
        target: "es2020",
        minify: false,
        external: ["ws", "speaker"],
    },
    // ── Runner display (for `pinecall run`) ──────────────────────────────
    {
        entry: ["src/runner.ts"],
        format: ["esm", "cjs"],
        dts: false,
        splitting: false,
        sourcemap: false,
        clean: false,
        target: "es2020",
        minify: false,
        external: ["ws"],
    },
    // ── Call Log contract (@pinecall/sdk/log) ────────────────────────────
    // Its own build block so the existing "." bundle is untouched. Object
    // entry + explicit outExtension mirror @pinecall/web's tsup.config.ts.
    // No `external`: this subpath has zero dependencies by design and must
    // stay browser-clean (tests/log-browser-safe.test.ts asserts it).
    {
        entry: { "log/index": "src/log/index.ts" },
        format: ["esm", "cjs"],
        dts: true,
        splitting: false,
        sourcemap: true,
        clean: false,
        treeshake: true,
        target: "es2020",
        minify: false,
        outExtension({ format }) {
            return { js: format === "cjs" ? ".cjs" : ".js" };
        },
    },
    // ── Website tap (@pinecall/sdk/tap), ESM ─────────────────────────────
    // Its own bundle so `defuddle` and `linkedom` never reach the "." entry —
    // a caller who only places calls must not pay for the crawler. Both are
    // external here: they are normal runtime deps of this subpath.
    {
        entry: { tap: "src/tap/index.ts" },
        format: ["esm"],
        dts: true,
        splitting: false,
        sourcemap: true,
        clean: false,
        treeshake: true,
        target: "es2020",
        minify: false,
        external: ["ws", "defuddle", "linkedom"],
    },
    // ── Website tap, CJS ─────────────────────────────────────────────────
    // `defuddle/node` publishes an "import" condition and no "require" one, so
    // a CJS consumer cannot require it — it is bundled in here instead of
    // externalised. `linkedom` requires fine and stays external.
    {
        entry: { tap: "src/tap/index.ts" },
        format: ["cjs"],
        dts: true,
        splitting: false,
        sourcemap: true,
        clean: false,
        treeshake: true,
        target: "es2020",
        minify: false,
        external: ["ws", "linkedom"],
        noExternal: [/^defuddle(\/|$)/],
        esbuildOptions(options) {
            // Resolve `defuddle/node` through its "import" condition — it has
            // no "require" one, and without this esbuild gives up and leaves a
            // require() the CJS consumer cannot follow.
            options.conditions = ["import", "module", "node", "default"];
        },
    },
]);

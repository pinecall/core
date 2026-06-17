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
]);

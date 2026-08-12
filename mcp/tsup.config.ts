import { defineConfig } from "tsup";

// One bundle, one binary. SDK internals (../src/**) are pulled in by the
// bundler, which is why mcp/ has no dependency on the published @pinecall/sdk.
export default defineConfig({
    entry: { index: "src/index.ts" },
    format: ["esm"],
    banner: { js: "#!/usr/bin/env node" },
    // Bin package, not a library: consumers run it, they do not import it.
    dts: false,
    splitting: false,
    sourcemap: true,
    clean: true,
    target: "node20",
    external: ["@modelcontextprotocol/sdk", "zod"],
});

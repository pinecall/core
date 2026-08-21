/**
 * The web console's build.
 *
 * Output goes to the package's `dist/ui/` — `files: ["dist"]` ships it, so a
 * plain `npm i @pinecall/sdk` already has the console: no CDN, no extra
 * install. Assets are referenced relatively (`base: "./"`) because the runner
 * may serve them from any host and port.
 *
 * `npm run dev:ui` proxies the API surface to a running `pinecall run`
 * (127.0.0.1:4747 by default, or PINECALL_RUN_UI_PORT), so the app in dev is
 * the same app that ships.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

const target = `http://127.0.0.1:${process.env.PINECALL_RUN_UI_PORT ?? 4747}`;
const proxied = ["/api", "/events", "/token", "/chat-token"];

export default defineConfig({
    root: here,
    base: "./",
    plugins: [react()],
    build: {
        outDir: "../dist/ui",
        emptyOutDir: true,
        target: "es2020",
        chunkSizeWarningLimit: 900,
    },
    server: {
        port: 4748,
        proxy: Object.fromEntries(
            proxied.map((path) => [path, { target, changeOrigin: false, ws: false }]),
        ),
    },
});

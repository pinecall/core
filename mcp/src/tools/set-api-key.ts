/**
 * set_api_key — hand the server a key for THIS session.
 *
 * Memory only: nothing is written to disk and the key is never returned,
 * echoed, or logged. The result is a bare acknowledgement plus whoami-lite
 * confirmation that the key actually works.
 */

import { z } from "zod";
import { defineTool } from "./types.js";

export default defineTool({
    name: "set_api_key",
    description:
        "Store a Pinecall API key (pk_...) in memory for this MCP session. Never written to disk, never echoed back.",
    schema: {
        key: z.string().min(8).describe("The Pinecall API key, e.g. pk_live_… — it is stored in memory only"),
    },
    manual: [
        "**`set_api_key`** — only needed when `PINECALL_API_KEY` is not in the MCP server's",
        "env. The key lives in memory for this process and disappears when the session ends;",
        "it is never written to a file and never appears in any tool result. The result is",
        "`{ ok, verified, org }` — if `verified` is false the key was stored but the org lookup",
        "failed, so fix the key before going further. Never paste a key into any OTHER tool's",
        "arguments and never ask the user to put it in a file this server can read.",
    ].join("\n"),
    async handler(args: { key: string }, { session }) {
        session.setApiKey(args.key);
        try {
            const org = await session.playground<any>("/orgs/me");
            return { ok: true, verified: true, org: org.name ?? org.slug ?? null };
        } catch (err) {
            return {
                ok: true,
                verified: false,
                error: session.redact(err instanceof Error ? err.message : String(err)),
            };
        }
    },
});

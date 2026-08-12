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
    manual: "Only when `PINECALL_API_KEY` is missing from the env. Memory-only, never written. `verified: false` = stored but failing.",
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

/**
 * set_api_key — hand the server a key for THIS session.
 *
 * Memory by default, and the key is never returned, echoed, or logged. With
 * `persist: true` — and only then — it is written to ~/.pinecall/credentials
 * at mode 0600, the single sanctioned disk write of this server, so the next
 * session and the CLI both find it. The result is a bare acknowledgement plus
 * whoami-lite confirmation that the key actually works.
 */

import { z } from "zod";
import { defineTool } from "./types.js";

export default defineTool({
    name: "set_api_key",
    description:
        "Store a Pinecall API key (pk_...) for this MCP session — in memory, or with persist:true also in ~/.pinecall/credentials (0600). Never echoed back.",
    schema: {
        key: z.string().min(8).describe("The Pinecall API key, e.g. pk_live_… — it is never echoed back"),
        persist: z
            .boolean()
            .optional()
            .describe("Also save it to ~/.pinecall/credentials (mode 0600) so future sessions and the CLI find it"),
    },
    manual:
        "Only when discovery found no key. `persist: true` also writes ~/.pinecall/credentials (0600, CLI-shared) — ask first. `verified: false` = stored but failing.",
    async handler(args: { key: string; persist?: boolean }, { session }) {
        const persisted = session.setApiKey(args.key, args.persist === true);
        try {
            const org = await session.playground<any>("/orgs/me");
            return { ok: true, verified: true, persisted, org: org.name ?? org.slug ?? null };
        } catch (err) {
            return {
                ok: true,
                verified: false,
                persisted,
                error: session.redact(err instanceof Error ? err.message : String(err)),
            };
        }
    },
});

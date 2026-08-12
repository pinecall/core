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
    manual: [
        "**`set_api_key`** — needed when the key reached none of the three discovery paths",
        "(the server's env, `~/.pinecall/credentials`, a shell rc file). By default the key",
        "lives in memory for this process and disappears when the session ends. Pass",
        "`persist: true` to ALSO write it to `~/.pinecall/credentials` (JSON `{api_key}`, mode",
        "0600) — that file is the one thing this server ever writes, it is shared with the",
        "`pinecall` CLI, and it is what makes the key survive a restart. Ask the user before",
        "persisting. The result is `{ ok, verified, persisted, org }` — if `verified` is false",
        "the key was stored but the org lookup failed, so fix the key before going further.",
        "The key never appears in any tool result. Never paste a key into any OTHER tool's",
        "arguments.",
    ].join("\n"),
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

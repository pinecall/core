/**
 * Content hashing — the thing that makes a re-tap cheap.
 *
 * The hash is taken over the extracted MARKDOWN, not the HTML: a site that
 * ships a new build id or a rotating nonce changes its HTML on every request
 * while the prose stays identical, and hashing the HTML would re-push the
 * whole knowledge base each sync.
 */

import { createHash } from "node:crypto";

/** sha256 of the text, first 16 hex characters — 64 bits, plenty for dedupe. */
export function contentHash(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

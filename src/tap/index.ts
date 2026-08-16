/**
 * `@pinecall/sdk/tap` — tap a website into a knowledge base.
 *
 * Its own subpath because tapping costs two runtime dependencies (`defuddle`
 * and `linkedom`) that a caller who only places calls must not pay for: the
 * package root never imports this module, and the built root bundle is checked
 * for those two names.
 *
 * Three verbs, in the order you use them:
 *
 * - {@link planTap} — discover, fetch and extract, and hand back a table.
 *   Writes nothing, anywhere.
 * - {@link tap} — pour a plan (or a URL) into a knowledge base, and leave a
 *   `_tap-manifest.json` behind saying what it left.
 * - {@link syncTap} — re-tap from that manifest: push what moved, delete what
 *   the site stopped serving, skip the rest.
 *
 * @example
 * ```ts
 * import { planTap, tap } from "@pinecall/sdk/tap";
 *
 * const plan = await planTap("https://example.com", { limit: 50 });
 * console.table(plan.pages);
 * const report = await tap({ apiKey }, kbId, plan, {
 *     onProgress: (ev) => setWidth(ev.done / Math.max(ev.total, 1)),
 * });
 * ```
 */

// ── The three verbs ──────────────────────────────────────────────────────

export { planTap, docPath, isExcluded } from "./plan.js";
export { tap, syncTap, readManifest, TapSyncError, MANIFEST_PATH } from "./tap.js";

// ── Progress contract ────────────────────────────────────────────────────

export type {
    TapProgress,
    TapPhase,
    TapEvent,
    OnProgress,
    DiscoverySource,
} from "./types.js";

// ── Plan shapes ──────────────────────────────────────────────────────────

export type { TapPage, TapPlan, TapPlanTotals, PlanTapOptions } from "./plan.js";

// ── Tap shapes ───────────────────────────────────────────────────────────

export type {
    TapOptions,
    SyncTapOptions,
    TapReport,
    TapFailure,
    TapManifest,
    TapManifestEntry,
    TapCrawlOptions,
} from "./tap.js";

// ── Politeness defaults ──────────────────────────────────────────────────
//
// Exported as values because a UI that says "100 pages max, 4 at a time"
// should read the numbers rather than repeat them.

export { DEFAULT_PAGE_LIMIT, DEFAULT_CONCURRENCY } from "./discover.js";
export { USER_AGENT, DEFAULT_TIMEOUT_MS, TapFetchError } from "./fetch.js";
export { THIN_CONTENT_WORDS, SPA_TEXT_RATIO } from "./extract.js";

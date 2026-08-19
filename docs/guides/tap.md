---
title: "Tap a Website"
description: Guide — crawl a website client-side, extract it to clean markdown and pour it into a knowledge base, then keep it in sync.
---

# Tap a website

Tapping a pine does not fell it: you make one small opening and the resin comes
out on its own, and you come back next season to the same tree. **Tap** is that,
for a website — you point it at a URL, it takes the readable text out, and it
comes back later for whatever changed.

Concretely, `@pinecall/sdk/tap` is a client-side crawler:

1. **discover** — `robots.txt`, then the sitemap, and one hop of same-site links
   as a fallback;
2. **extract** — each page through [defuddle](https://github.com/kepano/defuddle)
   over [linkedom](https://github.com/WebReflection/linkedom), which strips nav,
   footers and cookie banners and leaves markdown;
3. **pour** — the markdown into a knowledge base through the public knowledge
   API, one document per page.

It runs entirely in your process. Nothing is uploaded until you say so, and the
only thing the server ever sees is markdown.

> **Its own subpath.** `import … from "@pinecall/sdk/tap"` — never from the
> package root. Tapping costs two runtime dependencies, and a caller who only
> places calls does not pay for them: the root bundle contains neither.

---

## The three verbs

| verb | writes | what it is for |
|---|---|---|
| `planTap(url, opts)` | **nothing** | preview: the page table a human approves |
| `tap(auth, kbId, plan \| url, opts)` | the KB | pour the plan in, leave a manifest |
| `syncTap(auth, kbId, opts)` | the KB | re-tap from that manifest, incrementally |

---

## Step 1 — Preview with `planTap`

`planTap` touches no knowledge base at all. It discovers, fetches and extracts,
and hands back a table.

```ts
import { planTap } from "@pinecall/sdk/tap";

const plan = await planTap("https://acme.com", {
  limit: 100,                       // politeness default
  exclude: [/\/tag\//, /\/author\//],
});

console.log(plan.source);           // "sitemap" | "links"
console.table(
  plan.pages.map((p) => ({
    url: p.url, path: p.path, words: p.words,
    thin: p.thin, needsJs: p.needsJs, excluded: !!p.excluded,
  })),
);
console.log(plan.totals);
// { pages: 84, included: 71, excluded: 13, failed: 0,
//   thin: 6, needsJs: 2, words: 41200, tokens: 62000 }
```

Two things about the table that are deliberate:

- **Excluded pages are marked, not dropped.** A preview that silently omits half
  a site cannot be checked. They carry `excluded: true` and are never fetched.
- **A bad page is a row, not an exception.** One 404 among a hundred URLs lands
  as a page with `error` set; the other ninety-nine survive.

`PlanTapOptions`: `limit`, `concurrency`, `include`, `exclude`, `language`,
`timeoutMs`, `keepContent`, `onProgress`.

`keepContent: true` keeps each page's markdown on the plan. Off by default —
a 200-page site is several megabytes of prose that a UI would otherwise pin
while a human reads the table. Turn it on when you are about to `tap` the same
plan and want to skip re-fetching.

---

## Step 2 — Confirm, then `tap`

Show the table, get a yes, then pour it in:

```ts
import { tap } from "@pinecall/sdk/tap";
import { createKnowledgeBase } from "@pinecall/sdk";

const auth = { apiKey: process.env.PINECALL_API_KEY! };
const kb = await createKnowledgeBase(auth, "acme.com", "The public website");

const report = await tap(auth, kb.id, plan);
console.log(report);
// { pushed: 71, updated: 0, skipped: 0, failed: [], deleted: 0, reindexed: true }
```

Passing a **URL** instead of a plan is allowed — `tap` plans it itself — but then
nobody approved anything, so prefer the plan for anything user-facing.

`tap` leaves a `_tap-manifest.json` document **inside the knowledge base**: the
start URL, the discovery source, the timestamp, the crawl options the run used,
and a hash per document path. That file is what makes step 4 cheap, and it lives
in the KB rather than on your disk so any machine can pick the sync up.

The options block is what keeps a sync honest:

```json
{
  "version": 1,
  "startUrl": "https://acme.com",
  "source": "sitemap",
  "tappedAt": "2026-08-16T10:00:00.000Z",
  "options": { "limit": 8, "exclude": ["\\/blog\\/"] },
  "pages": { "index.md": { "url": "https://acme.com/", "hash": "…" } }
}
```

`include`/`exclude` are stored as **regex sources** (`re.source`) because a
`RegExp` does not survive JSON, and are rebuilt with `new RegExp(s)` on read.
The field is optional: a manifest written before it existed syncs with the
defaults (limit 100, no filters), and the manifest version stays `1`.

---

## Step 3 — Attach the knowledge base to an agent

Nothing tap-specific here: it is the same `knowledgeBase` field as any other
knowledge base.

```ts
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall();
pc.agent("acme-site", {
  llm: "anthropic/claude-haiku-4-5",
  knowledgeBase: kb.id,
  prompt: "You answer from acme.com. Say so when the docs do not cover it.\n\n{{RAG_CONTEXT}}",
});
```

---

## Step 4 — `syncTap` on a schedule

`syncTap` needs nothing but the knowledge base: the manifest already says which
site this is, what was in it, and **how it was crawled** — a tap run with
`limit: 8` syncs with `limit: 8`, not with the default 100. Pass `limit`,
`include` or `exclude` to override a stored one; the override wins and is
written back to the manifest.

```ts
import { syncTap, TapSyncError } from "@pinecall/sdk/tap";

try {
  const report = await syncTap(auth, kb.id);
  console.log(report);
  // { pushed: 2, updated: 5, skipped: 64, failed: [], deleted: 1, reindexed: true }
} catch (err) {
  if (err instanceof TapSyncError) {
    // NEVER_TAPPED — this KB has no manifest. Run tap() first.
  }
  throw err;
}
```

- pages whose hash is unchanged are **skipped**, never sent;
- pages the site stopped serving are **deleted** from the KB;
- the index is rebuilt only when something actually moved — `reindexed: false`
  on a quiet run. Pass `reindex: false` to suppress it entirely and rebuild on
  your own schedule.

A nightly cron over `syncTap` is the intended shape. On a site that did not move
it is a handful of GETs and no writes at all.

---

## The progress contract

Every long operation takes `onProgress?: (ev: TapProgress) => void`.

```ts
interface TapProgress {
  phase: "discover" | "fetch" | "extract" | "push" | "delete" | "reindex";
  event: "start" | "page" | "done" | "error";
  url?: string;
  path?: string;
  done: number;    // always present
  total: number;   // always present
  message?: string;
}
```

`done` and `total` are on **every** event, not just `page`. That is the whole
point: a bar that only moves on some events stutters. A listener that throws is
swallowed — a progress callback must never break a crawl.

Wiring it to a bar is exactly this — `done / total` is the width:

```ts
const bar = document.querySelector<HTMLDivElement>("#bar")!;
const label = document.querySelector<HTMLSpanElement>("#label")!;

await tap(auth, kbId, plan, {
  onProgress(ev) {
    const pct = ev.total > 0 ? Math.round((ev.done / ev.total) * 100) : 0;
    bar.style.width = `${pct}%`;
    label.textContent =
      ev.event === "error"
        ? `${ev.phase}: ${ev.message ?? "failed"}`
        : `${ev.phase} ${ev.done}/${ev.total}${ev.url ? ` — ${ev.url}` : ""}`;
  },
});
```

Each phase counts its own `total`, so the bar resets per phase (`discover`, then
`fetch`, `extract`, `push`, `delete`, `reindex`). Show the phase name next to it
and the reset reads as progress rather than a glitch.

---

## `needsJs` — flagged, never rendered

There is no headless browser in here, and there will not be one. A page whose
visible-text-to-HTML ratio falls below `SPA_TEXT_RATIO` (0.012) is almost
certainly a client-rendered shell: the markup arrived, the content did not.

Tap says so — `needsJs: true` on the plan row — and stops there. It does not
render the page, and it does not pretend the empty shell is content. Such a page
is still indexable if you choose to include it; you will just be indexing what
the server actually sent. `thin: true` is the softer neighbour: fewer than 120
words, which is short but not necessarily broken.

---

## Politeness defaults

They are defaults because they are the right answer, not because they are a
starting point.

| | default | constant |
|---|---|---|
| user agent | `pinecall-tap/<version> (+https://pinecall.io)` | `USER_AGENT` |
| pages per tap | 100 | `DEFAULT_PAGE_LIMIT` |
| concurrent requests | 4 | `DEFAULT_CONCURRENCY` |
| per-page timeout | 15 000 ms | `DEFAULT_TIMEOUT_MS` |

`robots.txt` is read first and its `User-agent: *` disallow rules are honoured —
including a **blanket `Disallow: /`**, which yields a plan with **no pages**
rather than an exception. "This site refuses crawlers" is an answer, not a
crash; check `plan.totals.pages === 0` and tell the user.

The constants are exported so a UI can display the numbers instead of repeating
them.

---

## CLI equivalents

```bash
# preview only — writes nothing
pinecall knowledge tap https://acme.com --dry-run

# no kbId: the CLI creates a KB named "site: acme.com" and prints its id
pinecall knowledge tap https://acme.com

# into an existing KB, with URL filters
pinecall knowledge tap https://acme.com kb_1a2b3c --exclude='/blog/'

# skip the confirmation (CI), cap the crawl
pinecall knowledge tap https://acme.com kb_1a2b3c --limit=50 --yes

# incremental re-tap from the manifest
pinecall knowledge sync kb_1a2b3c
```

The signature is `pinecall knowledge tap <url> [kbId]` — the URL comes first and
the knowledge base is optional. Flags: `--limit=N`, `--include=<re>`,
`--exclude=<re>` (comma-separated regexes), `--dry-run`, `--yes`, `--no-reindex`.

`tap` prints the same page table `planTap` returns, asks for confirmation
(`--yes` skips it), then renders the `TapProgress` stream as a bar. `sync` is
`syncTap` and prints the delta.

---

## See also

- [Knowledge bases (RAG)](/guides/knowledge-bases) — creating a KB, attaching it,
  `{{RAG_CONTEXT}}`, debugging retrieval with `queryKnowledge`.

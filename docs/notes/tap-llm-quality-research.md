---
title: "Tap quality research — noise measured on real sites, LLM options A–E, recommendation"
description: Research note (2026-08-21) — how much junk `pinecall knowledge tap` really pushes, what a deterministic pass and four LLM passes do about it, what each costs, and a phased card plan.
---

# Tap quality research — noise, LLM triage / cleanup / enrichment

Card tk-818bd3, 2026-08-21; the cells the Anthropic outage left un-measured
were filled by card tk-903a6d on 2026-08-22 with the gateway's **new default
model** — `cheap` → `openrouter/qwen/qwen3-30b-a3b-instruct-2507` ($0.048 / $0.193
per M tokens in/out; `GET /api/llm/models` → `default: cheap`). Rows are
tagged by model: `haiku` = `claude-haiku-4-5` (the 2026-08-21 runs), `cheap` =
the qwen3-30b above. Research only: nothing in `src/` changed. Every number
below comes from `scripts/research/*` run against four public sites (plus one
anecdote) and a throw-away dev KB; the scripts and the manual labels
(`scripts/research/fixtures/`) reproduce them.

> **Headline.** On the sites tapped, the classic noise — nav, footer, cookie
> text — is already gone: Defuddle leaves **< 3 % cross-page boilerplate by
> tokens**. The junk that does reach the KB is **whole pages** (empty shells,
> JS-only app pages, auth/legal pages, duplicates, link lists: **0–22 % of
> pages, ≤ 9 % of tokens**), the **manifest document itself**, and
> **extraction defects** (inline SVG — 97 % of the bytes on one blog; the H1
> dropped on 100 % of pages; five docs pages starting mid-sentence). Retrieval
> is better than the premise assumed: the raw tap answers **39/40** questions in
> the top-5, with **5 %** junk hits. A free deterministic pass (option A) halves
> the junk hits but also **deleted facts twice** (a repeated bio, a sign-up page).
> The LLM passes are cheap to run — with haiku **$0.0007/page** triage,
> **$0.004/page** enrichment, **$0.01/page** cleanup; with the gateway's new
> default (qwen3-30b via OpenRouter) **20–40× less again: $0.00002 / $0.0001 /
> $0.0002 per page** — but on these sites **add little the deterministic pass
> does not already get**; enrichment is the one that moved a retrieval number
> (it recovered both answers A lost — caveman with haiku, joel with the cheap
> model) and also the one that can cost ranks when it rewrites every title
> (basecamp, cheap: MRR 0.933 → 0.803). The overview (E) never answered a
> question the pages did not. Cleanup (C) with the cheap model silently deleted
> fact-bearing tooltip text on basecamp's pricing page — the containment check
> does not see deletions — and lost a rank on two sites. Recommendation: ship A
> (with a "keep one copy" rule and the manifest out of the index) now; ship
> LLM triage + enrichment as an opt-in lane on the cheap default model, cached
> by content hash, with the rewritten title in the header only; keep cleanup
> guarded (now also against deletions) and summarisation out; measure on two
> customer KBs before any LLM lane is on by default.

---

## 1 · The pipeline, and where noise enters

```
discover ─▶ planTap ─▶ fetch ─▶ extract ─▶ frontmatter ─▶ push ─▶ reindex (server)
 robots +    include/   GET +     Defuddle   url/title/    KB doc    megabrain: QMD
 sitemap,    exclude,   needsJs   over       hash/         per       heading chunks,
 1-hop       totals     flag      linkedom   fetchedAt     path      dense + BM25
 links                            → markdown
                                              └── syncTap: re-plan, re-extract, push only changed hashes
```

| stage | file | what it decides | noise it lets through (measured) | where an LLM could sit |
|---|---|---|---|---|
| discover | `src/tap/discover.ts` | the URL list: sitemap (ranked by depth, then `<priority>`), else one hop of links | coverage, not noise: docs.pinecall.io has no sitemap → 17 pages by links; joelonsoftware's read bound (500) stops inside the post sitemap → 59/60 pages are posts from 2000 | no — URL triage needs content; see plan |
| planTap | `src/tap/plan.ts` | per page: words, tokens, `thin`, `needsJs`, hash; `include`/`exclude` regexes only | **every fetched page is indexable** — empties, JS shells, login/legal pages, duplicates all get `excluded: false` | **B** page triage (title + URL + first 200 words) |
| fetch | `src/tap/fetch.ts` | politeness, HTML only | — | — |
| extract | `src/tap/extract.ts` (Defuddle) | main-content isolation + markdown | (1) **H1 removed** on 100 % of pages (it goes to `title`, not the text); (2) inline `<svg>` kept — overreacted.io: 6.9 MB of 7.1 MB; (3) wrong container on some pages (basecamp `/2`, `/classes`, `/help` → the same "And there's more…" link list; "Heads up! This page uses features your browser doesn't support" as the page); (4) five docs.pinecall.io pages start mid-sentence (intro paragraph lost); (5) blockquotes rendered inside code fences (basecamp testimonials) | **C** cleanup of what is kept |
| frontmatter + push | `src/tap/tap.ts` | `url/title/hash/fetchedAt` + markdown, one doc per path; **the manifest is pushed as a document too** | `_tap-manifest.json` is a retrieval candidate: top-5 hit on 4 of 40 questions (joel ×2, basecamp ×1 raw, ×1 A) — already noted in `tap-e2e-2026-08.md` | **D** enrichment (title, questions, keywords) · **E** overview doc |
| reindex | server (megabrain) | heading-aligned chunks, dense + BM25 | nothing to blame here: raw top-5 answered 39/40 | server-side D/E at reindex (phase 3) |
| syncTap | `src/tap/tap.ts` | skip unchanged hashes, delete gone paths | any LLM artefact must be **cached by content hash** or a sync re-spends on every page | — |

---

## 2 · Baseline — the measured problem

Sites (`scripts/research/01-crawl.mjs <name> <url> 60`, real `planTap` with
`keepContent`, concurrency 4), chosen for shape:

| site | shape | discovery | pages | HTML KB | md KB | tokens | tap time |
|---|---|---|---|---|---|---|---|
| basecamp.com | marketing / business site | sitemap | 60 | 2 747 | 550 | 139 326 | 3.9 s |
| joelonsoftware.com | blog (WordPress) | sitemap | 60 | 2 791 | 52 | 13 130 | 17.9 s |
| docs.pinecall.io | docs | links (no sitemap) | 17 | 2 370 | 154 | 38 940 | 6.0 s |
| caveman.so | SaaS + news + labs | sitemap | 37 | 3 659 | 161 | 41 064 | 4.2 s |
| overreacted.io (anecdote) | blog, Next.js | links | 12 | 17 672 | **7 097** | 1 815 782 | 6.1 s |

Noise, per site (`02-baseline.mjs`; boilerplate = a normalised line ≥ 12 chars
present on ≥ max(3, 20 %) of pages; near-dup = Jaccard ≥ 0.7 on word 4-grams
after boilerplate strip; labels = `fixtures/labels.json`, every page read by
hand: `keep` / `low` / `drop:<reason>`):

| site | boilerplate lines · tokens share | residual HTML | thin (<120 w) | empty after strip | near-dup pages | URL-shape junk | **junk pages (manual)** | junk tokens | low-value pages |
|---|---|---|---|---|---|---|---|---|---|
| basecamp | 1 · 0.7 % | 0 | 8 | 3 | 3 | 1 | **7 / 60 = 11.7 %** (dup ×3, empty ×2, banner ×2) | 1 727 = 1.2 % | 8 |
| joel | 0 at 20 % — the author bio repeats on 8 pages (13 %): 824 tokens = 6.3 % at a 10 % threshold | 0 | 37 | 0 | 0 | 0 | **0 / 60** | 0 | 9 (link-stub posts) |
| pcdocs | 11 · 2.6 % — all of it **code** repeated across pages (false positive) | 0.1 KB | 0 | 0 | 0 | 0 | **0 / 17** | 0 | 0 |
| caveman | 11 · 2.8 % (the product grid on every page) | 0 | 6 | 3 | 0 | 4 | **8 / 37 = 21.6 %** (legal ×4, auth ×2, JS shell ×2) | 3 641 = 8.9 % | 2 |
| overreacted | — | **6 879 KB in 7/12 pages = 97 % of the markdown** (inline `<svg>`) | 0 | — | — | — | not labelled | — | — |

Extraction defects counted over the corpora (`noH1` = no `# ` heading in the
markdown; `startsLowercase` = first character lower-case, i.e. the page opens
mid-sentence):

| site | pages | no H1 | starts mid-sentence | empty title | date-as-title | quote inside code fence |
|---|---|---|---|---|---|---|
| basecamp | 58 | 58 | 0 | 0 | 0 | 4 |
| joel | 60 | 60 | 0 | 0 | **59** | 0 |
| pcdocs | 17 | 16 | **5** | 1 | 0 | 3 |
| caveman | 37 | 37 | 0 | 0 | 0 | 0 |

**Reading.** The premise "nav/footer/cookie text pollutes every page" does not
hold for Defuddle output on these sites — under 3 % of tokens, and on the docs
site the only repeats are code. What pollutes is coarser and different:
whole junk pages (up to a fifth of a SaaS site), the manifest, titles that are
dates, pages whose first paragraph or H1 is gone, and the occasional page
whose extracted "content" is a link list or a browser banner.

### The retrieval symptom (`04-retrieval.mjs <site> raw`)

Ten realistic questions per site (`fixtures/questions.json`, each with a regex
the answering chunk must match; two per site are "list everything"
questions). Each variant is pushed into its own dev KB, reindexed, queried
with `k = 5`, KB deleted. A hit is *junk* when its doc is labelled `drop:*`,
is the manifest, or carries < 15 words once the frontmatter is removed.

| site | answered@5 | answered@1 | MRR | junk hits / 50 | what the junk was |
|---|---|---|---|---|---|
| basecamp | 10/10 | 10 | 1.000 | 4 | `classes.md` (dup), manifest, `support.md` (empty — the *only* hit for "contact support"), `managers.md` (banner) |
| joel | 10/10 | 8 | 0.883 | 2 | manifest ×2 |
| pcdocs | 9/10 | 9 | 0.900 | 0 | — ("Node.js ≥ 18" is only in the quickstart, never ranked) |
| caveman | 10/10 | 9 | 0.950 | 4 | `data-use.md` (legal — but it *answers* "what do you collect"), `signup.md` (auth — it answers "how do I sign up"), `privacy__cloud.md`, `activate.md` (shell) |
| **total** | **39/40** | 36 | 0.933 | **10/200 = 5 %** | 4 manifest, 2 legal, 2 auth/shell, 1 dup, 1 banner |

Push cost (no LLM): 0.3–0.7 s per document against the playground, ~3.5 s for
the index to answer after `reindex`.

---

## 3 · Options — what each one did on the same sites

### A · Deterministic pass (no LLM) — `03-option-a.mjs`

Rules: URL-shape junk → drop · residual HTML stripped · cross-page boilerplate
(line **and** paragraph, ≥ max(3, 10 %) pages, code fences excluded) stripped ·
< 20 words after strip → drop:empty · `needsJs` and < 50 words → drop:shell ·
link farm (< 30 words outside links, > 5 links) → drop · near-dup (Jaccard
≥ 0.7) → keep the shallowest · empty title → first heading or slug.

| site | kept / pages | tokens before → after | boilerplate stripped | junk: TP · FP · FN | precision | recall |
|---|---|---|---|---|---|---|
| basecamp | 52 / 60 | 139 326 → 131 908 (−5.3 %) | 1 line + 1 paragraph ("Heads up…" banner, 19 pages), 1 026 tok | 5 · 3 · 2 | 0.63 | 0.71 |
| joel | 58 / 60 | 13 130 → 12 230 (−6.9 %) | the bio paragraph, 824 tok | 0 · 2 · 0 | — | — |
| pcdocs | 17 / 17 | 38 940 → 38 923 | 0 (code excluded) | 0 · 0 · 0 | — | — |
| caveman | 29 / 37 | 41 064 → 35 788 (−12.8 %) | 32 lines + 10 paragraphs (product grid), 2 424 tok | 7 · 1 · 1 | 0.88 | 0.88 |

The FPs are judgement calls (newsletter page, two link-list pages, two joel
posts that are 18 words + the bio); the FNs are `2.md` (the *original* of the
duplicate trio is itself a link list), `managers.md` (banner + 60 words) and
`data-use.md` (legal page with a non-legal URL).

Retrieval after A:

| site | answered@5 | @1 | MRR | junk / 50 | change vs raw |
|---|---|---|---|---|---|
| basecamp | 10/10 | 9 | 0.933 | 2 (manifest, `managers.md`) | junk 4 → 2 |
| joel | **9/10** | 8 | 0.850 | 2 (manifest ×2) | **lost** "What companies did Joel found?" — the answer was in the bio paragraph A stripped as boilerplate |
| pcdocs | 9/10 | 9 | 0.900 | 0 | = |
| caveman | **9/10** | 8 | 0.850 | 1 (`data-use.md`) | **lost** "How do I sign up?" — the answer was on `signup.md`, dropped as an auth page |
| total | 37/40 | 34 | 0.883 | **5/200 = 2.5 %** (3 of them the manifest) | junk halved, two answers lost |

Two lessons, both measured: **repeated blocks carry facts** (keep one copy
somewhere retrievable), and **"junk" pages sometimes hold the only answer**
(drop the auth *form*, keep the sentence that says "invite-only, join the
waitlist").

**A+H** (A plus a deterministic `# {title}` put back as H1, since Defuddle
strips it): pcdocs 0.900 (=), caveman 0.900 (+0.05), **basecamp 0.833 (−0.10),
joel 0.750 (−0.10)**. With titles that are dates or generic marketing lines
the inserted heading is noise in the first chunk. Do not insert the H1
mechanically; a rewritten title (option D) is the version that can help.

### B · LLM page triage — `05-option-b.mjs` (haiku, 8 pages/call, title + URL + word count + first 200 words)

| site (model) | drop / low | junk TP · FP · FN | precision | recall | "low" pages caught | $/page | ms/page | $ total |
|---|---|---|---|---|---|---|---|---|
| basecamp (haiku) | 4 / 13 | 3 · 1 · 4 | 0.75 | 0.43 | 5/8 | 0.00066 | 548 | 0.040 |
| joel (haiku) | 1 / 20 | 0 · 1 · 0 | — | — | 6/9 | 0.00058 | 489 | 0.035 |
| pcdocs (haiku) | 0 / 0 | 0 · 0 · 0 | — | — | — | 0.00078 | 828 | 0.013 |
| caveman (haiku) | 7 / 2 | 7 · 0 · 1 | 1.00 | 0.88 | 1/2 | 0.00067 | 555 | 0.025 |
| **all (haiku)** | 12 / 35 | 10 · 2 · 5 | **0.83** | **0.67** | 12/19 | **0.0007** | ~550 (4 s/call) | **0.112** |
| basecamp (sonnet) | 4 / 7 | 3 · 1 · 4 | 0.75 | 0.43 | 4/8 | 0.00175 | 916 | 0.105 |
| caveman (sonnet) | not measured — gateway died mid-run (§5); the follow-up card ran the cheap model instead of sonnet (below), since sonnet is no longer the question | | | | | | | |
| basecamp (cheap) | 5 / 5 | 3 · 2 · 4 | 0.60 | 0.43 | 3/8 | 0.00002 | 719 | 0.0013 |
| joel (cheap) | 0 / 1 | 0 · 0 · 0 | — | — | 1/9 | 0.00002 | 598 | 0.0012 |
| pcdocs (cheap) | 0 / 0 | 0 · 0 · 0 | — | — | — | 0.00003 | 1 417 | 0.0005 |
| caveman (cheap) | 6 / 1 | 6 · 0 · 2 | 1.00 | 0.75 | 0/2 | 0.00002 | 690 | 0.0008 |
| **all (cheap)** | 11 / 7 | 9 · 2 · 6 | **0.82** | **0.60** | 4/19 | **0.00002** | ~740 | **0.0038** |

`cheap` = `openrouter/qwen/qwen3-30b-a3b-instruct-2507`, 2026-08-22, same prompt,
same batches, zero parse failures over 24 calls. **Haiku vs cheap:** same
precision (0.83 vs 0.82), a little less recall (0.67 vs 0.60 — it keeps
`managers.md` and `privacy.md`, drops `shapeup__0.1-foreword.md` as "browser
warning only"), and it almost never says `low` (4/19 vs 12/19) — the soft
signal is gone. Latency 740 vs 550 ms/page; cost 30× lower ($0.004 vs $0.112
for the four sites).

What it catches and misses: every empty/auth/banner/legal-by-URL page (same
set as A); it **misses duplicates** (no cross-page view — A has it), it
**keeps `data-use.md`** as "data collection policy by plan, privacy details",
score 0.75 — which, given the questions users ask, is the better call than
my label. It marks a lot of *real* content "low" (joel's short posts, the
retired-product notices): a soft signal, useful to show in the plan table,
wrong to act on by dropping. Sonnet gave the same precision/recall for 2.7×
the price. Zero JSON parse failures over 24 haiku calls.

### C · LLM cleanup of kept pages — `06-option-c.mjs` (haiku)

Run on pcdocs with haiku (6 pages completed before the outage; pages > 6 000 tokens skipped):

| mode | pages | tokens in → out | cut | sentences checked | not near-copies (violations) | $/page | s/page |
|---|---|---|---|---|---|---|---|
| clean ("remove noise, keep every sentence verbatim") | 6 | 8 888 → 8 240 | 7.3 % | 50 | **0** | 0.0101 | 15.1 |
| summarize ("compact knowledge doc") | 4 | 5 558 → 4 945 | 11.0 % | 62 | **47 = 76 %** (by construction: paraphrase) | 0.0085 | 12.6 |

The fidelity check (every output sentence ≥ 5 words must be a substring of
the input after normalisation or share ≥ 60 % of its word 4-grams with the
input) passed cleanly for "clean" and, as intended, flags nearly every
sentence of a summary as unverifiable. No invented fact was found in the four
summaries read by hand — the flagged sentences are paraphrases ("Node.js
version 18 or higher is required" for the page's "Node.js ≥ 18", containment
0 because every word changed) — which is exactly the problem: a paraphrase
and a hallucination look the same to an automatic check, so a summary cannot
be guarded. For a KB that feeds a voice agent the answer is **clean, never
summarise**: the retriever needs the words the page used, and only a
near-copy can be verified sentence by sentence.

Cost is dominated by output tokens (a clean page is re-emitted whole): 3–10×
B or D per page, and 8–28 s per page. On a docs site that had almost nothing
to clean it removed 7 % of tokens — not worth it as a default. (The haiku
pcdocs A+C retrieval KB was built from a variant with 11/17 empty docs — the
gateway's silent failure, §5 — and its numbers are discarded.)

**Clean with the cheap model, all four sites** (`06-option-c.mjs … --mode=clean --model=cheap`,
2026-08-22, same prompt and cap; variant `A+C.cheap`, then `04-retrieval.mjs <site> A+C.cheap`):

| site | pages (skipped) | tokens in → out | cut | sentences checked | violations (pages) | $/page | s/page | retrieval A+C.cheap ans · MRR · junk — vs A |
|---|---|---|---|---|---|---|---|---|
| basecamp | 50 (2 over cap) | 77 432 → 76 414 | 1.3 % | 2 594 | 29 (3) | 0.00033 | 21.6 | 10 · 0.933 · 2 — = |
| joel | 58 | 12 230 → 12 016 | 1.7 % | 362 | 2 (2) | 0.00006 | 5.2 | 9 · 0.850 · 2 — = (the bio question stays lost) |
| pcdocs | 16 (1) | 32 298 → 30 480 | 5.6 % | 107 | 1 (1) | 0.0005 | 22.4 | 9 · **0.825** · 0 — "How do I install the SDK?" 1 → 4 |
| caveman | 29 | 35 788 → 35 760 | 0.1 % | 1 025 | 18 (7) | 0.00028 | 14.1 | 9 · 0.900 · 1 — "what data do you collect" 2 → 1; 10 → 9 answered (the A+C KB no longer returns `signup.md`, same as A's loss) |

**Haiku vs cheap on C** (pcdocs is the only overlap: haiku 6 pages, 7.3 % cut,
0/50 violations, $0.0101, 15 s/page; cheap 16 pages, 5.6 % cut, 1/107,
$0.0005, 22 s/page): 20× cheaper, slower, and **less faithful in a way the
check does not see**. Read by hand, the 29 basecamp "violations" are
re-flowed testimonial blockquotes (formatting, 27) plus two real edits; but on
`pricing.md` (25.8 % cut, 1 flagged sentence of 42) the model **deleted the
tooltip explanations** ("Archived or deleted projects don't count against
your total", five "coming soon" qualifiers) — fact-bearing text gone with no
violation, because the containment check only looks at what the output
*adds*, never at what it *drops*. On joel it stripped links and corrected
"it's" → "its". Retrieval did not improve anywhere and lost a rank on pcdocs.
The guard for a C lane therefore needs the reverse check too (input sentences
missing from the output → reject), and even then C stays the lane with no
measured upside on these sites.

### D · LLM enrichment for retrieval — `07-option-d.mjs` (haiku, JSON: title, breadcrumb, one-line summary, 3–5 questions, 5–12 keywords → header under the frontmatter; body untouched)

| site | pages enriched | header tokens/page | titles rewritten | $/page | s/page | retrieval |
|---|---|---|---|---|---|---|
| pcdocs | 17/17 | 173 | 9/17 | 0.0040 | 3.1 | 9/10 · MRR 0.900 — **unchanged** (no headroom: raw was already 0.900) |
| caveman | 10/29 (partial — outage) | 170 | 8/10 | 0.0025 | 2.7 | **10/10 · MRR 0.950** vs A 9/10 · 0.850: "How do I sign up?" came back at rank 2 through the enriched `enterprise.md`/`pricing.md` headers, "What do you collect?" moved rank 2 → 1 |
| basecamp, joel (haiku) | not measured (outage) — measured with the cheap model below | | | | | |
| basecamp (cheap) | 52/52 | 174 | 48/52 | 0.00011 | 3.6 | 10/10 · MRR **0.803** · junk 2 vs A 10/10 · 0.933 · 2: pricing 1 → 2, "contact support" 3 → 5, "which books" 1 → 3 — the rewritten title + header of `handbook.md`/`accessibility.md` outrank the page that holds the answer |
| joel (cheap) | 58/58 | 182 | 58/58 | 0.00006 | 3.6 | **10/10 · MRR 0.883 · junk 0** vs A 9/10 · 0.850 · 2: "What companies did Joel found?" back at rank 3 (the header of `1999/12/24` asks "Where did Joel work before his sabbatical?"), the manifest out of the top-5 on both questions, "compensated" 2 → 1 |
| pcdocs (cheap) | 17/17 | 178 | 17/17 | 0.00015 | 3.8 | 9/10 · 0.900 · 0 — same as haiku |
| caveman (cheap) | 29/29 | 188 | 29/29 | 0.0001 | 4.2 | 10/10 · 0.950 · 1 — same as haiku's partial run, now on all 29 pages |

Sample output (caveman `index.md`): title "the token-efficient stack for
agent-native development" → "Caveman: Token-Efficient Stack for Agent-Native
Development"; questions "How much can Caveman reduce my agent's token usage?",
"What are the five layers of the Caveman stack?". This is the option that
moved a retrieval number, on a *partial* variant, at $0.004/page — and it is
exactly the mechanism the knowledge-base skill's troubleshooting table
describes (an overview that *describes* rather than lists, BM25 seeing the
words users say). Joel's 59 date-titles were the obvious next test, and with
the cheap model they passed: every date became a descriptive title
("1999/12/24" → "Joel Spolsky's Sabbatical and Future Writing Plans") and the
lost answer came back.

**Haiku vs cheap on D** (pcdocs, caveman overlap): identical retrieval (0.900 /
0.950, same junk), 25–40× cheaper ($0.0001 vs $0.004 per page), ~1 s/page
slower (3.6–4.2 vs 2.7–3.1). The one behavioural difference: haiku rewrote
9/17 titles on pcdocs, the cheap model rewrites **every** title (156/156),
and on basecamp — marketing pages whose titles were already good — that cost
0.13 MRR. The lane must keep the original title as the doc title and put the
rewritten one in the header, or rewrite only when the title is a date, empty
or generic.

### E · Site-level overview — `08-option-e.mjs`

Measured 2026-08-22 with the cheap model on top of `A+D.cheap` (kept pages,
shallowest six whole, the rest as 250-word excerpts, ≤ 40 k input tokens →
`_overview.md`; `08-option-e.mjs … --base=A+D.cheap --model=cheap`):

| site | pages used | tokens in → out | s | $ | retrieval A+D.cheap+E.cheap vs A+D.cheap | `_overview.md` in the top-5 |
|---|---|---|---|---|---|---|
| basecamp | 52 | 23 419 → 3 000 (**hit `max_tokens`**, site map cut) | 85 | 0.0017 | 10/10 · MRR 0.817 (+0.014: "contact support" 5 → 3) · junk 2 | 4 questions, ranks 4–5 |
| joel | 58 | 21 623 → 1 617 | 19 | 0.0013 | 10/10 · 0.883 · 0 (=) | 5 questions, ranks 2–4 |
| pcdocs | 17 | 15 291 → 761 | 18 | 0.0009 | 9/10 · 0.900 · 0 (=) | 4 questions, ranks 4–5 |
| caveman | 29 | 17 555 → 885 | 12 | 0.0010 | 10/10 · 0.950 · 1 (=) | 2 questions, rank 3 |

The overviews are good documents (read by hand: correct product lists, plans,
get-started steps; nothing invented was found) and they do carry answers —
the overview chunk *matches* the expected answer on 2–5 questions per site —
but always **behind** the page that already had it, so no question moved
from unanswered to answered and MRR moved on one site by 0.014. As predicted:
the "list everything" questions were already answered by the pages, so E's
upside needs a site whose list is spread over many pages (a restaurant menu
across category pages, a clinic's services); the four sites are not that.
$0.001–0.002 per site, 12–85 s, one call; with the cheap model a
3 000-token cap truncates a 50-page site (use 4–5 k).

### All variants side by side

| variant | basecamp ans/MRR/junk | joel | pcdocs | caveman | notes |
|---|---|---|---|---|---|
| raw (today) | 10 · 1.000 · 4 | 10 · 0.883 · 2 | 9 · 0.900 · 0 | 10 · 0.950 · 4 | 39/40, 5 % junk |
| A | 10 · 0.933 · 2 | 9 · 0.850 · 2 | 9 · 0.900 · 0 | 9 · 0.850 · 1 | 37/40, 2.5 % junk, 2 answers lost |
| A+H | 9 · 0.833 · 2 | 9 · 0.750 · 2 | 9 · 0.900 · 0 | 9 · 0.900 · 1 | mechanical H1 hurts |
| A+D (haiku) | — | — | 9 · 0.900 · 0 | 10 · 0.950 · 1 (10/29 enriched) | recovers what A lost |
| A+D (cheap) | 10 · **0.803** · 2 | **10** · 0.883 · **0** | 9 · 0.900 · 0 | 10 · 0.950 · 1 | 39/40, 1.5 % junk; recovers joel, costs basecamp ranks |
| A+C (haiku) | — | — | invalid (empty docs) | — | — |
| A+C (cheap) | 10 · 0.933 · 2 | 9 · 0.850 · 2 | 9 · 0.825 · 0 | 9 · 0.900 · 1 | 37/40, = A except one rank lost on pcdocs, one gained on caveman |
| A+D+E (cheap) | 10 · 0.817 · 2 | 10 · 0.883 · 0 | 9 · 0.900 · 0 | 10 · 0.950 · 1 | = A+D.cheap + 0.014 on one site |

---

## 4 · Where it runs, and idempotence with `syncTap`

| | CLI, during `tap`/`syncTap` | server, at push/reindex |
|---|---|---|
| works today | yes — same `PINECALL_API_KEY`, gateway gated to paid plans (402 otherwise) | no — needs playground/voice-server cards |
| who pays latency | the user's terminal (B: ~1 min / 100 pages at 8-page batches; D: ~5 min sequential, ~80 s at concurrency 4; C: 25 min / 6 min) | nobody visible; reindex is already async |
| who pays money | Pinecall's gateway bill (OpenRouter for the `cheap` default, Anthropic for `haiku`/`sonnet`) — needs per-org metering (usage record per call) before it is a default | same bill, centralised budget, easier to meter |
| cross-page context | yes — the CLI holds the whole plan (boilerplate, dups, overview) | only at reindex over the whole KB; not at push |
| idempotence | **cache every LLM artefact by content hash in the manifest**: `pages[path].llm = { hash, model, verdict, reason, score, title, questions[], keywords[] }` — `syncTap` reuses it when the page hash is unchanged, so an unchanged page costs zero LLM calls and the doc text is byte-identical across syncs (no spurious re-push). The overview is regenerated only when ≥ 1 page hash moved, and stored with the list of hashes it was built from. `temperature: 0`. | the server would hold the same cache keyed by doc hash |
| failure mode | must degrade to no-LLM with a warning — today (2026-08-21) the gateway answered 200 + `done {0,0}` with no text for an hour (§5); a tap must not write empty docs or stall | same |

Manifest change: `version` stays 1, the `llm` sub-object is optional on read
(same rule as `options`); a manifest without it simply re-runs the lanes that
are enabled.

---

## 5 · Cost, and what this research spent

**Measured list prices per 100 pages of ~1 300 tokens (the 4-site mean,
232 k tokens / 174 pages).** `haiku` = claude-haiku-4-5 ($1 / $5 per M in/out);
`cheap` = openrouter/qwen/qwen3-30b-a3b-instruct-2507 ($0.048 / $0.193), the
gateway default since 2026-08-21:

| lane | $/100 pages haiku | $/100 pages **cheap** | wall time cheap (sequential · concurrency 4) | measured on (haiku · cheap) |
|---|---|---|---|---|
| A deterministic | 0 | 0 | < 1 s | 174 pages |
| B triage (batch 8) | 0.07 | **0.002** | 74 s · 19 s | 174 · 174 pages |
| D enrichment | 0.40 | **0.010** | 6.3 min · 95 s | 27 · 156 pages |
| C clean (≤ 6 k-token pages) | 1.0 | **0.024** | 23 min · 6 min | 6 · 153 pages |
| E overview (per site, one call) | ~0.06 (guess) | **0.001–0.002** | 12–85 s | 0 · 4 sites |
| **default LLM pass B + D** | ≈ 0.5 | **≈ 0.012** | ≈ 2 min at concurrency 4 | |
| everything (B + C + D + E) | ≈ 1.5 | ≈ 0.04 | ≈ 8 min | |

The cheap model makes money a non-argument: a 100-page tap with every lane on
costs four cents; B + D cost about a cent. What is left is latency (the
cheap model is 1.3–1.5× slower per page than haiku; C is 14–22 s per page
either way) and quality (same P/R on B, same retrieval on D with the
over-rewriting caveat, C less faithful). Sonnet multiplies B by 2.7 with no
accuracy gain measured; there is no reason left to route a tap lane to it.

**Spent by tk-818bd3 on the gateway:** $0.41 (ledger `.research-data/llm-ledger.jsonl`:
B haiku $0.112, B sonnet $0.113, D $0.093, C clean $0.061, C summarize $0.034);
16 dev KBs created and deleted.
**Spent by tk-903a6d (the cheap re-run, 337 calls):** **$0.060** — B $0.004,
D $0.015, C clean $0.036, E $0.005; 12 dev KBs created and deleted, none left.

**The outage.** At ~20:41 UTC every gateway call started returning
`data: {"type":"done","usage":{"input_tokens":0,"output_tokens":0}}` and no
token — the voice box log says `Anthropic API error: 400 … Your credit balance
is too low`. Two consequences for the plan: (1) the gateway swallows upstream
errors instead of emitting `type: "error"` — a one-line sdk-server fix, and
without it a client cannot tell "empty answer" from "outage"; (2) an LLM lane
in `tap` has to treat "no tokens" as failure, retry with backoff, and fall
back to the un-enriched doc. Both are in the card plan.

---

## 6 · Recommendation

1. **Ship the deterministic pass (A) — but with two corrections the measurements forced.** Drop empties, JS shells, near-duplicates, link farms and URL-shape junk; strip residual HTML and cross-page boilerplate **outside code fences**; and **keep one copy of every stripped boilerplate block** in a `_site.md` document (bio, address, hours, footer facts) so the joel case cannot recur. Fix empty titles, do **not** insert the H1 mechanically. This removes half the junk hits for free.
2. **Get the manifest out of the index** — it was 4 of the 10 junk hits. Needs a server flag (`index: false` on a doc) or a server-side rule for `_tap-manifest.json`; until then the CLI cannot do it.
3. **LLM triage (B) + enrichment (D) as one opt-in lane** (`--llm`), haiku, cached by content hash in the manifest: B's verdict and reason go into the plan table the human approves (drop only `empty/auth/banner/duplicate` at score ≤ 0.1; `legal`/`low` are *shown*, not dropped — they answered two of our questions); D's header (rewritten title, one-line summary, questions, keywords) goes under the frontmatter. ≈ $0.5 / 100 pages, ≈ 2 min. Make it default only after the two-customer-KB measurement in phase 2.
4. **Cleanup (C) guarded and opt-in** (`--llm=clean`): only pages A still flags as noisy, ≤ 4 k tokens, output accepted only if the sentence-containment check passes, otherwise the original stays. **No summarisation lane, ever** — 76 % of its sentences are unverifiable by construction, so a hallucination could not be told from a paraphrase.
5. **Overview (E) opt-in** (`--overview`), regenerated on delta, frontmatter-marked as generated, measured on a real business site before it is suggested by default.
6. **Phase 3, server side**: move D/E to reindex time on the voice server (centralised cost, per-org metering, invisible latency), keep A in the client (it needs the crawl).

**Revised 2026-08-22, after the cheap-model re-run.** The recommendation
stands; three things change. (a) The LLM lane's default model is the
gateway default (`cheap`), not haiku: B keeps its precision, D keeps its
retrieval, and B + D cost ≈ $0.01 / 100 pages — cost is no longer the reason
to keep the lane opt-in, the two-customer measurement (phase 2) is. (b) D
must **not replace the doc title** by default — the cheap model rewrites every
title and that cost basecamp 0.13 MRR; the rewritten title lives in the
header, and replaces the title only when the original is a date, empty or a
bare site name (joel is the case it fixes). (c) C's guard needs a
**deletion check** (input sentences ≥ 5 words missing from the output →
reject the page) on top of the containment check; the cheap model dropped
fact-bearing tooltip text on `pricing.md` without tripping the existing one,
and C moved no retrieval number up on any site. E is confirmed cheap and
harmless (+0.014 on one site, nothing lost) and stays opt-in until a site
with a spread-out list shows it moving a number.

Risks and mitigations: hallucination (C/E) → containment check + deletion
check, generated-doc marker, no summaries; cost run-away → per-tap budget
(`--llm-budget`), cache by hash, the cheap default model only by default; non-determinism → `temperature 0` + cache, so a
sync never re-pushes an unchanged page; gateway outage → detect "no tokens",
retry ×3, degrade with a warning, never write an empty doc (we did, once);
privacy → customer site text leaves the client for OpenRouter (cheap) or
Anthropic (haiku/sonnet) via the gateway — say so in `docs/guides/tap.md`,
keep it opt-in.

---

## 7 · Phased card plan

Each card is a worker's brief: files, behaviour, acceptance. Phase 0 needs no
LLM and no server; phase 1 is the LLM lane in the CLI; phase 2 is measurement;
phase 3 is server-side.

### Phase 0 — deterministic, ship now

**0.1 extract: strip residual HTML and cap doc size.** `src/tap/extract.ts`:
after Defuddle, remove `<svg>…</svg>`, `<iframe>…</iframe>`, stray
`<div|span|img|picture|source|video|style|script|figure|br|hr>` tags; report
`residualBytes` on `ExtractedPage`; cap a doc at 200 KB of markdown with a
`truncated: true` flag. Test with the overreacted.io fixture
(`fixtures/` gets one saved HTML). Acceptance: overreacted `/a-social-filesystem`
drops from 4.18 MB to < 20 KB; unit test on a page with inline SVG.

**0.2 plan: page-level skip rules.** `src/tap/plan.ts` (+ new `src/tap/noise.ts`
holding the detectors, ported from `scripts/research/lib.mjs` and
`03-option-a.mjs`): `TapPage.skip?: { reason: "empty" | "shell" | "duplicate" | "linkfarm" | "url"; of?: string }`;
`TapPlanTotals.skipped`; `tap()`/`syncTap()` never push a skipped page;
defaults: empty < 20 words, `needsJs` < 50 words, Jaccard ≥ 0.7 keeps the
shallowest path, link farm < 30 words outside links with > 5 links, the
`JUNK_URL` list (tag/category/author/page/N/login/cart/legal/search/feed/
newsletter) — `include` overrides it. CLI: the plan table shows `skip (dup of
/2)`; `--no-skip` disables. Docs: `docs/guides/tap.md` "what tap skips and why".
Acceptance: basecamp 60 → 52, caveman 37 → 29 with the reasons in the table;
tests for each rule.

**0.3 boilerplate: strip repeats, keep one copy.** `src/tap/noise.ts`: lines
and paragraphs repeated on ≥ max(3, 10 %) of pages, code fences excluded,
removed from every page; the unique blocks written once to `_site.md`
("Text repeated across <site>") pushed like any doc and recorded in the
manifest. Acceptance: joel's bio is in `_site.md` and "What companies did Joel
found?" is answered at k=5 (re-run `04-retrieval.mjs joel A`); pcdocs code
untouched (0 tokens stripped).

**0.4 titles.** `src/tap/plan.ts`: empty title → first heading → slug; never
insert an H1. Acceptance: pcdocs `guides__realtime-speech.md` gets a title.

**0.5 manifest out of the index (server).** Playground card: `KnowledgeDocInput.index?: boolean`
(default true), stored on the doc, honoured by the reindex payload to the
voice server; `tap.ts` passes `index: false` for `_tap-manifest.json`.
Acceptance: the manifest never appears in `knowledge query` hits on the
e2e KB.

**0.6 gateway: surface upstream errors.** sdk-server card (`llm_gateway.py`):
an upstream non-2xx emits `{"type":"error","error":…,"code":"UPSTREAM_ERROR"}`
before `[DONE]`; never a bare `done` with zero tokens. Acceptance: with a bad
key the stream carries the error frame (curl test in the card).

### Phase 1 — the LLM lane in the CLI (opt-in)

**1.1 `src/tap/llm.ts`: gateway client + cache.** SSE client (retry ×3 with
backoff on "no tokens"/429/5xx, `temperature: 0`, `max_tokens` per lane, cost
accounting from `usage`), `LlmLaneOptions { lanes: ("triage"|"enrich"|"clean")[], model?: "cheap"|"haiku"|"sonnet" (default "cheap" — the gateway default; send no model), concurrency?: 4, budgetUsd?: number }`;
manifest entry `pages[path].llm` (hash-keyed artefacts, see §4); `TapPhase`
gains `"llm"`, events carry `message: "triage 12/60 · $0.01"`; `TapReport`
gains `llm: { calls, usd, cached, failed }`. Tests with a fake gateway.
Acceptance: a second `syncTap` over an unchanged site makes zero gateway calls.

**1.2 triage (B).** Batches of 8, the `05-option-b.mjs` prompt; verdict +
reason + score on `TapPage.llm`; the CLI plan table shows `drop · empty`,
`low · index of links`; applied only with `--llm=triage`; drop iff
`kind ∈ {empty, auth, banner, duplicate}` and `score ≤ 0.1`; everything else
kept, `low` tagged into the frontmatter (`quality: low`). Acceptance: on the
research corpora precision ≥ 0.8 against `fixtures/labels.json`; cost per 100
pages ≤ $0.10 in the report line.

**1.3 enrich (D).** `07-option-d.mjs` prompt and header format; applied with
`--llm=enrich`; title also replaces `frontmatter.title` and the KB doc title;
pages > 12 k chars are excerpted for the prompt; **the doc title is replaced
only when the original is a date, empty or a bare site name** (§3 D: the
cheap model rewrites every title and cost basecamp 0.13 MRR), otherwise the
rewritten title stays in the header. Acceptance: cached header is
byte-identical across syncs; basecamp `A+D` MRR ≥ A's 0.933 with the rule on;
`docs/guides/tap.md` documents the header and the privacy note.

**1.4 overview (E).** `--overview` (cheap default, `--overview-model=haiku|sonnet`, `max_tokens` ≥ 4 k — 3 k truncated a 50-page site);
`_overview.md` with frontmatter `generated: true, fromHashes: [...]`;
regenerated only on delta; never on a plan under 3 kept pages. Acceptance:
e2e on a business site with services spread across pages; the "list
everything" question answered at k=5 where raw fails (pick the site in the
card, measure with `04-retrieval.mjs`).

**1.5 CLI + docs.** `src/cli/commands/knowledge.ts`: `--llm=off|triage|enrich|clean|all`
(comma-separated), `--overview`, `--llm-budget=<usd>`; cost and cached counts
in the summary line; `docs/guides/tap.md`, `docs/reference/cli.md`, `CHANGELOG.md`.

### Phase 2 — measure before default-on

**2.1 Two customer-shaped KBs.** Re-run `scripts/research/04-retrieval.mjs` raw vs
A vs A+D (+E) on two real business sites (restaurant/clinic-like: services,
hours, prices across pages) with 10 questions each written from the site;
decide default-on for `enrich` and suggest-on for `overview` from the numbers.
(The formerly unmeasured cells of §3 were filled by tk-903a6d with the cheap
model; no haiku re-run is planned.)

### Phase 3 — server side

**3.1 enrich/overview at reindex.** Voice server: an optional enrichment step
in the megabrain index hook keyed by doc hash, per-org metering into usage,
`index: false` honoured; CLI `--llm=enrich` becomes a no-op when the server
reports `serverEnrich: true`. **3.2 clean (C) guarded** (containment **and**
deletion check), server or client, only if phase 2 shows a site where it
moves a number.

---

## Appendix — reproducing

```
npm run build                                   # scripts import dist/tap.js
node scripts/research/01-crawl.mjs basecamp https://basecamp.com 60
node scripts/research/01-crawl.mjs joel https://www.joelonsoftware.com 60
node scripts/research/01-crawl.mjs pcdocs https://docs.pinecall.io 60
node scripts/research/01-crawl.mjs caveman https://caveman.so 60
node scripts/research/02-baseline.mjs basecamp joel pcdocs caveman   # §2 tables
node scripts/research/03-option-a.mjs basecamp joel pcdocs caveman   # A + the raw variant
node scripts/research/03b-option-a-heading.mjs …                     # A+H
node scripts/research/04-retrieval.mjs <site> <variant>               # dev KB, 10 questions, k=5, deletes the KB
node scripts/research/05-option-b.mjs … --model=cheap|haiku|sonnet    # B → variants/<site>/B-<model>
node scripts/research/06-option-c.mjs … --mode=clean|summarize --model=cheap   # C → A+C.cheap (haiku: A+C)
node scripts/research/07-option-d.mjs … --base=A --model=cheap        # D → A+D.cheap (haiku: A+D)
node scripts/research/08-option-e.mjs … --base=A+D.cheap --model=cheap  # E → A+D.cheap+E.cheap
```

`--model=cheap` is the gateway default (`openrouter/qwen/qwen3-30b-a3b-instruct-2507`
on 2026-08-22; `GET /api/llm/models` says what it resolves to today, and every
summary JSON records `modelId`). The scripts' `lib.mjs` prices `cheap` at
$0.048 / $0.193 per M tokens and treats the gateway's `{type:"error",code,status}`
frames as failures (retrying only rate limits).

Corpora, variants, retrieval results and the LLM cost ledger land in
`.research-data/` (gitignored); labels and questions are committed under
`scripts/research/fixtures/`. The gateway is paid — the ledger line is printed
by every LLM script.

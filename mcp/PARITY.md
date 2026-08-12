# Parity audit — playground / platform vs. the MCP tools

The bar: **everything a human can do in the playground or the platform dashboard
must be reachable from a coding agent through `@pinecall/mcp`.** This file is the
ledger. It is spot-checkable: every row names the file the route lives in.

Audited at `pinecall-mcp` milestone, against:

- **Playground API** — `~/pinecall/playground/src/modules/*/*.routes.ts`,
  mounted in `playground/src/app.ts` under `/api/…`. This is the whole HTTP
  surface of the product's control plane.
- **Platform** — `~/pinecall/platform` is a React-Router **UI**, not a second
  API. Its `app/routes.ts` is pages plus five JSON *resource* routes, and each
  one proxies the playground API (see §4). So platform parity is playground
  parity; the resource routes are listed for completeness.

## 0. How to read the coverage column

| marker | meaning |
|---|---|
| ✅ tool | a shipped MCP tool covers it |
| 🟡 partial | reachable, but not with the same power the UI has |
| **GAP** | not reachable from MCP at all — proposal in §3 |
| n/a | deliberately out of scope (see the reason on the row) |

Two categories are **n/a by design**, not gaps:

- **Dashboard-session routes** (`/api/auth/*`, `POST /api/orgs`) authenticate a
  human with a JWT: signup, email verification, Google OAuth, login. An MCP
  server holds a `pk_…` API key, which is *issued* by that flow — it cannot
  bootstrap it. A coding agent that has a key already has an account.
- **Machine-to-machine routes** (`/api/internal/*`, `POST /api/usage/log`,
  `POST /api/billing/webhook`, `/api/twilio/connect/callback|deauthorize`) are
  authenticated by a shared token, Stripe signature, or Twilio redirect — they
  are the sdk-server↔playground and Stripe↔playground seams, not user actions.
  Exposing them from MCP would be a privilege hole, not a feature.

Note on auth reach: `middleware/auth.ts` accepts **either** a `pk_…` API key or a
dashboard JWT on every `authMiddleware` route. So every row below marked GAP is
*mechanically* reachable with the key the MCP server already holds — the gap is
a missing tool, never a missing credential. The two exceptions are `/api/admin/*`
(super-admin gated, `admin.middleware.ts`) and the m2m routes above.

---

## 1. Playground API — route by route

### `/api/auth` — `modules/auth/auth.routes.ts`

| method + path | purpose | coverage |
|---|---|---|
| GET `/api/auth/pineward` | VDF anti-bot challenge for the signup/login widget | n/a — browser widget |
| POST `/api/auth/signup` | create org + owner user, email a 6-digit code | n/a — dashboard session |
| POST `/api/auth/verify-email` | confirm the code → mark verified, return JWT | n/a — dashboard session |
| POST `/api/auth/resend-verification` | re-send the code (always 200, no enumeration) | n/a — dashboard session |
| POST `/api/auth/google` | exchange a Google auth code → JWT or `{needOrg}` | n/a — dashboard session |
| POST `/api/auth/google/complete` | new Google user names their org → org + JWT | n/a — dashboard session |
| POST `/api/auth/login` | email + password → JWT | n/a — dashboard session |
| GET `/api/auth/me` | current **user** + org from a JWT | n/a — JWT only; org side is `whoami` |
| PATCH `/api/auth/me` | update the current user's profile name | n/a — JWT only |

### `/api/orgs` — `modules/orgs/org.routes.ts`

| method + path | purpose | coverage |
|---|---|---|
| POST `/api/orgs` | create an org (signup, no auth) | n/a — dashboard session |
| GET `/api/orgs/me` | the org: name, slug, plan, balance | ✅ `whoami` (and `set_api_key` validates against it) |
| GET `/api/orgs/me/stats` | org counters for the overview page | 🟡 — `whoami` returns plan + credits, not the counters |
| POST `/api/orgs/me/request-verification` | flag the org for manual (KYC) verification | **GAP** → `org_settings` |
| PATCH `/api/orgs/me` | rename the org / change the billing email | **GAP** → `org_settings` |

### `/api/plans`, `/api/rates`, `/api/pricing` — public catalogs

| method + path | purpose | coverage |
|---|---|---|
| GET `/api/plans` | all active plans with limits/providers/models | ✅ `subscribe` (lists plans before checkout) |
| GET `/api/plans/:name` | one plan by name | ✅ `subscribe` |
| GET `/api/rates` | the priced rate table (credits per unit) | 🟡 — `list_models` carries per-model price; the raw table is not exposed |
| GET `/api/rates/models` | public model catalog per service | ✅ `list_models` |
| GET `/api/pricing` | plans + rates + managed providers + per-minute assumptions, one call | 🟡 — split across `subscribe` / `list_models`; no cost calculator |

### `/api/models` — `modules/models/model.routes.ts`

| method + path | purpose | coverage |
|---|---|---|
| GET `/api/models/access` | "can this org use `service`/`model`?" — one decision, or all | ✅ `list_models` (surfaces allowed/managed/hasKey/reason) |

### `/api/keys` — `modules/keys/key.routes.ts`

| method + path | purpose | coverage |
|---|---|---|
| GET `/api/keys` | list this org's API keys, masked | **GAP** → `api_keys` |
| POST `/api/keys` | create a key (the plaintext is returned once) | **GAP** → `api_keys` |
| DELETE `/api/keys/:id` | revoke a key | **GAP** → `api_keys` |

> ⚠️ Milestone rule: *no API key ever appears in a tool result*. `api_keys`
> must therefore be **list + revoke** only, or `create` must write the new key
> to `~/.pinecall/credentials` (0600) and return only `{ id, masked, saved: true }`.

### `/api/credentials` — `modules/credentials/credential.routes.ts` (BYOK)

| method + path | purpose | coverage |
|---|---|---|
| GET `/api/credentials` | which provider keys the org has stored (masked) | ✅ `byok('list')` |
| PUT `/api/credentials` | upsert a provider key | ✅ `byok('set')` |
| DELETE `/api/credentials/:provider` | remove a provider key | ✅ `byok('remove')` |

### `/api/phones` — `modules/phones/phone.routes.ts`

| method + path | purpose | coverage |
|---|---|---|
| GET `/api/phones` | the org's numbers in inventory (`?twilioAccountId=`) | ✅ `list_phones` |
| GET `/api/phones/search` | search buyable numbers (`?country=&areaCode=`) | **GAP** → `phone_numbers('search')` |
| POST `/api/phones/provision` | **buy** a managed number — plan-gated, charges credits | **GAP** → `phone_numbers('provision')` |
| POST `/api/phones/import` | import numbers from a linked Twilio account | **GAP** → `phone_numbers('import')` |
| POST `/api/phones/refresh` | re-sync the number list from Twilio | **GAP** → `phone_numbers('refresh')` |
| PATCH `/api/phones/:id` | rename a number (`friendlyName`) | **GAP** → `phone_numbers('rename')` |
| DELETE `/api/phones/:id` | remove a number from the org | **GAP** → `phone_numbers('release')` |

> `list_phones` reads the *live* view (voice server `/api/sdk/phone-numbers`
> merged with the agent→phone map) plus `/api/playground/phones`. Everything
> that **changes** the inventory is unreachable.

### `/api/twilio` + `/api/twilio/connect` — `modules/twilio/*.routes.ts`

| method + path | purpose | coverage |
|---|---|---|
| GET `/api/twilio` | linked Twilio accounts (`?available=true` adds their phone list) | **GAP** → `telephony('list')` |
| POST `/api/twilio` | link a Twilio account (SID + auth token) | **GAP** → `telephony('link')` |
| DELETE `/api/twilio/:id` | unlink an account | **GAP** → `telephony('unlink')` |
| POST `/api/twilio/:id/sip-domain` | create a SIP domain on a linked account | **GAP** → `telephony('sip_domain')` |
| POST `/api/twilio/sip-credentials/regenerate` | rotate a SIP domain's registration creds | **GAP** → `telephony('sip_rotate')` |
| POST `/api/twilio/sip-credentials/set` | set a custom SIP username/password | **GAP** → `telephony('sip_set')` |
| GET `/api/twilio/sip/:phoneId/ip-acl` | list the SIP IP allowlist | **GAP** → `telephony('acl_list')` |
| POST `/api/twilio/sip/:phoneId/ip-acl` | add an allowed IP (creates + maps the ACL on first add) | **GAP** → `telephony('acl_add')` |
| DELETE `/api/twilio/sip/:phoneId/ip-acl/:ipSid` | remove an allowed IP | **GAP** → `telephony('acl_remove')` |
| GET `/api/twilio/connect/start` | mint the Twilio Connect authorize URL | **GAP** → `telephony('connect_url')` — returns a URL for the human to open |
| GET `/api/twilio/connect/callback` | Twilio redirects the browser back here | n/a — browser redirect |
| GET/POST `/api/twilio/connect/deauthorize` | Twilio notifies that access was revoked | n/a — Twilio→playground webhook |

### `/api/knowledge` — `modules/knowledge/knowledge.routes.ts`

| method + path | purpose | coverage |
|---|---|---|
| GET `/api/knowledge` | list the org's knowledge bases | ✅ `knowledge('list')` |
| POST `/api/knowledge` | create a KB | **GAP** → `knowledge('create')` — the tool's action enum is `list \| query \| push` only |
| GET `/api/knowledge/:kbId` | one KB + its docs | ✅ `knowledge` / `get_doc` |
| DELETE `/api/knowledge/:kbId` | delete a KB | **GAP** → `knowledge('delete_kb')` |
| GET `/api/knowledge/:kbId/docs` | list docs in a KB | ✅ `knowledge`, `get_doc` |
| GET `/api/knowledge/:kbId/docs/:docId` | one doc **with full text** | ✅ `get_doc` (the docs KB), `knowledge` |
| POST `/api/knowledge/:kbId/docs` | upload a file **or** paste JSON text | ✅ `knowledge('push')` |
| DELETE `/api/knowledge/:kbId/docs/:docId` | delete a doc | **GAP** → `knowledge('delete_doc')` |
| POST `/api/knowledge/:kbId/query` | semantic search, retrieval only (no LLM) | ✅ `knowledge('query')`, `docs_search` |
| POST `/api/knowledge/:kbId/reindex` | rebuild the embeddings index | **GAP** → `knowledge('reindex')` |

### `/api/usage` — `modules/usage/usage.routes.ts`

| method + path | purpose | coverage |
|---|---|---|
| POST `/api/usage/log` | sdk-server reports usage (token auth) | n/a — m2m |
| GET `/api/usage` | recent usage rows (`?limit=`) | **GAP** → `usage` |
| GET `/api/usage/summary` | aggregated spend over `?days=` | **GAP** → `usage` |
| GET `/api/usage/activity` | daily call-volume timeseries | **GAP** → `usage` |
| GET `/api/usage/calls` | **call history grouped by callId** (`?limit&skip&days`) | 🟡 — `list_calls` reads the live call-log v3 per agent; this is the billing-side history across the org, and it is the only source for calls whose log has rotated out |

### `/api/conversations` — `modules/conversations/conversation.routes.ts`

| method + path | purpose | coverage |
|---|---|---|
| GET `/api/conversations` | this org's conversations, newest first (`?limit&skip&type=chat\|phone\|webrtc&agent=`) | 🟡 — `list_calls` covers voice via the call log; **chat** conversations are not listed anywhere in MCP |
| GET `/api/conversations/:id` | full stored transcript | 🟡 — `get_call` reads the log; a sealed chat transcript is not reachable |

### `/api/billing` — `modules/billing/billing.routes.ts`

| method + path | purpose | coverage |
|---|---|---|
| POST `/api/billing/webhook` | Stripe events (no auth, signature-verified) | n/a — Stripe→playground |
| POST `/api/billing/checkout` | subscribe to / change plan → Stripe URL | ✅ `subscribe` |
| POST `/api/billing/portal` | open the Stripe billing portal | ✅ `subscribe` (portal branch) |
| POST `/api/billing/topup` | **buy credits** → Stripe URL | **GAP** → `topup` (or a `subscribe(action:"topup")` branch) |

> `subscribe` covers *plan* changes and the portal. It does **not** cover a
> credit top-up, and running out of credits is the single most likely thing to
> stop a coding agent mid-journey — see §3.

### `/api/agents` — `modules/agents/agents.routes.ts`

| method + path | purpose | coverage |
|---|---|---|
| GET `/api/agents/live` | the org's live agents (proxies voice `/api/sdk/agents`, hides `pg-*`) | ✅ `list_agents` (calls `/api/sdk/agents` directly) |
| DELETE `/api/agents/:slug` | force-disconnect ("kick") a live agent | **GAP** → `kick_agent` |
| GET `/api/agents/token` | mint a browser `wrt_`/`cht_` token for an agent | ✅ used inside `chat`; not a tool of its own (correct — a token in a result is a credential) |
| GET `/api/agents/voices` | TTS voices for a provider, resolved with the org key (BYOK) | ✅ `list_voices` |
| GET `/api/agents/voice-preview` | stream a voice sample | ✅ `play_voice` |

### `/api/playground` — `modules/playground/playground.routes.ts`

| method + path | purpose | coverage |
|---|---|---|
| GET `/api/playground/skills` | catalog of predefined skills the UI can attach | **GAP** → `list_skills` |
| GET `/api/playground/phones` | numbers merged with "in use by `<agent>`" | ✅ `list_phones` |
| GET `/api/playground/catalog` | plan + balance + per-service models with access/price + voices, one payload | ✅ split across `whoami` / `list_models` / `list_voices` |
| GET `/api/playground/agents` | the org's running **playground-runtime** agents | 🟡 — `list_agents` hides `pg-*` like the dashboard does; MCP agents are the user's own processes |
| POST `/api/playground/agent` | register / hot-reload a live agent (slug, prompt, llm, voice, stt, language, greeting) | ✅ `configure_agent` (dev-only, by rule) |
| PATCH `/api/playground/agent/:slug` | hot-reload defaults + live calls | ✅ `configure_agent` |
| DELETE `/api/playground/agent/:slug` | stop + unregister | 🟡 — see `kick_agent` |
| GET `/api/playground/agent/:slug/events?since=` | poll the live event log | ✅ `list_calls`/`get_call`; live tail is tk-127c34 `observe` |
| POST `/api/playground/agent/:slug/control` | **dial / dtmf / forward / hold / mute / hangup / say** on a live call | **GAP** → `call_control` + `dial` |

> `control` is the biggest single behavioural gap: the playground can place an
> **outbound call** and steer a live one; MCP can only watch.

### `/api/session` — `modules/session/session.routes.ts`

| method + path | purpose | coverage |
|---|---|---|
| GET `/api/session` | validate a key → org + credentials + phones + limits | ✅ `whoami` (via `/orgs/me`) |

### `/api/admin` — `modules/admin/admin.routes.ts` (super-admin only)

| method + path | purpose | coverage |
|---|---|---|
| GET `/api/admin/stats` | platform-wide totals | n/a — super-admin |
| GET `/api/admin/users` | every dashboard user | n/a — super-admin |
| GET `/api/admin/orgs` | every org | n/a — super-admin |
| GET `/api/admin/orgs/:id` | org detail (users, phones, keys, recent calls) | n/a — super-admin |
| GET `/api/admin/conversations` | conversations across all orgs | n/a — super-admin |
| GET `/api/admin/conversations/:id` | any org's transcript | n/a — super-admin |

### `/api/internal` — `modules/internal/internal.routes.ts` (sdk-server ↔ playground)

`POST /session` · `GET /phone-lookup` · `POST /activate-phone` ·
`POST /deactivate-phone` · `GET /knowledge/:kbId/docs` · `POST /conversation-log` ·
`POST|GET /conversation-log/events` · `GET /conversation-history`.

All **n/a** — machine-to-machine, token-authenticated, called by the voice
server on the agent's behalf. Their *effects* are what MCP already surfaces:
phone activation happens when `configure_agent` sets `phoneNumber`, and the
conversation log is what `list_calls`/`get_call` read.

---

## 2. What the MCP already has that the UIs do **not**

Not parity gaps, the reverse — worth keeping in the ledger so nobody "aligns"
them away: `docs_search` / `get_doc` (the docs KB as a tool), `play_voice`
(local playback of a preview), `chat` as the *testing* story, and `set_api_key`
with an on-disk credentials store.

---

## 3. GAP shortlist — ordered by user value

The ordering rationale is on the card thread. Proposed shapes:

1. **`call_control`** — `{ agent, call_id?, action: "dial"|"say"|"dtmf"|"forward"|"hold"|"unhold"|"mute"|"unmute"|"hangup", to?, from?, digits?, text? }`
   → `POST /api/playground/agent/:slug/control`. `dial` is the headline: place a
   real outbound call from the editor and then read it back with `get_call`.
2. **`topup`** — `{ credits?: number, amount_usd?: number }` → `POST /api/billing/topup`,
   returns the Stripe checkout URL. Unblocks the "insufficient credits" wall.
3. **`phone_numbers`** — `{ action: "search"|"provision"|"import"|"refresh"|"rename"|"release", country?, area_code?, number?, id?, name? }`
   → the six `/api/phones` mutations. `provision` **charges credits** and must
   say so in its manual and echo the price before buying.
4. **`usage`** — `{ view: "summary"|"recent"|"activity"|"calls", days?, limit?, skip? }`
   → `/api/usage{,/summary,/activity,/calls}`. The "what did this cost me" tool,
   and the only reach into calls older than the live log.
5. **`conversations`** — `{ id? , type?: "chat"|"phone"|"webrtc", agent?, limit?, skip? }`
   → `/api/conversations[/:id]`. Sealed transcripts, **including chat**, which
   the call log does not carry.
6. **`api_keys`** — `{ action: "list"|"create"|"revoke", name?, id? }` → `/api/keys`.
   `create` must persist to `~/.pinecall/credentials` and return only a masked
   id — never the plaintext, per the milestone rule.
7. **`knowledge` extensions** — `create` / `delete_kb` / `delete_doc` / `reindex`
   as new actions on the existing tool. No new tool, pure OCP on its action enum.
8. **`kick_agent`** — `{ slug }` → `DELETE /api/agents/:slug`. The escape hatch
   when a stale process holds a slug and `configure_agent` keeps getting clobbered.
9. **`telephony`** — the eleven `/api/twilio*` actions behind one tool. Real
   power (BYO carrier, SIP, IP ACLs) but a rare, high-ceremony setup step; the
   `connect_url` action just hands the human a URL to open.
10. **`org_settings`** — `{ name?, email?, request_verification? }` →
    `PATCH /api/orgs/me` + `POST /api/orgs/me/request-verification`. Rare.
11. **`list_skills`** — `{}` → `GET /api/playground/skills`. Discovery only;
    `docs/guides/skills.md` already covers the concept via `docs_search`.

---

## 4. Platform (`~/pinecall/platform`) — no second API

`app/routes.ts` declares pages (`/agents`, `/models`, `/playground`, `/knowledge`,
`/telephony`, `/phone-numbers`, `/carriers`, `/calls`, `/usage`, `/billing`,
`/api-keys`, `/provider-keys`, `/settings`, `/admin`) plus these JSON resource
routes — every one a proxy, so its parity is the playground row it forwards to:

| resource route | forwards to | coverage |
|---|---|---|
| `/agent-token` | `GET /api/agents/token` | ✅ inside `chat` |
| `/playground/events` | `GET /api/playground/agent/:slug/events` | ✅ / `observe` |
| `/playground/voices` | `GET /api/agents/voices` | ✅ `list_voices` |
| `/playground/voice-preview` | `GET /api/agents/voice-preview` | ✅ `play_voice` |
| `/calls/data` | `GET /api/usage/calls` | **GAP** → `usage` |
| `/admin/org/:id`, `/admin/chat/:id` | `/api/admin/*` | n/a — super-admin |

The page list is a useful second check on the shortlist: **Calls**, **Usage**,
**Billing (top-up)**, **Phone numbers**, **Carriers** and **API keys** are whole
dashboard sections with no MCP tool behind them today.

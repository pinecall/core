---
title: "The Call Log"
description: "The wire reference for Pinecall's append-only call log — envelope, vocabulary, endpoints, SSE framing, filters and tokens."
---

# The Call Log

Every Pinecall call is recorded as an **append-only log**: an ordered sequence
of entries, each with a monotonically increasing `seq`. Observing a call — from
a dashboard, another process, another machine — means reading that log from a
cursor. That single idea replaces four features other platforms build
separately:

| You want to… | You do… |
|---|---|
| Watch a call live | read with `after=0`, keep reading |
| Join a call late | read with `after=0` — the backlog replays first, then live |
| Survive a disconnect | re-read with `after=<last seq you saw>` — zero lost, zero duplicated |
| Read a finished call | same request; the log is sealed but fully readable |

There is no separate "webhook history", no "did I miss an event?" ambiguity, no
event bus to operate. **The cursor is the whole protocol.**

> **This page is the wire.** For how to *consume* it — from a browser with zero
> libraries, from Node, from `curl`, with resume, filters and the hook options —
> read [Observe calls](/guides/observe-calls). That is the one page you need if
> you are building something.

## The entry envelope

Every entry has the same shape — seven keys, and every key inside `data` is
`snake_case`, exactly as the server appends it. There is deliberately no codec
in the path: the same bytes come back during the call and after it.

```json
{
  "seq": 12,
  "ts": 1786537584.38,
  "call": "CA89a64ad5...",
  "agent": "dental-desk",
  "type": "user.message",
  "ephemeral": false,
  "data": { "id": "u1", "text": "I need an appointment", "final": true }
}
```

| key | meaning |
|---|---|
| `seq` | The cursor, the dedupe key and the resume key. Monotonic per log, assigned only at the append point. **May have holes** after compaction — never assume contiguity; "caught up" is signalled by `log.caught_up`, never inferred. |
| `ts` | Server wall clock, float seconds. |
| `call` | The call id — **`null` on an agent log** (see [Two logs](#two-logs-the-calls-and-the-agents)). |
| `agent` | The agent id. |
| `type` | One closed vocabulary (below). No per-channel dialects. |
| `ephemeral` | `true` → delivered live, never persisted. Interim facts (partial transcripts, word timings) a late reader can skip; the durable entry that supersedes them always follows. |
| `data` | The type-specific payload. Additive-only per type. |

**Forward compatibility:** an unknown `type` must be *ignored*, never rejected.
The reducer does this for you; a hand-written consumer must too.

## The vocabulary

| type | `data` | notes |
|---|---|---|
| `call.ringing` | `{ direction, from, to }` | outbound: exists before pickup |
| `call.started` | `{ direction, from, to, channel, metadata? }` | `metadata` is the sealed token metadata |
| `call.ended` | `{ reason, duration }` | always passes every filter |
| `call.summary` | `{ metrics, cost?, reason, recording_url? }` | **always the last entry**; recordings referenced, never embedded |
| `user.speaking` | `{ active }` | ephemeral |
| `user.message` | `{ id, text, final, language? }` | partials ephemeral, finals persisted |
| `bot.speaking` | `{ id, text, words? }` | `words: [{ w, t0, t1 }]` when TTS gives alignment |
| `bot.word` | `{ id, w }` | ephemeral; live typing effect only |
| `bot.finished` | `{ id }` | |
| `bot.interrupted` | `{ id, at_word? }` | |
| `bot.corrected` | `{ supersedes, id, text }` | the transcript self-heals — an *event*, not a mutation: replace the text of the entry named by `supersedes` |
| `turn.start` | `{ turn, role }` | |
| `turn.end` | `{ turn, latency }` | `latency: { vad, asr, eou, llm_ttft, tts_ttfb, e2e }` |
| `tool.call` | `{ id, name, args }` | `args` is a parsed object **or** a JSON string — both legal |
| `tool.result` | `{ id, name, result, ms, error? }` | correlated with `tool.call` by `id` |
| `docs.sources` | `{ sources }` | RAG citations |
| `skill.loaded` / `skill.unloaded` | `{ skill, by }` | |
| `audio.metrics` | `{ mos?, jitter?, loss?, … }` | ephemeral; rolled up into `call.summary` |
| `handoff.requested` / `handoff.active` / `handoff.released` | `{ by }` | |
| `supervisor.said` / `supervisor.whispered` | `{ text, by }` | audit trail of the supervise verbs |
| `log.gap` | `{ from, resume_from, snapshot? }` | a control marker — see below |
| `log.caught_up` | `{ seq }` | a control marker — see below |
| `custom` | `{ name, value, id?, turn? }` | what `call.log()` wrote — see [Custom entries](#custom-entries) |

The exact same list is exported as `LOG_EVENT_TYPES` from `@pinecall/sdk/log`
and `@pinecall/web/log`.

### The two control markers

- **`log.gap`** — the server declares it cannot replay from your cursor (the hot
  buffer moved on). A gap is *declared*, never silently papered over.
  `data.resume_from` is the new cursor and `data.snapshot` is a state snapshot
  so the UI lands correct, not empty.
- **`log.caught_up`** — the backlog is done; everything after this is live.

### What a `log.gap` snapshot carries

The reducer (`CallLogView`, `@pinecall/sdk/log`) **hydrates** from the gap:
it records the gap in `state.gaps`, clears `caughtUp`, moves `lastSeq` to
`resume_from - 1` (the cursor is exclusive — `after=lastSeq` resumes exactly at
`resume_from`), and merges `data.snapshot` into the state it already has —
**by key, never replacing an array wholesale** (`LogGapSnapshot`):

| key | shape | merged by |
|---|---|---|
| `phase` | `"idle" \| "ringing" \| "listening" \| "thinking" \| "speaking" \| "ended"` | value |
| `live` | boolean | value |
| `started_at` | ts of `call.started` (the duration anchor) | value |
| `ended_reason` | string, once `call.ended` folded | value |
| `user_speaking` / `bot_speaking` | boolean | value |
| `handoff` | `"none" \| "requested" \| "active"` | value |
| `skills` / `sources` | `string[]` / the latest `docs.sources` | value |
| `messages` | `CallMessage[]` — `{ seq, role, text, id?, interim?, speaking?, interrupted?, corrected?, toolCallId? }` | `seq` (bot bubbles by `id`); re-sorted by seq |
| `tool_calls` | `CallToolCall[]` — `{ id, name, args, seq, done, result?, ms?, error? }` | `id` |
| `turns` | `CallTurn[]` — `{ turn, role?, startedAt?, endedAt?, latency? }` | `turn`, field-merged |
| `custom` | `CallCustomEntry[]` — `{ name, id, value, seq, ts, turn? }` | `(name, id)` — the higher `seq` wins |

The envelope's own `seq` sits immediately **before** the first entry that can be
served (`max(after, resume_from - 1)`), so a consumer that dedupes by seq
applies the gap exactly once and in the right place.

Every key is optional (absent → the local state is left alone) and unknown
keys are ignored. A snapshot row replaces its local counterpart; rows the
snapshot does not carry survive. The server folds the snapshot over every
entry it can still see — the page it serves right after the gap included —
and the merge is keyed the same way the reducer folds, so re-applying those
entries on top is a no-op. Not carried: `metrics.summary`/`cost` (only
`call.summary` sets them and it is never skipped — a sealed cursor answers
`204`) and `intents`. `snapshotOf(state)` builds this shape from a state; the
golden test asserts that a replay cut by a gap carrying the snapshot of the
skipped prefix lands in the same state as the full replay, for every cut.

## Two logs: the call's and the agent's

- A **call log** carries one conversation end to end — transcripts, tool calls,
  turns, custom entries, the final `call.summary`. It **seals**: the body ends
  after `call.summary`.
- An **agent log** answers *"what calls exist / which are live?"* — lifecycle
  only (`call.ringing` / `call.started` / `call.ended`), never transcripts. It
  **never seals**: one call ending must not tear down the dashboard watching the
  agent.

> ⚠️ **Where the call id lives differs between the two.** In a *call* log the
> envelope's `call` field names the call. In an *agent* log the envelope's
> `call` is `null` — the entry lives in the agent's log, not a call's — and the
> call id is in **`data.call`**. `@pinecall/web/log` and `pc.observe()` handle
> this for you; if you consume the wire directly, read
> `entry.call ?? entry.data.call`.

## The endpoints

Three, and two of them are the same URL twice:

| endpoint | what it is |
|---|---|
| `GET /v1/calls/{id}/events?after=<seq>&limit=<n>` | one call's log — a **JSON page** by default, an **SSE stream** with `Accept: text/event-stream` |
| `GET /v1/agents/{slug}/calls?after=<seq>&limit=<n>` | the agent's lifecycle log — same two flavours |
| `WS /v1/attach?token=…&call=<id>\|agent=<slug>&after=<seq>` | the live tail **that can also send** the supervise verbs |

`attach` takes exactly one of `?call=` or `?agent=`. All three take
[`?types=` and `?durable=1`](#filters). Reconnecting **is** the same URL with a
fresher `after` — there is no separate resume protocol.

> **Observation does not use the WebSocket.** `pc.observe()`, `observe()` and
> the React hooks all default to SSE (degrading to the JSON cursor). `WS
> /v1/attach` is for *sending* — see
> [Sending verbs is the one WebSocket](/guides/observe-calls#sending-verbs-is-the-one-websocket).

### SSE framing

| | |
|---|---|
| **Negotiation** | `Accept: text/event-stream` with a non-zero `q`. That is the whole negotiation — `EventSource` sends exactly that header, a JSON client sends `*/*` or nothing, and the JSON page stays the default. |
| **Response headers** | `content-type: text/event-stream` · `Cache-Control: no-cache` · `Connection: keep-alive` · `X-Accel-Buffering: no` (nginx must not buffer a held-open body) |
| **First frame** | `retry: 1000` — a vanilla `EventSource` reconnects in ~1 s instead of the browser default |
| **One entry, one event** | `id: <seq>` · `event: <type>` · `data: <the full envelope, one line>` — the same bytes the WS and the JSON page carry, so a consumer's reducer reads `data` unchanged |
| **Heartbeat** | `: ping` every **25 s**. An SSE *comment*: invisible to every decoder, visible to an idle watchdog on the line stream. It never reaches your reducer as an event. |
| **Cursor precedence** | `max(?after=, Last-Event-ID)`. A reconnecting `EventSource` re-sends the URL it was built with, so its `after=` is stale by construction; the header is the fresher of the two. A non-numeric or negative `Last-Event-ID` is ignored (treated as 0). |
| **End of body** | A call log's body ends after `call.summary`. An agent log's body never ends. |
| **`204 No Content`** | Sealed **and** the cursor is already at the last seq. A clean close would only make `EventSource` reconnect with the same cursor forever; `204` is what makes it stop. |
| **A reaped call** | Served as one SSE body from the store — the page (which ends in its terminator), then `log.caught_up`; nothing to tail. |

```
retry: 1000

id: 12
event: user.message
data: {"seq":12,"ts":1786537584.38,"call":"CA…","agent":"dental-desk","type":"user.message","ephemeral":false,"data":{"id":"u1","text":"I need an appointment","final":true}}

: ping
```

### The JSON page

Same URL without the `Accept` header:

```json
{ "entries": [ … ], "live": true, "next": 512 }
```

`next` is present only when the page filled `limit` — it is the unfiltered last
seq walked, so a filtered page does not re-read. `limit` defaults to **500** and
is clamped to **1000**.

## Filters

`?types=a,b,c` and `?durable=1`, on all three endpoints. Applied at the
**reader's sink** — the pump, the backlog, the JSON page, the SSE stream —
never on the append path, and **`seq` is never renumbered**.

- `types=` — comma-separated, **at most 32** names, each matching
  `^[a-z0-9_.-]{1,64}$`. Only the *shape* is refused (`400`); an unknown name is
  accepted and matches nothing, so a newer client may name a type an older
  server does not know.
- `durable=1` — drop `ephemeral` entries from the live tail. Accepts
  `1`/`true`/`yes`; `0`/`false`/`no`/empty is off; anything else is a `400`.

**The always-pass set** ignores both, always:

```
log.gap · log.caught_up · call.ended · call.summary
```

Those markers say where the consumer stands and when it is over; without them a
`types=tool.call` client would tail a dead call forever.

## Tokens: observe without participating

Observation uses a **stream token**, minted server-side with your API key —
exactly like a WebRTC mint, so your key never reaches the browser:

```typescript
// one agent, read-only
const t = await pc.createToken("stream", "dental-desk", undefined, { scope: "observe" });

// several agents — the token's agent SET, sealed in the signature
const t = await pc.createToken("stream", ["dental-desk", "support"]);
// → { token: "str_…", server, expiresIn }
```

| scope | may |
|---|---|
| `observe` | read a log |
| `supervise` | read, **and** send the supervise verbs over `WS /v1/attach` |
| `participate` | observe its own call (narrow it with `callId`) |

The token lists the **agents its holder may see**. That list is sealed into the
HMAC — the browser cannot widen it. A token covers a call iff the call's agent
is in its set; a token from another organization never sees a session. Tenant
isolation is achieved by **agent topology** (one agent per tenant), not by row
filtering — see [Multi-Tenant](/guides/multi-tenant).

Credentials are read as `Authorization: Bearer <token>` first and `?token=`
second — the query form exists because `EventSource` and a browser WebSocket
cannot set headers. A Pinecall API key works too, server-side. **A WebRTC
token (`wrt_`) is refused**: it is single-use, and validating it here would
consume the media connection it was minted for.

## Custom entries

The log is not only what the server observed — the agent can write into it.
`call.log(name, value)` appends a durable entry of type `custom` to this call's
log, visible to every observer and replayed on resume, exactly like a transcript
line:

```typescript
call.log("crm.lookup", { customer: "c_42", tier: "gold" });
call.log("appointment.booked", booked, { id: `${date}T${time}` });   // upsert key
call.log("progress", 0.4, { ephemeral: true });                      // live-only
```

Signature: `log(name: string, value: unknown, opts?: CallLogOptions): void`,
with `CallLogOptions = { id?: string; ephemeral?: boolean }` (exported from
`@pinecall/sdk`). It is reachable from a tool because `execute(args, call)`
receives the `Call` — see
[Tell the dashboard](/guides/tools-and-functions#tell-the-dashboard).

The wire entry every observer sees:

```json
{ "seq": 57, "ts": 1786537601.02, "call": "CA…", "agent": "dental-desk",
  "type": "custom", "ephemeral": false,
  "data": { "name": "appointment.booked", "value": { "when": "10:30", "room": 2 },
            "id": "2026-08-25T09:00", "turn": 4 } }
```

- `data.name` / `data.value` — yours, opaque to the server and the reducer.
- `data.id` — the upsert key, only if you passed one.
- `data.turn` — stamped by the server: the call's current turn id. Present on
  voice sessions (WebRTC, phone); absent on chat / WhatsApp, which have no turn
  counter. `seq`, `ts` and `turn` cannot be forged by the caller.

**The wire is append-only; the upsert is a projection.** Every `call.log()` is
its own entry with its own `seq`. The reducer folds durable `custom` entries
into `state.custom` by `(name, id)`: a later entry with the same key replaces
the row **wholesale** (`value`, `seq`, `ts`, `turn`); without `id` the key is the
entry's own `seq`, so every entry is a new row. Rows keep first-seen order.
Replay and late join converge on the same state because the replay *is* the same
sequence of upserts.

**Ephemeral entries** (`{ ephemeral: true }`) share the seq space and are fanned
out live, but are never buffered, persisted or replayed, never enter
`state.custom`, and never count against the durable cap — they reach
`onEntry` / `onCustom` and nowhere else. Use them for progress and interim
values; the durable entry that supersedes them should follow.

**Limits (server-enforced).** A refused entry is never appended:

| rule | limit |
|---|---|
| `name` | `^[a-z0-9][a-z0-9._-]{0,63}$` — lowercase, dot-namespaced like the vocabulary itself |
| `value` | any JSON, ≤ 16384 bytes serialized |
| `id` | non-empty string, ≤ 128 chars |
| durable entries per call | 1000 — then refused; ephemeral ones never count and still pass |
| the call | must be open (not ended), known to the server, and owned by the agent that calls `log()` |

A refusal is a transport frame on the SDK socket, never a log entry:

```json
{ "event": "error", "code": "CALL_LOG_REJECTED", "call_id": "CA…",
  "reason": "value too large (20481 > 16384 bytes)",
  "error": "call.log: value too large (20481 > 16384 bytes)" }
```

`call.log()` itself is fire-and-forget (`void`). The SDK surfaces the refusal
as the call's `log.rejected` event (`{ callId, reason, error }`) and, like every
other call-verb refusal, as the client-level `error`:

```typescript
call.on("log.rejected", ({ reason }) => console.warn("call.log refused:", reason));
```

When a client lands with a `log.gap`, the gap snapshot carries the same fold:
`data.snapshot.custom` is an array of `{ name, id, value, seq, ts, turn? }`
rows — the latest value per `(name, id)`, ephemerals excluded — and the
reducer merges them into `state.custom` by `(name, id)`, the higher `seq`
winning (see "What a `log.gap` snapshot carries" above).

Reading them — with a plain `EventSource`, with `useCall`'s `s.custom` /
`onCustom`, or with `pc.observe().on("custom", …)` — is
[Observe calls](/guides/observe-calls).

## Design guarantees

- **Append-once.** One fact = one entry, even though the server fans events out
  to multiple transports internally. Dedupe by `seq` is always safe.
- **Observers never slow the call.** Log delivery is decoupled from the media
  path; a slow reader is dropped (`slow_consumer`) and re-attaches with its
  cursor — the call never blocks.
- **`call.summary` is always the last entry.** Seeing it means the log is
  complete and sealed.
- **The same bytes, live or after the fact.** The GET returns the same envelope
  during the call and once it is over. History needs no second API.

## What's next

- [Observe calls](/guides/observe-calls) — how to read this, from anywhere
- [Build a live call app](/guides/build-a-live-call-app) — the step-by-step app
- [Multi-Tenant](/guides/multi-tenant) — the agent-set isolation model
- [Live listening](/guides/live-listening) · [Human takeover](/guides/human-takeover) — the supervise verbs

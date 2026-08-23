---
title: "The Call Log"
description: "Every call is an append-only log with a cursor — live tail, late join, reconnect, replay and history are the same mechanism."
---

# The Call Log

Every Pinecall call is recorded as an **append-only log**: an ordered sequence of
entries, each with a monotonically increasing `seq`. Observing a call — from a
dashboard, another process, another machine — means reading that log from a
cursor. That single idea replaces four features other platforms build separately:

| You want to… | You do… |
|---|---|
| Watch a call live | attach with `after=0`, keep reading |
| Join a call late | attach with `after=0` — the backlog replays first, then live |
| Survive a disconnect | re-attach with `after=<last seq you saw>` — zero lost, zero duplicated |
| Read a finished call | same request; the log is sealed but fully readable |

There is no separate "webhook history", no "did I miss an event?" ambiguity, no
event bus to operate. **The cursor is the whole protocol.**

> This works from ANY process, on any machine — unlike the in-process
> [SSE](/guides/sse-streaming) / [WebSocket](/guides/ws-streaming) streams, which
> only exist inside the process that runs the agent. If you are building a
> dashboard or observing calls, this is the mechanism to use.

## The entry envelope

Every entry has the same shape:

```json
{
  "seq": 12,
  "ts": 1786537584.38,
  "call": "CA89a64ad5...",
  "agent": "bistro",
  "type": "user.message",
  "ephemeral": false,
  "data": { "id": "u1", "text": "A table for two, please", "final": true }
}
```

- `seq` — the cursor. Strictly increasing per log. Two reads of the same log
  agree on what `seq: 12` is, forever.
- `type` — a closed vocabulary: `call.ringing`, `call.started`, `user.message`,
  `bot.message`, `tool.call`, `tool.result`, `turn.completed`, `call.ended`,
  `call.summary`, `custom` (the agent's own entries, `data: { name, value,
  id?, turn }`), and the control markers below.
- `ephemeral` — interim facts (partial transcripts, word timings) that a late
  reader can skip; the durable entry that supersedes them always follows.

Two control markers matter to clients:

- **`log.gap`** — the server declares it cannot replay from your cursor (the hot
  buffer moved on). `data.resume_from` is the new cursor and `data.snapshot` is
  a state snapshot so the UI lands correct, not empty.
- **`log.caught_up`** — the backlog is done; everything after this is live.

### What a `log.gap` snapshot carries — and how the reducer lands it

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
  turns, the final `call.summary`.
- An **agent log** answers *"what calls exist / which are live?"* — lifecycle
  only (`call.ringing` / `call.started` / `call.ended`), never transcripts.

> ⚠️ **Where the call id lives differs between the two.** In a *call* log the
> envelope's `call` field names the call. In an *agent* log the envelope's
> `call` is `null` — the entry lives in the agent's log, not a call's — and the
> call id is in **`data.call`**. `@pinecall/web/log` handles this for you; if
> you consume the wire directly, read `entry.call ?? entry.data.call`.

## Tokens: observe without participating

Observation uses a **stream token**, minted server-side with your API key —
exactly like a WebRTC mint, so your key never reaches the browser:

```typescript
// one agent
const t = await pc.createToken("stream", "bistro");

// several agents — the token's agent SET, sealed in the signature
const t = await pc.createToken("stream", ["bistro", "support"]);
// → { token, server }
```

The token lists the **agents its holder may see**. That list is sealed into the
HMAC — the browser cannot widen it. A token covers a call iff the call's agent
is in its set. Tenant isolation is achieved by **agent topology** (one agent per
tenant), not by row filtering — see [Multi-Tenant](/guides/multi-tenant).

## The wire API

Three endpoints on the voice server:

| Endpoint | What it is |
|---|---|
| `WS /v1/attach?token=…&call=<id>&after=<seq>` | live tail of one call — the canonical read |
| `WS /v1/attach?token=…&agent=<slug>&after=<seq>` | live tail of an agent's lifecycle log |
| `GET /v1/calls/{id}/events?after=<seq>` | paged history (HTTP, same cursor) |
| `GET /v1/agents/{slug}/calls` | the agent's calls, one row per call |

`attach` takes exactly one of `?call=` or `?agent=`. Reconnecting **is** the
same URL with a fresher `after` — there is no separate resume protocol.

## The browser client: `@pinecall/web/log`

You normally never touch the wire. The `@pinecall/web` package ships a
framework-free reducer + transports, and React hooks on top:

```tsx
import { useAgentCalls, useCall } from "@pinecall/web/log/react";

// 1 — the list: which calls exist / are live (agent log)
const { calls, live } = useAgentCalls("bistro", { token, server });

// 2 — the content: one call's messages, tools, turns (call log)
const s = useCall({ call: calls[0]?.call, token, server });
s.messages   // [{ role, text, seq }]   — transcripts, interim + final
s.toolCalls  // [{ name, result, … }]  — with results as they land
s.phase      // "ringing" | "active" | "ended"
s.live       // still running?
s.caughtUp   // past the backlog?
```

Both hooks reconnect automatically with the cursor (`after=lastSeq`), fall back
to HTTP polling where WebSocket is unavailable, and de-duplicate the overlap on
resume. Framework-free equivalents (`CallLogView`, `tail()`, `poll()`,
`observe()`) live in `@pinecall/web/log`.

For the full walk-through — a working app with a live phone-line dashboard —
see [Build a live call app](/guides/build-a-live-call-app).

## Custom entries

The log is not only what the server observed — the agent can write into it.
`call.log(name, value)` appends a durable entry of type `custom` to this call's
log, visible to every observer (dashboards, `useCall`, `GET /v1/calls/{id}/events`,
SSE) and replayed on resume, exactly like a transcript line:

```typescript
call.log("crm.lookup", { customer: "c_42", tier: "gold" });
call.log("booking.slot", { when: "10:30", room: 2 }, { id: "booking" });   // upsert key
call.log("progress", 0.4, { ephemeral: true });                           // live-only
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
  "data": { "name": "booking.slot", "value": { "when": "10:30", "room": 2 },
            "id": "booking", "turn": 4 } }
```

- `data.name` / `data.value` — yours, opaque to the server and the reducer.
- `data.id` — the upsert key, only if you passed one.
- `data.turn` — stamped by the server: the call's current turn id. Present on
  voice sessions (WebRTC, phone); absent on chat / WhatsApp, which have no turn
  counter. `seq`, `ts` and `turn` cannot be forged by the caller.

**The wire is append-only; the upsert is a projection.** Every `call.log()` is
its own entry with its own `seq`. The reducer (`@pinecall/web/log`) folds
durable `custom` entries into `state.custom` by `(name, id)`: a later entry with
the same key replaces the row **wholesale** (`value`, `seq`, `ts`, `turn`);
without `id` the key is the entry's own `seq`, so every entry is a new row.
Rows keep first-seen order. Replay and late join converge on the same state
because the replay *is* the same sequence of upserts.

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

### Reading them with a plain `EventSource`

The `GET` cursor streams SSE when asked with `Accept: text/event-stream`, which
`EventSource` sends by itself. Each entry's `event:` is its `type`, so custom
entries are one listener away — no library:

```html
<script>
  const es = new EventSource(
    `${server}/v1/calls/${callId}/events?token=${token}&after=0`,
  );
  const latest = new Map();                 // (name/id) → value — the same upsert
  es.addEventListener("custom", (e) => {
    const entry = JSON.parse(e.data);       // the full envelope
    if (entry.ephemeral) return;            // live-only; never state
    const { name, value, id } = entry.data;
    latest.set(`${name}/${id ?? entry.seq}`, value);
    render(latest);
  });
  es.addEventListener("call.summary", () => es.close());
</script>
```

Reconnects resume from the last `id:` (the `seq`) automatically via
`Last-Event-ID`.

### Reading them with `useCall`

`useCall` exposes the projection as `s.custom` and every custom entry — durable
or ephemeral — through `onCustom` (shapes from `@pinecall/web/log`; the hook
options are coming in `@pinecall/web`):

```tsx
const s = useCall<{ "booking.slot": { when: string; room: number } }>({
  call, token, server,
  onCustom: (name, value, entry) => {
    if (name === "booking.slot") toast(`Slot: ${value.when}`);   // value is typed
  },
});
s.custom   // [{ name: "booking.slot", id: "booking", value: {…}, seq, ts, turn }]
```

## Backend observation

The same endpoints work from Node (or anything that speaks WS/HTTP). Mint a
stream token with the SDK and attach:

```typescript
const { token, server } = await pc.createToken("stream", "bistro");
// WS `${server}/v1/attach?token=${token}&agent=bistro&after=0`
```

Because the cursor survives your process restarting (persist `lastSeq`, resume
from it), a consumer that was down does not miss entries — it catches up. That
is the property webhooks cannot give you.

## Design guarantees

- **Append-once.** One fact = one entry, even though the server fans events out
  to multiple transports internally. Dedupe by `seq` is always safe.
- **Observers never slow the call.** Log delivery is decoupled from the media
  path; a slow dashboard gets a `slow_consumer` close and re-attaches with its
  cursor — the call never blocks.
- **`call.summary` is always the last entry.** Seeing it means the log is
  complete and sealed.

## What's next

- [Build a live call app](/guides/build-a-live-call-app) — the step-by-step app
- [Multi-Tenant](/guides/multi-tenant) — the agent-set isolation model
- [SSE](/guides/sse-streaming) / [WS streaming](/guides/ws-streaming) — the
  older in-process streams, and when they are still the right tool

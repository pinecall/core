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
  `call.summary`, and the control markers below.
- `ephemeral` — interim facts (partial transcripts, word timings) that a late
  reader can skip; the durable entry that supersedes them always follows.

Two control markers matter to clients:

- **`log.gap`** — the server declares it cannot replay from your cursor (the hot
  buffer moved on). `data.resume_from` is the new cursor and `data.snapshot` is
  a state snapshot so the UI lands correct, not empty.
- **`log.caught_up`** — the backlog is done; everything after this is live.

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

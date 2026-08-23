---
title: "Observe Calls"
description: "One way to watch a call: the agent writes with call.log(), the call log stamps it with a seq, and anybody reads it — from the browser, from Node, from curl. No WebSocket."
---

# Observe Calls

There is **one** way to watch a Pinecall call, and it is a read:

```
   the agent writes                the call log                  anybody reads
   ────────────────                ────────────                  ─────────────
   call.log(name, value)  ──┐                                ┌──►  new EventSource(url)      browser, zero libraries
   what the session         ├──►  seq 1, 2, 3, …  ──────────►├──►  useCall / useAgentCalls   @pinecall/web/log/react
   observed (transcripts,   │     append-once,               ├──►  pc.observe({ agent })     Node / your backend
   tools, turns, summary) ──┘     replayable, sealed         └──►  curl -N                   anything that speaks HTTP
                                  by call.summary
```

- **The agent writes.** Everything the session observes is appended for you;
  `call.log(name, value)` is how *your* facts get in ([Custom entries](/guides/call-log#custom-entries-writing-your-own-facts-with-calllog)).
- **The log stamps.** One fact = one entry = one monotonic `seq`, per call.
  `seq` is the cursor, the dedupe key and the resume key, all at once.
- **Anybody reads.** Live tail, late join, reconnect, replay and history are the
  *same request* with a different `after=`. Observation is a `GET`; **no
  WebSocket is opened** unless you ask for one to *send* something.

The wire itself — envelope, vocabulary, headers, framing, filters — is
[The Call Log](/guides/call-log). This page is how you consume it.

## 1. Mint a stream token

Observation uses a **stream token**, minted server-side with your API key, so
the key never reaches the browser. The token carries the **agent set** its
holder may see, sealed into the signature — a browser cannot widen it.

```typescript
// your backend — POST /api/token
const { token, server } = await pc.createToken("stream", "dental-desk", undefined, {
  scope: "observe",                       // read-only: no supervise verbs
});
// → { token: "str_…", server: "https://voice.pinecall.io", expiresIn: 3600 }
```

`agentId` may be a **list** — `pc.createToken("stream", ["acme-support", "acme-sales"])`
— which is how one dashboard watches several agents and how a tenant is scoped
to exactly its own: see [Multi-tenant dashboards](/guides/multi-tenant).

A token covers a call **iff the call's agent is in its set**. Holding another
tenant's call id grants nothing — the read is a `403`.

## 2. From the browser

### Zero libraries: `new EventSource(url)`

The `GET` cursor answers `Accept: text/event-stream` with a held-open SSE body,
and that is the header `EventSource` sends by itself. Each entry is one event:
`id:` is its `seq`, `event:` is its `type`, `data:` is the **full envelope**.

```html
<script>
  const es = new EventSource(
    `${server}/v1/calls/${callId}/events?token=${token}&after=0`,
  );

  es.addEventListener("user.message", (e) => {
    const { data } = JSON.parse(e.data);          // the envelope
    if (data.final) addLine("caller", data.text);
  });
  es.addEventListener("bot.speaking", (e) => addLine("bot", JSON.parse(e.data).data.text));
  es.addEventListener("tool.call",   (e) => addChip(JSON.parse(e.data).data.name));

  es.addEventListener("custom", (e) => {          // what call.log() wrote
    const entry = JSON.parse(e.data);
    if (entry.ephemeral) return;                  // live-only, never state
    const { name, value } = entry.data;
    if (name === "appointment.booked") showBooking(value);
  });

  es.addEventListener("log.caught_up", () => setStatus("live"));   // backlog done
  es.addEventListener("call.summary", () => es.close());           // always the last entry
</script>
```

That is the whole client. Reconnects are free: the browser resends the last
`id:` it saw as `Last-Event-ID`, the server reads it as `after=`, and you lose
nothing and see nothing twice. The first frame of every body is `retry: 1000`,
so a dropped stream comes back in about a second instead of the browser default.

> **Why the token is in the query string.** `EventSource` cannot set an
> `Authorization` header. The endpoint accepts `?token=` for exactly that; the
> library clients send both. A stream token is short-lived and read-only —
> that is the trade it is designed for.

### With the library: `observe()`

`@pinecall/web/log` is framework-free: the reducer (`CallLogView`) plus the
pipes that feed it. `observe()` is the one to use — it is `sse`, degrading to
`poll` if the stream never opens.

```ts
import { createCallLogView, observe } from "@pinecall/web/log";

const view = createCallLogView();
view.subscribe(() => render(view.state));         // messages, toolCalls, turns, custom, phase

const obs = observe(view, {
  call: callId, token, server,
  onEntry: (entry, state) => {},                  // every applied entry, in seq order
  onFinish: ({ reason, lastSeq }) => {},          // "summary" | "closed" | "error"
});
obs.kind      // "sse" — what is actually carrying entries
obs.close();
```

`observe(view, opts)` never opens a WebSocket on its own. `transport` is
`"auto"` by default and `"auto"` means **sse → poll**; `"ws"` happens only when
you ask for it, and only [to send verbs](#sending-verbs-is-the-one-websocket).

### With React: `useCall` / `useAgentCalls`

```tsx
import { useAgentCalls, useCall } from "@pinecall/web/log/react";

// 1 — which calls exist, which are live (the AGENT log: lifecycle only)
const { calls, live } = useAgentCalls("dental-desk", { token, server });

// 2 — one call's content (the CALL log)
const s = useCall<{ "appointment.booked": Booking }>({
  call: live[0]?.call, token, server,
  onCustom: (name, value, _entry) => {            // three params — see the warning
    if (name === "appointment.booked") toast(value.reference);
  },
});

s.messages    // [{ seq, role, text, interim?, speaking?, … }]
s.toolCalls   // [{ id, name, args, result?, ms?, done }]
s.custom      // [{ name, id, value, seq, ts, turn? }] — upserted by (name, id)
s.turns · s.phase · s.live · s.caughtUp · s.transport
```

Both hooks return `view` (the reducer itself, for `view.entries()` or a second
pipe) and `close()`; `useCall` also returns `send(verb)`.

**The options, with the defaults the code actually has**
(`@pinecall/web/log/react`, `src/log/react.tsx`):

| option | default | what it does |
|---|---|---|
| `throttle` | `true` | Coalesce React notifications: `true` = one render per macrotask; a number = at most one render per *n* ms (leading **and** trailing edge — a fast stream never starves the UI); `false` = a render per applied entry. **The reducer is never throttled** — `view.state` is always current, only the notification is coalesced. |
| `reconnectOnMount` | `true` | Resume from the cursor a previous mount stored. `true` = `window.localStorage` under `pc:log:<call>` / `pc:log:agent:<slug>` as `{seq, ts}`; a function supplies any three-method storage (tests, SSR); `false` = never read or write. Read once when the observation opens (so a tile enabled later still resumes), used as the `after=` seed only when `after` is absent and the view is cold, written through as entries land, **cleared when `call.summary` is applied**, and **ignored + removed after 24 h**. Storage that throws (SSR, blocked cookies) behaves as `false`. |
| `enabled` | `true` | `false` keeps the view but opens nothing — a paused dashboard tile. |
| `transport` | `"auto"` | `"auto"` = sse → poll. `"ws"` only on request. `"poll"` forces the JSON cursor. |
| `types` | — | Server-side filter: only these entry types (plus the always-pass set). |
| `durable` | `false` | Server-side filter: skip ephemeral entries in the live tail. |
| `onEntry` | — | Every applied entry, in seq order, **before** React is notified. Never throttled. |
| `onCustom` | — | Typed view of `onEntry` for `custom` entries. Ephemeral ones arrive here and nowhere else. |
| `onFinish` | — | Once, when the observation ends: `"summary"` (clean), `"closed"` (unmount / `close()`), `"error"`. |
| `idleReconnect` | `"auto"` | Half-open detection — see [resume & failure](#5-resume-and-failure). |
| `after` | the view's `lastSeq` | Explicit start cursor. |

> ⚠️ **`onCustom` narrows only at exact arity.** `useCall<Custom>` types the
> callback as one parameter tuple *per name*, which is what lets
> `if (name === "appointment.booked")` narrow `value`. TypeScript only
> contextually types a union of parameter tuples against a **matching arity**,
> so declare all three parameters — `(name, value, _entry) => …`. Drop
> `_entry` and `value` silently widens back to `unknown`.

## 3. From Node — your backend, a worker, a CLI (`pc.observe()`)

`pc.observe()` is the same reader, server-side. It opens the same `GET` with
`Accept: text/event-stream`, feeds the **same** `CallLogView` reducer, and gives
you three ways to consume it — `for await`, `on()`, and the reduced `state`.

```typescript
const obs = pc.observe({ agent: "dental-desk", types: ["custom", "call.ended"] });

obs.on("custom", (name, value, entry) => crm.record(entry.call, name, value));
obs.on("entry", (entry, state) => {});            // fires synchronously, never dropped
obs.on("finish", ({ reason, lastSeq }) => {});

for await (const entry of obs) {                  // the only lossy surface — see below
  if (entry.type === "call.started") console.log("call", entry.call);
}

await obs.done;                                   // resolves once; never rejects
obs.close();                                      // idempotent; never reconnects after
```

**Minting needs an agent.** The token defaults to one minted with the client's
API key (`createToken({ channel: "stream", scope: "observe" })`), and a stream
token's visibility *is* an agent set — so `observe({ call })` **without** a
token must also pass `agent`. The SDK will not resolve a call id to its agent
behind your back, because the only endpoint that would answer needs the very
token being minted. Pass `{ call, agent }`, or pass a `token` you already hold.

**Backpressure is a bounded queue.** The async iterator buffers at most
`queueLimit` entries — **default 1024** — and on overflow the **oldest** are
dropped, never the newest (a slow tail should show recent truth). Every drop is
counted in `obs.dropped`.

```typescript
const obs = pc.observe({ agent, queueLimit: 4096 });
// …later
if (obs.dropped > 0) console.warn(`iterator skipped ${obs.dropped} entries`);
```

`state` is **not** affected: every entry is reduced into the view *before* it is
queued, so the reduced state is complete even when the iterator skipped rows.
`on("entry")` is likewise never dropped — it fires synchronously. **The queue is
the only lossy surface**, and only under genuine backpressure.

### Catching up after your consumer was down

Persist `lastSeq` and hand it back as `after`. That is the whole recovery
protocol — the property a webhook cannot give you:

```typescript
const from = Number(await redis.get(`cursor:${agent}`) ?? 0);
const obs = pc.observe({ agent, after: from });

obs.on("entry", async (entry) => {
  await handle(entry);
  await redis.set(`cursor:${agent}`, String(entry.seq));   // after the work, not before
});
```

Nothing between `from` and now is lost: the backlog replays first, `log.caught_up`
marks the boundary, and the tail continues from there. An agent log never seals,
so this consumer runs forever.

## 4. From a terminal — or any language

No SDK, no browser. One header:

```bash
curl -N -H 'Accept: text/event-stream' \
        -H "Authorization: Bearer $TOKEN" \
        "https://voice.pinecall.io/v1/calls/$CALL/events?after=0"
```

```
retry: 1000

id: 1
event: call.started
data: {"seq":1,"ts":1786537580.11,"call":"CA…","agent":"dental-desk","type":"call.started","ephemeral":false,"data":{"direction":"inbound","from":"+34…","to":"+1…","channel":"phone"}}

: ping

id: 12
event: user.message
data: {"seq":12,"ts":1786537584.38,"call":"CA…","agent":"dental-desk","type":"user.message","ephemeral":false,"data":{"id":"u1","text":"I need an appointment","final":true}}
```

Resume with `-H "Last-Event-ID: 12"`, or with `?after=12` — they mean the same
thing and the **larger of the two wins**. Drop the `Accept` header and the same
URL answers a JSON page instead; that is the polling cursor.

## 5. Resume and failure

Everything here is one idea: **the cursor is the protocol.**

| situation | what happens |
|---|---|
| **Reconnect** | The client reopens the same URL with `after=<highest seq applied>`. `EventSource` does it for you with `Last-Event-ID`; the library pipes carry `after=` explicitly. Zero lost, zero duplicated. |
| **`Last-Event-ID` vs `after=`** | The server takes `max(after, Last-Event-ID)`. A reconnecting `EventSource` re-sends the URL it was built with, so its `after=` is stale by construction — the header is the fresher of the two, and `max()` is what makes both correct. |
| **The cursor fell out of the buffer** | The server emits **`log.gap`** instead of pretending: `data.from`, `data.resume_from`, and a `data.snapshot` of the state you missed. The reducer *hydrates* from it — the UI lands correct, not empty. Shape and merge rules: [the gap snapshot](/guides/call-log#what-a-loggap-snapshot-carries). |
| **Backlog done** | **`log.caught_up`** — everything after it is live. Never infer this from seq contiguity; `seq` may have holes after compaction. |
| **Heartbeat** | The server writes `: ping` every **25 s**. It is an SSE *comment*: invisible to every decoder, visible to a watchdog on the line stream. It never reaches your reducer. |
| **Half-open pipe** (pod hard-killed, no FIN) | `idleReconnect: "auto"` (the default) is dormant until two heartbeats were seen, then the window is `clamp(3 × observed cadence, 6 s, 30 s)`. When it trips, the pipe is aborted and reopened with the cursor. A number is a fixed window armed from the first frame; `0` turns it off. |
| **Backoff** | `min(1000 · 2ⁿ, 15000) + rand(0, 1000)` ms — identical in the browser and in Node. In a browser, a reconnect due while the tab is hidden waits for `visibilitychange`. |
| **`204 No Content`** | The call is sealed **and** your cursor is already at the end. A clean close would only make `EventSource` reconnect forever; `204` is what makes it stop. The library reports it as a clean finish, `reason: "summary"`. |
| **`401` / `403` / `404`** | Terminal. No reconnect fixes a bad token or a call that is not there, so the pipes stop and report. |
| **Slow consumer** | Log delivery is decoupled from the media path. A reader that cannot keep up is dropped and re-attaches with its cursor — **the call never blocks**. |
| **The body ends** | On a call log the body ends right after `call.summary`, the always-last entry. **An agent log never seals**, so its body never ends. |
| **`auto` degrades** | Only when the SSE stream **never opened** (a proxy that buffers `text/event-stream`, a blocked port) — then it falls back to polling, carrying the cursor across, so the degraded run lands on the same state. A stream that opened and then dropped is merely flaky: reconnecting with the cursor beats polling. |

## 6. Filters: `types=` and `durable=1`

Both `GET` cursors take server-side filters. They are applied at the reader's
sink — never on the append path — and **`seq` is never renumbered**, so the
cursor still means what it means.

```bash
# only what your app wrote, plus the terminators
curl -N -H 'Accept: text/event-stream' \
  "$server/v1/calls/$CALL/events?token=$T&types=custom,tool.result&durable=1"
```

```ts
pc.observe({ agent, types: ["custom"], durable: true });
useCall({ call, token, server, types: ["user.message", "bot.speaking"] });
```

- `types=a,b,c` — comma-separated, **at most 32 names**, each matching
  `^[a-z0-9_.-]{1,64}$`. Only the *shape* is refused: an unknown name is
  accepted and matches nothing, so a newer client may name a type an older
  server has never heard of.
- `durable=1` — drop ephemeral entries (partial transcripts, word timings,
  `call.log(…, { ephemeral: true })`) from the live tail.

**The always-pass set** ignores both filters, always:

```
log.gap · log.caught_up · call.ended · call.summary
```

Those are the markers that say where you stand and when it is over. Without
them a `types=tool.call` client would tail a dead call forever.

## Sending verbs is the one WebSocket

Observation is a read and reads do not need a socket. The **only** reason to
open one is to *send* — the supervise verbs (whisper, barge in, take over):

```tsx
const s = useCall({ call, token, server, transport: "ws" });   // opt in, explicitly
s.send({ verb: "whisper", text: "the 10:30 slot is gone" });   // false if not open
```

That takes `WS /v1/attach?token=…&call=<id>&after=<seq>`, and a **supervise**
token rather than an `observe` one:

```ts
const t = await pc.createToken("stream", SLUG, undefined, { scope: "supervise", callId });
```

The verbs (`SuperviseVerb`, from `@pinecall/web/log`):

| verb | what it does |
|---|---|
| `{ verb: "say", text }` | the agent says it out loud |
| `{ verb: "whisper", text }` | steer the agent without the caller hearing |
| `{ verb: "takeover" }` / `{ verb: "release" }` | a human takes the conversation, and gives it back |
| `{ verb: "transfer", to }` | hand the call to a number |
| `{ verb: "end" }` | end the call |

Each one lands in the log as its own entry (`supervisor.said`,
`supervisor.whispered`, `handoff.*`) — the audit trail is the same log everybody
else is reading. See [Live listening](/guides/live-listening) and
[Human takeover](/guides/human-takeover).

If you are only watching, leave `transport` alone. `auto` never opens a socket,
and that is a guarantee, not a default: a dashboard that only reads costs the
voice server one HTTP body.

## Coming from `agent.stream()` / `agent.ws()`?

They are **gone** — removed, not deprecated, along with `createEventStream()`,
`EventStream` and the whole `@pinecall/sdk` `stream/` module. They were
in-process: they could only ever see calls handled by *that* process, they had
no cursor, no replay and no history, and they died with the process. The call
log has all four, from anywhere.

| you had | you write now |
|---|---|
| `agent.stream(res)` — SSE of one agent's events | `pc.observe({ agent })` in Node, or let the browser read the log directly |
| `agent.ws(socket)` — bidirectional, in-process | `useCall({ …, transport: "ws" })` for the verbs; plain `observe()` for the watching |
| `createEventStream({ url })` in the browser | `useCall` / `useAgentCalls`, or `observe()` from `@pinecall/web/log` |
| your own `/api/events` route relaying the bus | delete it — mint a stream token and let the browser read the log |

```diff
- app.get("/events", (req, res) => agent.stream(res));
- const es = new EventSource("/events");
+ app.post("/api/token", async (req, res) =>
+   res.json(await pc.createToken("stream", SLUG, undefined, { scope: "observe" })));
+ const { calls, live } = useAgentCalls(SLUG, { token, server });
```

`pc.stream()` — the client-level, multi-agent, in-process SSE bus that the
[run console](/guides/run-console) is built on — **still exists**. It is a
development and single-process convenience, not the observation model: no
cursor, no replay, no history, one process only. If you are building something
a user will see, read the log.

## What's next

- [The Call Log](/guides/call-log) — the wire: envelope, vocabulary, endpoints, framing
- [Build a live call app](/guides/build-a-live-call-app) — the whole thing, working, in one app
- [Multi-tenant dashboards](/guides/multi-tenant) — one token per tenant, sealed agent set
- [Live listening](/guides/live-listening) · [Human takeover](/guides/human-takeover) — when you also need to send

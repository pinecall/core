# Synthesis — the Pinecall design: SSE attach, `call.log()`, `useCall` throttle / reconnectOnMount, server-side filters

Card tk-c2d3cb · milestone "Streaming research" · 2026-08-23

This document turns the five per-repo reports into one concrete design. It adds
nothing from memory: every decision below names the report it is copied from
(and, through it, the repo file), or the Pinecall file it was verified against.

| tag | meaning |
|---|---|
| **[verified]** | I read the Pinecall file named and the claim is what the code does today |
| **[report: X §n]** | copied from `docs/notes/research/<X>.md`, section n — the repo file is cited there |
| **[inferred]** | a design consequence or a server behaviour I did not read; to be checked by the implementing card |
| **[spec fact]** | WHATWG/RFC behaviour of `EventSource`/SSE, not from a report |

Reports: `langgraph-sse-wire` (lgwire), `langgraph-stream-modes` (lgmodes),
`langgraph-usestream` (lghook), `ag-ui`, `vercel-ai-stream` (vercel).

Pinecall files read **[verified]**: `docs/guides/call-log.md`;
`webrtc/src/log/{index.ts,react.tsx,transport.ts,agent.ts,vendor/types.ts,vendor/view.ts,vendor/README.md}`;
`sdk-server/src/pinecall/server/handlers/calls_api.py` (`/v1/attach` 738-843,
`_pump_tail` 705-735, `_attach_backlog` 664-684, `_caught_up_entry` 635-661,
`_gap_entry` 308-336, `_snapshot` 272-305, `call_events` 367-423, `_credential`
170-175, `PING_INTERVAL_SECONDS` 67); `sdk-server/src/pinecall/session/call_log.py`
(`LogEntry.to_dict` 110-118, `Subscriber` 123-135, `append`/`try_append`/`_record`
199-268, `since` 350-368, `AgentLog._record` 455-463, `DEFAULT_QUEUE_MAXSIZE` 61);
`session/event_tap.py`; `session/legacy_events.py` (`_TABLE` 195-300);
`session/manager.py` (`log_and_stamp` 1517-1542, `get_call_log`/`get_or_create_call_log`
1544-1555); `transports/client/handler.py` (the SDK command dispatcher, 660-2260);
`sdk/src/domain/call.ts` (`Call`, `#send`, `toolResult` 333-351, `loadSkill` 423);
`sdk/src/dispatch/handlers/tool.ts:173` (where `tool.execute(args, call)` runs);
`sdk/src/log/{index,types,view}.ts` (the source of the vendored reducer).

---

## 0. The frame every decision sits in

Three facts about the Pinecall call log hold every design below together, and
none of the four reference implementations has all three:

1. **The cursor is `seq`, per log, durable across processes** — `after=<seq>` on
   one URL is live, late-join, reconnect and history (`call-log.md` "The cursor
   is the whole protocol"; `calls_api.py` `_attach_backlog` reads the store when
   the hot buffer moved on) **[verified]**. LangGraph legacy has a per-run 0-based
   index that dies with the process (lgwire §1.3, §2.2); LangGraph v2 has a
   connection-local `seq` + durable `event_id` and resumes by full replay +
   dedupe (lgwire §6); AG-UI has no cursor at all (ag-ui §3.3); Vercel has no
   cursor and replays from byte 0 out of the producer's memory (vercel §4.3).
2. **`log.gap` and `log.caught_up` are in-band control entries** with a `seq`
   that repeats the last seq delivered, dispatched by the reducer without being
   stored (`view.ts:361-376`) **[verified]**. No reference has either (lgwire "For
   Pinecall" 3-4; ag-ui §3.3; vercel "For Pinecall" 4).
3. **The vocabulary is closed, the envelope is fixed, unknown types are ignored**
   (`vendor/types.ts:24-28, 297-301`; `transport.ts applyFrame`) **[verified]** —
   and the server ALREADY emits types outside the TS union: every `PASSTHROUGH`
   row in `legacy_events.py` (`call.held`, `reply.rejected`, …) keeps the legacy
   name as the log `type` (`translate()` 313-326) **[verified]**. So "a type the
   client does not know" is today's normal, not a future case. Vercel does the
   opposite and throws on an unknown type (vercel §1) — we keep ours.

Everything below is "add a way to spell what we already have", never "change
what `seq`, the markers or the envelope mean".

---

## 1. SSE transport

### 1a. Wire shape

**Endpoint.** No new path. Content negotiation on the two GET cursors that exist
(ag-ui "For Pinecall" 3: "Negotiate, do not multiply endpoints" — their
`EventEncoder.getContentType()` picks by `Accept`, `encoder.ts:17-23`):

```
GET /v1/calls/{call}/events?after=<seq>[&types=…][&durable=1][&token=…]
GET /v1/agents/{slug}/calls?after=<seq>[&types=…][&token=…]
Accept: text/event-stream
```

- `Accept` contains `text/event-stream` → the response is a held-open SSE body:
  backlog, `log.caught_up`, live tail. Otherwise → today's JSON page, untouched
  (`calls_api.py:367-448`) **[verified]**. A bare `new EventSource(url)` sends
  `Accept: text/event-stream` by itself **[spec fact]**, and `?token=` is already
  accepted because `_credential()` falls back to the query string (`calls_api.py:170-175`)
  **[verified]** — so the zero-JS client works with no header it cannot set.
- Why not `GET /v1/attach`: the WS route is what carries the §7 supervise verbs
  (`_read_inbound`, `calls_api.py:846-872`); SSE is read-only by construction, so
  giving it the verb channel's name would promise a `send()` it cannot honour.
  Left as open question Q3.

**Frames** — every entry is one SSE event (lgwire §1.3, the JS dev server
`streamSSE.writeSSE({ id, event, data })`, `runs.mts:446-481`; lgmodes §8 for
`event:` = the mode; vercel §2 and ag-ui §2.1 write `data:` ONLY, which is what
we deliberately do NOT copy):

```
id: 12
event: user.message
data: {"seq":12,"ts":1786537584.38,"call":"CA…","agent":"bistro","type":"user.message","ephemeral":false,"data":{"id":"u1","text":"A table for two","final":true}}

```

- `id:` = the envelope's `seq`, decimal. For the minted markers it is their
  minted `seq` (`_gap_entry` → `max(after, resume_from-1)`; `_caught_up_entry`
  → last seq delivered) **[verified]** — both are "a cursor that is safe to
  resume from", which is exactly what `Last-Event-ID` must be.
- `event:` = the envelope's `type`, verbatim (`user.message`, `log.gap`,
  `custom`…). NOT namespaced with `|` (lgwire "For Pinecall" 9: namespace lives
  in the envelope's `call`/`agent`, never in the type string).
- `data:` = the FULL envelope, one line, `json.dumps(entry.to_dict(), separators=(",",":"))`
  — the same bytes `send_json` puts on the WS and the JSON page returns
  (`LogEntry.to_dict`, `call_log.py:110-118`) **[verified]**. The consumer's
  `applyFrame` therefore works unchanged on `data` (lgmodes "For Pinecall" 3:
  "filters must filter entries, never reshape them").
- First frame of every response: `retry: 1000` (one line, no data) so a vanilla
  `EventSource` reconnects in ~1 s instead of the browser default. **[spec fact]**
- Heartbeat: `: ping <unix-ts>\n\n` — an SSE **comment**, every
  `PING_INTERVAL_SECONDS` (25 s, the same constant the WS pump uses,
  `calls_api.py:67, 725`) **[verified]**. Copied from the Platform's `: heartbeat`
  (lgwire §1.3, `types.ts:198-200`): invisible to every SSE decoder
  (`sse.ts:129`; ag-ui `sse.ts:12`; vercel `parse-json-event-stream.ts`), visible
  to the idle watchdog that sits on the line stream (lgwire §2.4). NOT a data
  event like the WS `{"type":"ping"}` — on SSE a data ping would reach
  `applyFrame`. 25 s keeps one constant; the watchdog window is
  `clamp(3×25, 6, 30) = 30 s` either way (lgwire §2.4).
- Headers: `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-store`,
  `X-Accel-Buffering: no` (vercel §2, `UI_MESSAGE_STREAM_HEADERS` — the nginx
  no-buffering header is the one that matters behind our nginx), `Connection: keep-alive`.

**Cursor precedence** — three spellings, one meaning:

```
after = max(int(query.after or 0), int(header["Last-Event-ID"] or 0))
```

- `Last-Event-ID: n` means "serve n+1 onward" (lgwire §1.3 `ops.mts:105-115`;
  lgwire "For Pinecall" 1: "treat a Last-Event-ID header as an alias of after").
  Same meaning as `?after=n`. `max` because the header is only ever sent by a
  reconnecting `EventSource`, whose URL still carries the `after=` it was
  constructed with (stale by construction); a header can never be legitimately
  smaller than the URL's cursor from the same client. A malformed header is
  ignored (the decoder also ignores ids containing NUL, `sse.ts:82`).
- LangGraph's `"-1"` = "from the start" is NOT adopted on the wire; ours is
  `after=0` (lgwire "For Pinecall" 2). Document the equivalence in `call-log.md`.

**Lifecycle** — close semantics copied from "the logical terminator is in-band,
the transport end is punctuation" (vercel "For Pinecall" 4: `[DONE]` is nothing,
`finish` is not the end; `call.summary` is strictly stronger):

| situation | SSE response |
|---|---|
| call log, live | backlog → `log.caught_up` → tail; the body **ends after `call.summary`** is written (the seal sentinel `None` from the subscriber queue, `_pump_tail` 728-729) **[verified]**. No `[DONE]`, no `event: end`. |
| call log, sealed, `after < latest_seq` | replay the backlog (which ends in `call.summary`), `log.caught_up`, close. |
| call log, sealed, `after >= latest_seq` | **`204 No Content`**, no body. This is what stops `EventSource`: a clean close makes it reconnect with `Last-Event-ID` **[spec fact]**, and the 204 on that reconnect is the only way to tell it "done" (vercel §4.2, `http-chat-transport.ts:215-269`: `204` → `null` → no resume). |
| agent log | never closes (lifecycle log, `transport.ts isTerminal` returns false for agents) **[verified]**; heartbeats forever. |
| slow consumer | the subscriber is dropped by `CallLog._fan_out` (`call_log.py:284-316`) **[verified]**; the SSE writer ends the body. The client reconnects with its cursor — same as the WS `slow_consumer` close, minus the close reason (SSE has none). |
| auth / 404 | normal HTTP status before the body opens (today's JSON errors, `calls_api.py:387-408`) **[verified]**. |

`log.gap` / `log.caught_up` travel as ordinary frames with `event: log.gap` /
`event: log.caught_up` — nothing new; they are already full envelopes
(`_caught_up_entry` docstring) **[verified]**.

### 1b. Client API

`@pinecall/web/log` (`transport.ts`):

```ts
export type TransportKind = "auto" | "ws" | "sse" | "poll";   // was "auto" | "ws" | "poll"

/** Idle watchdog. `"auto"` arms after two heartbeats, window = clamp(3×cadence, 6s, 30s); n = fixed ms; 0 = off. */
export type IdleReconnect = "auto" | number | 0;

export interface CommonOptions extends LogTarget {
  token: string;
  server?: string;
  after?: number;
  onError?: (error: Error) => void;
  /** Server-side filter (§4). Unknown names are accepted and match nothing. */
  types?: readonly string[];
  /** Server-side filter (§4): skip ephemeral entries in the live tail. */
  durable?: boolean;
  /** Fires after every entry the view accepted (or could never store). Never throttled. */
  onEntry?: (entry: AnyLogEntry, state: Readonly<CallLogState>) => void;
  /** Fires once, when this observation ends for good. */
  onFinish?: (info: { reason: "summary" | "closed" | "error"; error?: Error; lastSeq: number }) => void;
}

export interface TailOptions extends CommonOptions {
  reconnect?: boolean;
  WebSocketImpl?: WebSocketFactory;
  onOpen?: (attempt: number) => void;
  onClose?: (info: { code?: number; reason?: string; willReconnect: boolean }) => void;
  /** Half-open detection. Default `"auto"`. */
  idleReconnect?: IdleReconnect;
}

export interface SseOptions extends CommonOptions {
  reconnect?: boolean;
  /** Injection seam. Defaults to global `fetch`. Must return a body `ReadableStream<Uint8Array>`. */
  fetchImpl?: FetchLike;
  onOpen?: (attempt: number) => void;
  onClose?: (info: { status?: number; willReconnect: boolean }) => void;
  idleReconnect?: IdleReconnect;
}

/** Attach over `GET …/events` with `Accept: text/event-stream`. Read-only: no `send()`. */
export function sse(view: LogSink, opts: SseOptions): LogTransport;

export interface ObserveOptions extends TailOptions, SseOptions, PollOptions {
  transport?: TransportKind;
  onDegrade?: (error: Error, to: "sse" | "poll") => void;   // `to` is new
}
```

- `sse()` is **fetch + `ReadableStream` + a ~60-line decoder**, not `EventSource`
  (lgwire §1.1 `SSEDecoder` + `BytesLineDecoder`, `sse.ts:9-160`; ag-ui §2.2 and
  vercel §2 are also fetch-based). Reasons, all from the reports: `EventSource`
  cannot send `Authorization` (we have `?token=`, but a Bearer from Node is the
  nicer spelling), hides `:` comments from JS (the watchdog needs them, lgwire
  §2.4), has no abort/backoff/jitter control, and fires `onerror` on every
  reconnect. The decoder copies the two facts lgwire §1.1 pins: `id:` is sticky
  across events; comment lines are dropped by the decoder but counted by the
  watchdog one stage earlier.
- **Resume**: the same URL with `after=<view.lastSeq>` (our contract,
  `transport.ts:280-284`) **[verified]** — `sse()` does NOT send `Last-Event-ID`;
  that header is for the zero-JS `EventSource` path. One cursor spelled the way
  the rest of the package spells it.
- **Backoff + jitter**: `min(1000·2^n, 15000) + rand(0, 1000)` ms. Base is
  ours (`transport.ts:198, 272`) **[verified]**; the jitter term is lgwire §2.3
  (`reconnect.ts:23-30`: `min(1000·2^(attempt-1), 5000) + rand(0,1000)`). Applied
  to `tail()` too (lgwire "For Pinecall" 6 — today `tail` has none). Keep
  `document.hidden` deferral exactly as `tail()` has it (`transport.ts:219-232`).
- **Idle watchdog** in both `tail()` and `sse()` — lgwire §2.4
  (`idleReconnectStream`, `stream.ts:137-220`): any frame (data or `: ping`)
  re-arms a timer; `"auto"` is dormant until two heartbeats were seen, then
  `clamp(3 × observed cadence, 6 s, 30 s)`; on trip close the pipe and reopen
  with the cursor. Fixes the half-open socket `tail()` cannot see today (it only
  reacts to `onclose`, `transport.ts:307-321`) **[verified]**. On WS the `{"type":"ping"}`
  data frame is the heartbeat (it already reaches `onmessage` and is ignored by
  `applyFrame` as an unknown shape) **[verified]**.
- **`observe({ transport: "auto" })`**: `ws` → degrade to `sse` → degrade to
  `poll`, each only when the previous pipe never delivered (the existing rule,
  `transport.ts:474-494`) **[verified]**. `Observation.kind` gains `"sse"`;
  `send()` on an SSE/poll observation returns `false` exactly as it does for
  poll today (`transport.ts:514-516`) **[verified]**.
- **`onFinish` trichotomy** is vercel "For Pinecall" 7 (`chat.ts:178-185`
  `isAbort | isDisconnect | isError`): `"summary"` = `call.summary` sealed the log
  (the one clean end), `"closed"` = the caller called `close()`, `"error"` = gave
  up (`reconnect:false` and the pipe died, or a terminal HTTP status).

### 1c. Copied from / deliberately different

| decision | copied from | different for voice because |
|---|---|---|
| `id:` = seq, `event:` = type, full envelope in `data:` | lgwire §1.3 (JS dev server), lgmodes §8 (`toEventStream`, `event:` = mode) | AG-UI and Vercel write `data:` only and their parsers drop `id:`/`event:` (ag-ui §2.2, vercel §2) — that forfeits `EventSource`'s free resume, which is the one thing a phone-call dashboard wants when a tab sleeps |
| `Last-Event-ID` = alias of `after=`, `max()` of both | lgwire §2.2 (`ops.mts:105-115` serves `+1`) | we keep `?after=` as the canonical spelling: our cursor is durable across processes, theirs is not, and `sse()`/`poll()`/`tail()` all spell it the same way |
| `: ping` comment heartbeat, 25 s | lgwire §1.3 (Platform `: heartbeat ~5 s`, inferred-from-client there) | same constant as our WS ping; window still clamps to 30 s |
| idle watchdog `"auto"` + jitter | lgwire §2.4, §2.3 | added to WS `tail()` too — backgrounded iOS WebViews are our half-open case (`transport.ts:19-23`) |
| no `[DONE]`, no `event: end`; body ends after `call.summary`; 204 on a sealed cursor | vercel "For Pinecall" 4 (`[DONE]` swallowed), vercel §4.2 (204 = nothing to resume) | `call.summary` is an in-band terminator with a seq; the transport end is punctuation |
| fetch-stream client, `EventSource` only as the zero-JS path | lgwire §1.1, ag-ui §2.2, vercel §2 (all three clients are fetch + parser) | — |
| negotiate on the existing GET, no new endpoint | ag-ui §2.1 `EventEncoder` (`Accept` → content type) | skip protobuf: AG-UI's own binary format covers 18 of 34 events and its client never asks for it (ag-ui §2.1) |
| SSE is read-only; verbs stay on WS | — (our §7 verbs, `calls_api.py:586-619`) | lgwire "For Pinecall" 11: an observer dropping must never touch the call; `cancel_on_disconnect` has no counterpart here |
| NOT copied: LangGraph `Location` header reconnect path (lgwire §2.3) | — | one URL is both the create and the rejoin; nothing to redirect to |

### 1d. Files to touch

**sdk-server** (`src/pinecall/server/handlers/calls_api.py`):
- `call_events()` (367-423) and `agent_calls()` (426-448): inspect
  `request.headers.get("accept")`; if it contains `text/event-stream` (use
  `starlette.requests.Request.headers` + a tiny q-value check, or exact
  substring — ag-ui vendors a negotiator, `media-type.ts:1-41`; we need only
  "contains") → return `_sse_response(...)`; else today's JSON.
- new `_sse_response(app, *, log, call_id, agent_id, after, filters) -> StreamingResponse`
  — builds the generator below with `media_type="text/event-stream"` and the
  headers in §1a. Precedent for `StreamingResponse` in this codebase:
  `server/handlers/sdk_api.py:328-365` **[verified]**.
- new `_sse_stream(log, subscriber, *, after, filters)` async generator: yields
  `retry: 1000\n\n`; then the body of `attach()` (subscribe-first, backlog via
  `_attach_backlog`, `_gap_entry`, entries, `_caught_up_entry`, then the pump)
  re-expressed as `yield _sse_frame(entry)` instead of `await websocket.send_json(...)`.
  Factor the shared sequence into `async def _replay_then_tail(log, subscriber, after, filters, emit)`
  so `attach()` (WS) and `_sse_stream()` share ONE ordering — the "subscribe
  before backlog" invariant (`calls_api.py:794-796`) must not be duplicated by
  hand.
- new `_sse_frame(entry: dict) -> str`: `f"id: {seq}\nevent: {type}\ndata: {json}\n\n"`.
- new `_sse_heartbeat() -> str`: `f": ping {time.time():.3f}\n\n"`, emitted from
  the same `asyncio.wait_for(queue.get(), timeout=PING_INTERVAL_SECONDS)` branch
  `_pump_tail` uses (721-726).
- cursor: `after = max(after_query, _last_event_id(request))` with a new
  `_last_event_id(request) -> int` (header parse, 0 on absent/invalid).
- sealed + `after >= log.latest_seq` → `Response(status_code=204)`.
- `server/app.py:436-452`: no change (same router, same prefix) **[verified]**.
- tests: `tests/` counterpart of the attach tests — frame shape, `id:` on every
  frame, `Last-Event-ID` precedence, heartbeat comment, close after
  `call.summary`, 204 on sealed cursor, agent log never closes.

**webrtc** (`src/log/`):
- `transport.ts`: `sse()`, `SseOptions`, `IdleReconnect`, `TransportKind` +
  `"sse"`, the decoder (`decodeSse(line)` / `BytesLineDecoder` port), the idle
  watchdog helper `armIdle()` shared by `tail()` and `sse()`, jitter in
  `scheduleReconnect()` (272), `observe()` degrade chain.
- `index.ts`: export `sse`, `SseOptions`, `IdleReconnect`.
- `react.tsx`: `transport` state type gains `"sse"` (59-61, 128-130).
- tests: `tests/log-transport-sse.test.ts` (mock fetch body; resume carries
  `after=`; comment lines arm the watchdog; jitter bounds), plus the existing
  tail tests gain the watchdog case.

**sdk**: no runtime code for §1 (the reducer is transport-blind). Docs only
(`docs/guides/call-log.md` "The wire API" table + a "Plain SSE" subsection with
the `new EventSource(url)` example and the `after=0` ≡ `Last-Event-ID: -1` note).

---

## 2. Custom entries: `call.log(name, value)`

### 2a. The verb's name

`call.log`. Not `call.emit`: `Call extends TypedEventBus<CallEvents>`
(`call.ts:79`) **[verified]** and already has an `emit()` for its own listeners —
overloading it to mean "append to the server log" would make one name do two
things on one object. Not `call.note`: it reads as free text, and the payload is
structured data (Vercel's `data-*`, AG-UI's `CUSTOM.value`, LangGraph's
`writer(value)` are all "any JSON", lgmodes §4, ag-ui §1.8, vercel §1). `log` is
the feature's own noun — the guide is titled "The Call Log" and the entry goes
into it. The risk that a reader thinks "console.log" is answered by the
signature returning nothing and the docs opening with "appends a durable entry
to this call's log, visible to every observer".

### 2b. Wire shape

**SDK → server** (the SDK client socket, same channel as every `call.*` verb in
`call.ts`, dispatched by `transports/client/handler.py` **[verified]**):

```json
{ "event": "call.log", "call_id": "CA…", "name": "crm.lookup",
  "value": { "customer": "c_42", "tier": "gold" },
  "id": "c_42",              // optional — the upsert key (§2d)
  "ephemeral": false }       // optional, default false
```

**Log entry** (what every observer sees, via WS, SSE, GET):

```json
{ "seq": 57, "ts": 1786537601.02, "call": "CA…", "agent": "bistro",
  "type": "custom", "ephemeral": false,
  "data": { "name": "crm.lookup", "value": { "customer": "c_42", "tier": "gold" },
            "id": "c_42", "turn": 4 } }
```

**Closed type `custom`, not open `x.<name>` types.** All five reports land on
ONE closed type whose payload is opaque; they disagree only on its name:
lgwire "For Pinecall" 9 (`event: custom` / `data: T`, `types.stream.ts:108`),
lgmodes "For Pinecall" 4 (`type: "custom"`, `data: {name, payload}`), ag-ui
"For Pinecall" 6 (`log.custom`, `{name, value}` — a 1:1 of `CUSTOM {name, value}`,
`events.ts:352-356`), vercel "For Pinecall" 1/8 (`call.log` type with
`data.kind` + `id`; "the equivalent of Vercel's `data-*` prefix without a
prefix"). The arguments that decide it:

- The reducer's `switch` is exhaustive with a `never` arm (`view.ts:792-796`)
  **[verified]** and `LOG_EVENT_TYPES` is a `Set` (`types.ts:304-333`). Open
  `x.<name>` types would be "unknown" to `isKnownLogEntry` and silently dropped
  by `apply()` (`view.ts:359-360`) — the user's entries would never reach
  `state`. To make them reach it the reducer would need a prefix rule, which is
  Vercel's `data-*` Zod escape hatch (vercel §1, `ui-message-chunks.ts:170-179`)
  — the one place their closed union leaks, and the thing the AG-UI adapter
  (ag-ui "For Pinecall" 1) would then need a table for.
- The user's `name` is already namespaced by being inside `data` — LangGraph
  keeps the mode under `type` and the user value under `data` (lgmodes §2 v2
  `CustomStreamPart {type:"custom", ns, data}`), and its one lesson from v1→v2
  is "never vary the shape by flags" (lgmodes "For Pinecall" 3).
- `types=custom` (§4) filters all of them with one token; `types=x.crm.lookup`
  would need prefix matching on the server.
- Name: `custom` — the word LangGraph (`"custom"` mode), AG-UI (`CUSTOM`) and
  Vercel (`{type:'custom'}` chunk, vercel §1) all use. `log.custom` would sit
  next to `log.gap`/`log.caught_up`, which are transport-minted control markers
  that the reducer never stores (`view.ts:361-376`); a user fact is not control.
- `data.value` rather than `data.payload`: AG-UI's exact key (`CUSTOM {name, value}`),
  so the adapter in ag-ui "For Pinecall" 1 is field-for-field. (`data.data` was
  ruled out by the envelope already having `data`.)

**Durable by default, `ephemeral: true` on request** — lgmodes "For Pinecall" 4
("strictly better than LangGraph, whose custom chunks are ephemeral", lgmodes §6)
and vercel "For Pinecall" 2 ("map `transient` onto our existing `ephemeral`
flag rather than inventing a third concept"). A durable `custom` entry goes
through `CallLog.append()` like any other (`call_log.py:199-219`): real `seq`,
hot buffer, `_notify_entry` → the persistence sink → replays from the store
**[verified]**. An ephemeral one shares the seq space, is fanned out live, never
buffered, never returned by `since()` (`call_log.py:207-210, 264-265, 350-368`)
**[verified]** — same as `bot.word`.

**Server stamps, caller cannot forge:** `seq`/`ts` (the append point), and
`data.turn` = the session's current turn id (`session.turn_manager.turn_id`;
`TurnManager` is constructed by both the WebRTC and the Twilio handlers,
`transports/webrtc/handler.py:762`, `transports/twilio/webhooks.py:791`)
**[verified for those two transports; chat/WhatsApp sessions: inferred — stamp
`turn` only when the session has a `turn_manager`]**. This is lgmodes "For
Pinecall" 6 ("stamp `data.turn` server-side, the way `prepare_single_task`
stamps `langgraph_step`; do not let the caller forge it"). The agent's own
identity is the envelope's `agent`; no `by` field (the supervise verbs carry
`by` because a human is acting, `calls_api.py:484`; here the agent is).

**Server validation** (none of the references validate — lgmodes §4 "no schema
and no size limit"; AG-UI `CUSTOM` "never verified", ag-ui §4.3; Vercel
validates only via optional `dataPartSchemas`, vercel §3.3 — so the numbers
below are ours, chosen against our hot buffer and the 256-entry subscriber
queue, `DEFAULT_QUEUE_MAXSIZE`, `call_log.py:61`) **[verified]**:

| rule | value | refusal |
|---|---|---|
| `name` | `^[a-z0-9][a-z0-9_.-]{0,63}$` (lowercase, dot-namespaced like the vocabulary itself) | `{"event":"error","error":"call.log: invalid name","call_id":…}` on the SDK socket (the shape `session.pause` uses, `handler.py:2136-2138`) **[verified]** |
| `value` | any JSON; serialized envelope ≤ **16 KiB** (`MAX_CUSTOM_BYTES`) | same error frame, `"call.log: value too large (N > 16384 bytes)"` |
| `id` | optional, `str`, ≤ 128 chars | same |
| `ephemeral` | optional bool | — |
| call | must resolve to a log (`get_or_create_call_log`) that is not sealed; a sealed log → `try_append` returns `None` → error frame `"call.log: call has ended"` | — |
| rate | none beyond the subscriber queue (a flood drops slow observers, never the call, `_fan_out`) — open question Q6 | — |

The refusal is a **transport frame to the SDK socket, never a log entry**
(the rule `_error_frame` already states for verbs, `calls_api.py:621-629`)
**[verified]**. The SDK surfaces it through the existing `error` event path
(`src/dispatch/handlers/error.ts`) — `call.log()` itself stays fire-and-forget
(`void`), like `loadSkill()`.

### 2c. Client API

**`@pinecall/sdk`** (`src/domain/call.ts`, next to `loadSkill`/`toolResult`):

```ts
export interface CallLogOptions {
  /** Upsert key for the reducer projection: a later entry with the same (name, id) replaces the value. */
  id?: string;
  /** Live-only: fanned out to observers, never buffered or persisted. Default false. */
  ephemeral?: boolean;
}

/**
 * Append a custom, durable entry to this call's log: `type: "custom"`,
 * `data: { name, value, id?, turn }`. Visible to every observer of the call
 * (dashboards, `useCall`, GET /v1/calls/{id}/events) and replayed on resume.
 * Fire-and-forget; server validation failures arrive as an `error` event.
 */
log(name: string, value: unknown, opts?: CallLogOptions): void {
  this.#send({
    event: "call.log",
    call_id: this.id,
    name,
    value,
    ...(opts?.id !== undefined ? { id: opts.id } : {}),
    ...(opts?.ephemeral ? { ephemeral: true } : {}),
  });
}
```

It is reachable from a tool because `tool.execute(args, call)` receives the
`Call` (`src/tool.ts:31, 57`; executed at `src/dispatch/handlers/tool.ts:173`)
**[verified]** — the "ambient context" LangGraph gets from `get_config()` is the
`call` parameter here; no contextvar machinery (lgmodes "For Pinecall" 4).

**`@pinecall/sdk/log` + vendored `@pinecall/web/log`** (`types.ts`, `view.ts`):

```ts
/** `custom` — the one open extension point; `value` is opaque to the reducer. */
export interface CustomData {
  name: string;
  value: unknown;
  /** Upsert key in the projection; absent → the entry's seq. */
  id?: string;
  /** Server-stamped turn id, when the session has turns. */
  turn?: number;
}
// LogDataMap gains:  "custom": CustomData;   LOG_EVENT_TYPES gains "custom".

/** One row of `state.custom`: the latest value per (name, id), in first-seen order. */
export interface CallCustomEntry<V = unknown> {
  name: string;
  id: string;          // `data.id ?? String(seq)`
  value: V;
  seq: number;         // seq of the entry that LAST set this value
  ts: number;
  turn?: number;
}
export interface CallLogState {
  …existing fields…
  /** Durable custom entries, upserted by (name, id). Ephemeral ones never land here. */
  custom: CallCustomEntry[];
}
```

**`@pinecall/web/log/react`** (`react.tsx`):

```ts
export interface UseCallOptions<Custom extends Record<string, unknown> = Record<string, unknown>>
  extends Omit<ObserveOptions, "call" | "agent" | "onEntry"> {
  call: string;
  enabled?: boolean;
  throttle?: number | boolean;                      // §3
  reconnectOnMount?: boolean | (() => CallCursorStorage);   // §3
  /** Every applied entry, in seq order, BEFORE React is notified; never throttled. */
  onEntry?: (entry: AnyLogEntry, state: Readonly<CallLogState>) => void;
  /** Typed view of `onEntry` for `custom` entries. Ephemeral ones arrive here and nowhere else. */
  onCustom?: <K extends keyof Custom & string>(name: K, value: Custom[K], entry: LogEntry<"custom", CustomData>) => void;
  onFinish?: (info: { reason: "summary" | "closed" | "error"; error?: Error; lastSeq: number }) => void;
}

export interface UseCallResult<Custom extends Record<string, unknown> = Record<string, unknown>>
  extends Omit<CallLogState, "custom"> {
  custom: Array<{ [K in keyof Custom & string]: CallCustomEntry<Custom[K]> & { name: K } }[keyof Custom & string]>;
  view: CallLogView; transport: "ws" | "sse" | "poll";
  send: (verb: SuperviseVerb) => boolean; close: () => void;
}

export function useCall<Custom extends Record<string, unknown> = Record<string, unknown>>(
  opts: UseCallOptions<Custom>,
): UseCallResult<Custom>;
```

Usage: `const s = useCall<{ "crm.lookup": { customer: string; tier: string } }>({ call, token });`
→ `s.custom` is typed, `onCustom("crm.lookup", v)` narrows `v`. The generic is
lghook "For Pinecall" 4 (the `Bag`/`GetCustomEventType` parameter,
`ui/types.ts:1021-1025`); the `~agentTypes` phantom on `pc.agent()` so that
`useCall<typeof agent>` infers the vocabulary is explicitly LATER (same bullet).

### 2d. Reducer semantics — upsert by `(name, id)` in the projection only

- The **wire stays append-only**: every `call.log` is its own entry with its own
  `seq`; nothing is edited in place. The upsert is a reducer projection: on a
  durable `custom` entry, `state.custom` finds the row with the same
  `name + "/" + (id ?? seq)` and **replaces `value` wholesale** (and `seq`, `ts`,
  `turn`), else appends. This is vercel "For Pinecall" 1 and 3
  (`process-ui-message-stream.ts:974-999`: `id` absent → append; `id` present →
  find `(type,id)` anywhere in the message, replace `data`; "keep `data`
  replacement wholesale, not merged" — a merge rule makes the final state depend
  on which entries were skipped). Replay and late join converge automatically
  because the replay IS the same sequence of upserts; Vercel only gets that by
  replaying from byte 0 (vercel §4.3).
- **Ephemeral `custom` never enters `state.custom`**, only `onEntry`/`onCustom`
  — Vercel's `transient` rule (vercel §3.3: "never enters `parts`; only `onData`
  sees it"). It also preserves our invariant "a replay of a finished call
  reproduces the same state as watching it live" (`view.ts:25-27`) **[verified]**:
  the store never has ephemerals, so state built from live must not contain them
  either.
- Dedupe by `seq` stays the only dedupe (`view.ts:379-380`) **[verified]** — a
  replayed ephemeral can only repeat if the same seq arrives twice, which the
  map swallows; Vercel's "transient parts re-fire on every resume with no dedupe
  key" (vercel §4.5) cannot happen here.
- The reducer must stay total: `custom` gets a `case` in `#step`; the `never`
  arm (`view.ts:792-796`) enforces that the two repos' copies both gain it.
- `_snapshot()` on the server (`calls_api.py:272-305`) **[verified]** gains
  `custom: [...]` (the same (name,id)-latest fold over the hot buffer / store
  page) so a gapped client lands with its custom state — ag-ui "For Pinecall" 5
  and 9 (hydrate from the gap snapshot; merge by key, never replace arrays).
  Today `view.ts:784-789` records the gap without hydrating; hydration is its
  own card (Q8).

### 2e. Copied from / deliberately different

| decision | copied from | different because |
|---|---|---|
| one closed type, payload opaque | lgwire FP9, lgmodes FP4, ag-ui FP6, vercel FP1/8 | — |
| `{name, value}` keys | ag-ui §1.8 `CustomEventSchema` | plus `id` (vercel `data-*.id`) and server `turn` (lgmodes FP6) |
| durable by default, `ephemeral` opt-in | lgmodes FP4 (LangGraph custom is ephemeral, §6); vercel FP2 (`transient` ≡ `ephemeral`) | ours replays; theirs does not |
| upsert by `(name,id)` in the reducer, replace wholesale | vercel §3.3, FP1, FP3 | wire stays append-only with `seq` — the upsert is a projection |
| ephemeral → callback only, not state | vercel §3.3 (`transient` → `onData`) | keeps replay === live |
| server validation (name charset, 16 KiB) | — (no reference validates; lgmodes §4, ag-ui §4.3) | we have a bounded hot buffer and a 256-entry subscriber queue to protect |
| `call.log()` lives on `Call`, reached from tools via the `call` parameter | lgmodes §4 (`writer` injected / `get_stream_writer()` ambient) | no contextvars: `tool.execute(args, call)` already passes it |
| NOT copied: pipe-namespaced `event` names (`custom|sub|graph`) | lgwire §4 `AsSubgraph` | a call has no nesting (lgmodes FP5) |
| NOT copied: AG-UI verify rules for `CUSTOM` | ag-ui §4.3 (always passes) | same outcome: the reducer never interprets `value` |

### 2f. Files to touch

**sdk** (source of truth for the reducer):
- `src/log/types.ts`: `CustomData`, `LogDataMap["custom"]`, `LOG_EVENT_TYPES` + `"custom"`.
- `src/log/view.ts`: `CallCustomEntry`, `CallLogState.custom`, `emptyState()`,
  the `case "custom"` upsert, a `custom` array copy in the structural-sharing
  spread (`view.ts:368-373, 389-394`), `FoldContext` index `customIndex: Map<string, number>`.
- `fixtures/call-log-golden.json`: add `custom` entries (durable, id upsert,
  ephemeral) so both repos assert the same bytes (`vendor/README.md` "Provenance").
- `src/domain/call.ts`: `log()` + `CallLogOptions`; `src/index.ts` export of the type.
- `docs/guides/call-log.md` (vocabulary list, a "Custom entries" section),
  `docs/guides/tools-and-functions.md` (the `call.log` inside a tool example),
  `CHANGELOG.md`.

**webrtc**: `src/log/vendor/{types,view}.ts` re-copied byte-for-byte
(`pnpm run log:sync-check`); `tests/fixtures/call-log-golden.json` re-copied;
`src/log/index.ts` exports `CustomData`, `CallCustomEntry`; `src/log/react.tsx`
generic + `onCustom` (§3 card carries the hook plumbing).

**sdk-server**:
- `transports/client/handler.py`: new `elif event_type == "call.log":` in the
  dispatcher (beside `skill.load`, 878-894) → `_handle_call_log(client_manager, websocket, call_id, message_data)`:
  validate (name regex, size), resolve `session` (already resolved above, 666-675)
  for `turn`, `log = client_manager.get_or_create_call_log(call_id, agent_id)`,
  `log.try_append("custom", {...}, ephemeral=bool(...))`, error frame on refusal.
  Append directly, not through `log_and_stamp()` — the tap is the outbound
  legacy-event path (`event_tap.py` docstring); inbound commands append directly,
  as the supervise verbs do (`calls_api.py:484, 500, 523`) **[verified]**.
- `session/call_log.py`: `AgentLog._record` already refuses non-lifecycle types
  (455-463) **[verified]** — no change; a `custom` entry can never reach the agent log.
- `server/handlers/calls_api.py` `_snapshot()`: `custom` fold.
- `session/legacy_events.py`: no row — `custom` is not a legacy event.
- tests: dispatcher unit test (valid/invalid/too large/sealed), `_snapshot` custom.

---

## 3. `useCall` / `useAgentCalls`: `throttle`, `reconnectOnMount`, callbacks

### 3a. `throttle`

```ts
/** Coalesce React notifications. `true` (default) = one macrotask; `n` = at most one per n ms (leading + trailing); `false` = every entry. */
throttle?: number | boolean;
```

- **Where**: around the subscribe function handed to `useSyncExternalStore`
  (`react.tsx:63-67, 132-136`) **[verified]** — never in `CallLogView`, so
  framework-free consumers keep every tick (lgwire FP8, lghook FP1). The reducer
  still applies every entry synchronously; only the notification is coalesced —
  the rule all three hooks share (lghook §5 `manager.ts:647-680`; vercel §3
  `chat.react.ts:111-122` "the reducer always runs at wire speed").
- **`true` = one macrotask** (`setTimeout 0`, trailing): copied verbatim from
  lghook §5 — one SSE chunk / one WS burst → one render.
- **number = real throttle, leading + trailing**: NOT LangGraph's
  `clearTimeout`+`setTimeout` debounce, which starves the UI under a fast stream
  (lghook §5 "debounce-starvation with a numeric value"; lghook FP1). Vercel uses
  `throttleit` (leading+trailing) (vercel §3). `bot.word` at speech rate is
  exactly the fast stream that would starve a debounce.
- **Default `true`**, written in ONE place (`UseCallOptions`), and the doc quotes
  it — lghook FP10: LangGraph documents `@default true` and codes `false`
  (`stream.lgp.tsx:214` vs `ui/types.ts:1269-1275`).
- `getSnapshot` stays `() => view.state` (the snapshot rule in `react.tsx:9-19`)
  **[verified]**; a render triggered by anything else already shows the newest
  state mid-throttle (lghook §5, last bullet).
- Unsubscribe clears the pending timer (lghook §5).
- Same option on `useAgentCalls`; its `useMemo(() => agentCalls(view.entries()))`
  (`react.tsx:165`) **[verified]** then recomputes once per coalesced batch.

### 3b. `reconnectOnMount`

```ts
interface CallCursorStorage {
  getItem(key: `pc:log:${string}`): string | null;
  setItem(key: `pc:log:${string}`, value: string): void;
  removeItem(key: `pc:log:${string}`): void;
}
/** `true` = `window.sessionStorage`; a function returns any 3-method storage. */
reconnectOnMount?: boolean | (() => CallCursorStorage);
```

- **Shape copied** from lghook §2/§4.1 (`reconnectOnMount?: boolean | (() => RunMetadataStorage)`,
  `ui/types.ts:1241, 1315-1319`; `true` → `window.sessionStorage`,
  `stream.lgp.tsx:183-190`). The template-literal key type is theirs too.
- **What is persisted is different and better** (lgwire FP7, lghook FP2):
  key `pc:log:<call>` for a call log, `pc:log:agent:<slug>` for an agent log;
  value `JSON.stringify({ seq, ts })`. LangGraph stores only the `run_id` and
  rejoins with `Last-Event-ID: -1` — full replay — because it has no cursor
  (lghook §4.4). We have `seq`.
- **When read**: inside the effect that opens the observation (`react.tsx:75-94`)
  **[verified]**, not once per mount — so a tile mounted with `enabled:false`
  and enabled later still resumes (lghook FP9). Seed: if `opts.after` is
  undefined AND `view.lastSeq === 0` AND the stored `ts` is younger than 24 h →
  `observe(view, { …, after: stored.seq })`. A warm view (`lastSeq > 0`) ignores
  storage — the view's own cursor is fresher (`transport.ts cursor()`, 150-152)
  **[verified]**.
- **When written**: write-through on every applied entry — `setItem` inside the
  same throttled notification (§3a), so it costs one write per render, not per
  entry (lghook FP2 "or throttled with #1").
- **When cleared**: when `call.summary` is applied (`state.metrics.summary` set /
  `!state.live` after summary) — their `onSuccess → removeItem`
  (`stream.lgp.tsx:630, 721`). Also on a stored `ts` older than 24 h (ignore and
  remove). The agent log key is never cleared by content (the log never ends);
  TTL only. On `close()` by the caller: keep it (a page reload after an
  intentional close is still "the same session coming back").
- **Not copied**: the one-shot `shouldReconnect` latch per thread
  (`stream.lgp.tsx:756-774`) — a join is a separate request there; our
  `tail()`/`sse()` already reconnect with the cursor, the stored value is only
  the seed of the FIRST open (lghook FP2). Not copied: the error path that leaves
  the key in place forever (lghook §4.2) — TTL covers it.
- A stored `seq` the server can no longer serve → `log.gap` with snapshot, the
  path that already exists (`_attach_backlog`, `_gap_entry`) **[verified]**;
  LangGraph silently degrades to "tail from now" (lgwire §2.2).

### 3c. `onEntry` / `onCustom` / `onFinish` — ordering

- **Fire per applied entry, in seq order, before React is notified, never
  throttled** — lghook §9.1 ("callbacks fire before the state write … event
  callbacks are not throttled — only React notifications are"); ag-ui §4.4
  (subscribers run before the reducer's default handling; the catch-all
  `onEvent` with the reduced state after it, ag-ui FP7); vercel §3.3 (`onData`
  fires for every data chunk, transient or not).
- **Our ordering**: `view.apply(entry)` → if it returned `true`, OR the entry is
  never storable (ephemeral `custom`; an unknown `type`) → `onEntry(entry, view.state)`
  and, for `type === "custom"`, `onCustom(name, value, entry)`. Never for a
  seq duplicate (so a resume overlap does not re-fire). The callback sees the
  state AFTER the entry (ag-ui FP7) — we skip LangGraph's `mutate` and AG-UI's
  `stopPropagation`/mutation return (lghook FP3: "a callback that wants to add
  state should `view.apply()` a local ephemeral entry instead"; ag-ui FP7: "a
  subscriber seam, not middleware").
- **Where it lives**: in `transport.ts`, as a `LogSink` decorator
  (`withListeners(view, { onEntry, onCustom })`) wrapped around the view before
  it is handed to `tail()`/`sse()`/`poll()` — so all pipes share one ordering
  (lghook FP3, the single event loop at `manager.ts:792`). The hook just
  forwards its options. Keep the callbacks in a `latest` ref (already the
  pattern, `react.tsx:72-73`) **[verified]**; vercel §5 (`use-chat.ts:74-122`).
- `onFinish({ reason })` — §1b; fires once from the hook's effect cleanup or
  from the transport's terminal path.

### 3d. Files to touch

**webrtc**:
- `src/log/react.tsx`: `UseCallOptions`/`UseAgentCallsOptions` gain `throttle`,
  `reconnectOnMount`, `onEntry`, `onCustom`, `onFinish`; `useThrottledSubscribe(view, throttle)`
  helper wrapping `view.subscribe` (63-67, 132-136); cursor-storage helpers
  `readCursor(key)`, `writeCursor(key, seq)`, `clearCursor(key)`; seed logic in
  the effect (75-94, 142-161); generic `Custom`.
- `src/log/transport.ts`: `withListeners()` sink decorator; `onEntry`/`onFinish`
  on `CommonOptions`; `types`/`durable` threaded into the URLs (§4).
- `src/log/index.ts`: export `CallCursorStorage`.
- tests: `tests/log-react.test.ts` (throttle coalesces N applies into 1 render;
  numeric throttle does not starve; `reconnectOnMount` seeds `after=`; key
  cleared on `call.summary`; `onEntry` order vs render; `onCustom` receives
  ephemeral customs).

**sdk**: `docs/guides/call-log.md` "The browser client" — the three options,
and `docs/guides/build-a-live-call-app.md` uses `reconnectOnMount: true`.
`webrtc/CHANGELOG.md`.

---

## 4. Server-side filters: `types=` and `durable=1`

### 4a. Wire shape

On all three read surfaces (`WS /v1/attach`, `GET …/events` JSON and SSE,
`GET …/agents/{slug}/calls`):

```
?types=user.message,tool.call,tool.result,custom     comma-separated, ≤ 32 names, each ^[a-z0-9_.-]{1,64}$
?durable=1                                           skip ephemeral entries in the LIVE tail
```

- **Applied at the subscriber's sink, never at the append path**: in
  `_pump_tail` (one `if` before `send`, 731-735) and on the backlog list from
  `_attach_backlog` (post-read, pre-send), and on the JSON page before
  serialising — lgmodes FP1 ("filter at the producer, per subscriber …
  the filter belongs on the Subscriber and in `_pump_tail` / `_attach_backlog`,
  never on `append`"), the precedent being LangGraph's `_emit` early return
  (lgmodes §1) and v2's `{channels, since}` filter at the sink
  (lgwire §6 `protocol.mts:167-174`, `service.mts:847`; lgwire FP10).
- **`seq` is never renumbered.** A filtered tail has holes in the client's view
  by request; the cursor is the log's (lgmodes FP1). `log.caught_up.data.seq`
  still reports the last seq the server walked, filtered or not.
- **Always pass, regardless of filter**: `log.gap`, `log.caught_up`,
  `call.ended`, `call.summary`. The markers are control (lgmodes FP1: "like
  LangGraph's `isCheckpointEnvelope` bypass"); `call.summary` is the terminator
  (`live=false`, `view.ts:499-511`); `call.ended` is added because it is what
  sets `state.live=false` and the `disconnect` intent (`view.ts:486-497`)
  **[verified]** that every transport uses to stop (`transport.ts isTerminal`,
  190-194) **[verified]** — a `types=tool.call` client would otherwise tail a
  dead call until `call.summary`, and show `phase` ≠ `"ended"` in between. (This
  is one type more than the card's list; the reason is above.)
- **`durable=1`**: `if entry.ephemeral and durable_only: continue` in
  `_pump_tail` (lgmodes FP2 — "one `if`"). The backlog never has ephemerals
  (`since()` strips them, `call_log.py:350-351`; the store never receives them,
  `append` 213-214) **[verified]**, so the flag only changes the live tail and the
  SSE tail. Documented as a bandwidth knob, not a semantic one: the durable
  entry that supersedes an ephemeral always follows (`call-log.md` "The entry
  envelope") **[verified]**. Spelled positively (`durable=1`) rather than
  `ephemeral=0` so the default is the absent flag.
- **Unknown type names are accepted and match nothing** — forward-compatible
  in the same direction as the client's "unknown types are ignored" (§0.3): a
  newer client may name a type an older server does not know. Only the shape
  (count, charset) is refused, with the WS `_refuse` text /
  HTTP 400 (`calls_api.py:687-695`) **[verified]**.
- **Not copied**: `namespaces`/`depth` from the v2 filter (lgwire FP10: a call
  log is flat); LangGraph's `stream_mode` re-validation on join (lgwire §2.1 —
  the JS dev server ignores it); Vercel has no server-side filter (vercel FP10);
  AG-UI has none either.
- On the agent log `types=` is legal and lifecycle-only anyway (`AGENT_LOG_TYPES`,
  `call_log.py:69`) **[verified]**; `useAgentCalls` need not send it.

### 4b. Client API

```ts
// transport.ts CommonOptions (all pipes):
types?: readonly string[];     // → `&types=a,b,c`
durable?: boolean;             // → `&durable=1`
```

Both are in the hook effects' dependency lists (`react.tsx:94, 161`) — they
address a different stream (lgmodes FP10). The derivation LangGraph does from
"which getters were read" (lghook §3 `trackStreamMode`, lghook FP8) is NOT
copied — explicit options; a dashboard knows what it renders.

### 4c. Files to touch

**sdk-server** (`calls_api.py`):
- new `@dataclass(frozen=True) class Filters: types: frozenset[str] | None; durable: bool`
  with `_parse_filters(params) -> tuple[Filters | None, str | None]` (shape
  validation) and `Filters.allows(entry: dict) -> bool` (the always-pass set
  `_ALWAYS_PASS = frozenset({"log.gap","log.caught_up","call.ended","call.summary"})`).
- `attach()`: parse, `_refuse` on error; pass into `_attach_backlog` consumer
  and `_pump_tail(websocket, subscriber, last_seq, filters)`.
- `_pump_tail`: after `last_seq = entry.seq` (734), `if not filters.allows(d): continue`
  — advance the cursor BEFORE filtering so a skipped entry is not resent, then
  `send_json`.
- backlog: `backlog = [e for e in backlog if filters.allows(e)]` before the
  send loop (811-813); `last_seq` must still follow the UNFILTERED last seq
  (the caught-up marker's seq = last seq walked), so compute it from the
  unfiltered list.
- `call_events()` / `agent_calls()`: same parse; filter `body["entries"]` (the
  gap entry passes); `next` cursor stays the unfiltered last seq.
- SSE (§1) uses the same `Filters` through `_replay_then_tail`.
- tests: filtered tail keeps seq; markers and `call.ended`/`call.summary` pass;
  `durable=1` drops `bot.word` live; bad `types=` refused; unknown names accepted.

**webrtc**: `transport.ts` URL builders (`open()` 282-284, `poll` 380, `sse()`)
+ `CommonOptions`; hooks' effect deps. **sdk**: docs table in `call-log.md`
"The wire API".

---

## 5. Ordered implementation cards

Order rationale (the orchestrator rule in `~/.claude/CLAUDE.md`): the shared
seam — the vocabulary — lands first and serialized, because the webrtc copy is
byte-identical to the sdk source and both reducers must gain `custom` in one
step; then server features that the clients consume; then the clients; docs
last, quoting defaults from code. Boards: sdk cards on this board; sdk-server
and webrtc cards on each repo's own board (they are separate git repos — the
top-level `CLAUDE.md`), or on this board with the repo named in the card if
those repos have no board.

1. **`custom` in the vocabulary and the reducer** — repo `sdk`. Add `CustomData`,
   `LogDataMap["custom"]`, `LOG_EVENT_TYPES`, `CallCustomEntry`,
   `CallLogState.custom`, the `case "custom"` upsert (replace `value` wholesale
   by `name/(id??seq)`; ephemeral never stored), golden fixture entries. Files:
   `src/log/types.ts`, `src/log/view.ts`, `fixtures/call-log-golden.json`,
   `tests/log-*.test.ts`. Spec §2c–2d.
2. **Re-vendor the reducer** — repo `webrtc`. Copy `types.ts`/`view.ts`/golden
   byte-for-byte from card 1's commit, update `vendor/README.md` provenance,
   `pnpm run log:sync-check` green, export `CustomData`/`CallCustomEntry` from
   `src/log/index.ts`. Depends on 1.
3. **`call.log` command → `custom` entry** — repo `sdk-server`. Dispatcher
   branch in `transports/client/handler.py`, validation (name regex, 16 KiB,
   id ≤ 128), `turn` stamp from `session.turn_manager.turn_id` when present,
   `try_append("custom", …, ephemeral=…)`, error frame on refusal; `_snapshot()`
   gains `custom`. Tests. Spec §2b, §2f. Independent of 1–2 (the server does not
   know the TS union).
4. **`Call.log()` in the SDK** — repo `sdk`. `log(name, value, opts)` on
   `src/domain/call.ts`, `CallLogOptions` exported, unit test on the frame sent,
   `docs/guides/call-log.md` "Custom entries" + `tools-and-functions.md`
   example, `CHANGELOG.md`. Depends on 3 for an end-to-end test only.
5. **Server-side filters** — repo `sdk-server`. `Filters` + `_parse_filters`,
   applied in `_pump_tail`, the attach backlog, `call_events`, `agent_calls`;
   always-pass set; cursor stays unfiltered. Tests. Spec §4. Independent.
6. **SSE on the GET cursors** — repo `sdk-server`. `Accept` negotiation in
   `call_events`/`agent_calls` → `_sse_response`; `_replay_then_tail` shared
   with `attach()`; `_sse_frame` (`id:`/`event:`/`data:`), `retry: 1000`,
   `: ping` every 25 s, `Last-Event-ID` = `max()` with `after`, body ends after
   `call.summary`, 204 on a sealed cursor, agent log never closes. Tests. Spec
   §1a, §1d. Depends on 5 (shares `Filters`).
7. **`@pinecall/web/log` transports v2** — repo `webrtc`. `sse()` + decoder,
   `IdleReconnect` watchdog in `tail()` and `sse()`, jitter in
   `scheduleReconnect`, `observe` chain `ws → sse → poll` (+ `onDegrade(err, to)`),
   `types`/`durable` on `CommonOptions` threaded into URLs, `withListeners()`
   sink decorator (`onEntry`/`onCustom`), `onFinish`. Tests. Spec §1b, §3c,
   §4b. Depends on 2; end-to-end on 5–6.
8. **`useCall` / `useAgentCalls` ergonomics** — repo `webrtc`. `throttle`
   (`true` = macrotask, number = leading+trailing, default `true`),
   `reconnectOnMount` (`pc:log:<call>` / `pc:log:agent:<slug>` → `{seq,ts}`,
   seed in the effect, write-through per render, clear on `call.summary`,
   24 h TTL), `onEntry`/`onCustom`/`onFinish` forwarded, generic `Custom`,
   `transport: "sse"`, `s.custom`. Tests. `webrtc/CHANGELOG.md`. Spec §3.
   Depends on 7.
9. **Docs + knowledge base** — repo `sdk`. `docs/guides/call-log.md`: wire
   table (SSE row, `types=`/`durable=1`, `Last-Event-ID`), "Plain SSE" with
   `new EventSource(url)`, "Custom entries", hook options quoting the defaults
   from `react.tsx`; `build-a-live-call-app.md` uses `reconnectOnMount`;
   `docs.json` if a page is added; then the `knowledge-base` skill's re-train
   flow. Depends on 4, 8.

Suggested parallelism: {1} → {2, 3, 5} → {4, 6, 7} → {8} → {9}.

---

## 6. Open questions for Bernardo

1. **Verb name**: `call.log(name, value, opts)` as argued in §2a — or do you
   want `call.note`/`call.record`/`call.mark`? (`emit` is taken by the event bus.)
2. **Type and keys**: `type: "custom"`, `data: {name, value, id?, turn}` (§2b).
   Alternatives considered: `log.custom` (next to the control markers — argued
   against), `app.log` (lgwire FP9), `data.payload` instead of `data.value`.
3. **SSE endpoint**: Accept-negotiation on `GET /v1/calls/{id}/events` and
   `/v1/agents/{slug}/calls` (§1a), or ALSO a `GET /v1/attach` alias for
   symmetry with the WS? FastAPI allows a GET and a WS on one path; I left it
   out because `/attach` is the verb channel's name.
4. **SSE joins WS, does not replace it** (§1b `observe` chain `ws → sse → poll`;
   verbs stay on WS). Confirm — or should `"auto"` prefer SSE over WS for
   observe-only tokens (no verbs possible anyway), saving the Upgrade handshake
   behind proxies that mangle it?
5. **Defaults**: `throttle: true` (§3a); `reconnectOnMount: false`
   (LangGraph's default; opt-in because it touches `sessionStorage`);
   `idleReconnect: "auto"` for both `tail()` and `sse()`; SSE `retry: 1000`;
   heartbeat 25 s shared with WS; cursor TTL 24 h.
6. **Limits on custom entries**: 16 KiB per entry, no per-call count or rate
   limit (§2b) — should they count toward any plan limit, storage quota, or a
   per-call cap (e.g. 10 000 custom entries, then refused)? The persistence
   sink stores every durable one (`log_persistence.py`), so a chatty tool
   grows the stored log; today nothing else in the log is user-controlled.
7. **Always-pass set for filters** includes `call.ended` in addition to the
   card's `log.gap`/`log.caught_up`/`call.summary` (§4a) — agree?
8. **Gap-snapshot hydration** (ag-ui FP5/FP9): `_snapshot` grows `custom` here,
   but the reducer still records a gap without hydrating from the snapshot
   (`view.ts:784-789`). Separate card, or fold into card 1?
9. **`reconnectOnMount` storage**: `sessionStorage` (LangGraph's choice —
   survives reload, dies with the tab) vs `localStorage` (survives the tab; a
   stale cursor is harmless because of `log.gap`). I chose `sessionStorage`
   + 24 h TTL.
10. **Agent-phantom typing** (`useCall<typeof agent>` inferring the custom
    vocabulary from `call.log` calls, lghook FP4/§9.3): explicitly later —
    agree it is not in this batch?

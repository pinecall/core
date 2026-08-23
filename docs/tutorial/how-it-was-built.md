---
title: "How it was built"
description: "The build log behind the tutorial — four versions, the designs that were rejected at each step, the patterns that were borrowed instead of invented, and the bugs only a real call and a real build exposed."
---

# How it was built

[The tutorial](/tutorial/configurable-agent) shows the finished shape in the order that
makes sense to read. It was not built in that order. It was built **five times**, each
version rejected for a specific reason, and the reasons are more useful than the result.
The fifth one is the most useful of all, because it is the first version that had to
undo a mistake the earlier ones had already solved.

## Version 1 — packages, processes and a client for everything

The first cut had `apps/agent/`, `apps/ui/` and two shared packages, `config-store` and
`domain`, with the rule "no Pinecall import in `packages/`". It worked. It was 1,200
lines, most of them comments explaining the architecture — which is the tell: code that
needs that much explaining is the wrong code. The review was one sentence long and not
polite.

What survived from it: the line between settings and code, and the first two real
bugs (below).

## Version 2 — three apps, one API, SSE between processes

`apps/api` (Hono, owner of the data), `apps/agent` (a client of the API, no port),
`apps/ui` (React Router, loaders against the API). No shared code at all. 377 lines.
The agent learned about a saved setting through **Server-Sent Events from the API** — an
`EventSource` in Node, three lines with the `eventsource` package.

Cleaner, and it still had a smell: `apps/agent/api.mjs`, a forty-line "client" whose
four functions were one-line `fetch` wrappers. A layer that exists to justify itself.

It also had the design cost of being three processes: three ports, two `.env` files with
the same key, and `concurrently` to start them. For a tutorial, three terminals to
explain before the first call.

## Version 3 — one process, folders by type

Collapse to one app: `server.mjs`, `agent/`, `api/`, `models/`, `app/`. One `.env`,
one port, `npm run dev`. The agent-to-API SSE disappeared — same process, the agent
listens to an in-process `EventEmitter` directly — and SSE moved to where it is
genuinely useful: **server → browser**, so the call page could show the transcript and
the agenda live.

This was good and it was still organised by *type*. To understand appointments you
opened `models/appointment.mjs`, `api/routes.mjs` and `app/routes/call.jsx`. Three
folders for one idea.

## Version 4 — borrowed, not invented

Before the fourth rewrite, the question was asked properly: *what do the reference
codebases do?* Three answers changed the layout.

**React Router's [custom-server template](https://github.com/remix-run/react-router-templates/tree/main/node-custom-server).**
`server.js` boots. `server/app.ts` is Express plus the RR handler, and Vite bundles it
together with the routes. `server/` means "Node-only, starts with the process" — an
exact description of the agent. That settled where the agent lives without an
argument.

**Feature-first folders** — the layout that has replaced `models/ controllers/ routes/`
across most of the ecosystem, and that Epic Stack's move to config-based routing
enables: the URL map lives in `app/routes.ts`, so files can be grouped by what they do.
`app/settings/`, `app/appointments/`, `app/calls/`, each holding its model, its page,
its API.

**Resource routes.** A route file with a `loader`/`action` and no component *is* a JSON
endpoint. Express stopped being a router and became the mount only. The SSE endpoint is
a loader that returns a `Response` wrapping a `ReadableStream` — 28 lines.

481 lines, 20 files, `tsc` clean.

And this is the version that was shipped, deployed, and copied into another repo — so
its one flaw travelled with it.

## Version 5 — the line, drawn for real

Version 1's rule was "no Pinecall import in `packages/`", and it had `packages/domain`
holding the rules with no I/O under them. That rule was thrown out with version 1's
1,200 lines of architecture comments — and it should not have been, because it was the
only part of version 1 that was right.

Without it, "the agent lives in `server/` because that is Node-only code" quietly became
"the agent may import whatever it likes", and the import graph ended up like this:

```
server/agent/agent.ts  ──imports──►  app/appointments/model.server.ts
                       ──imports──►  app/calls/model.server.ts
                       ──imports──►  app/settings/model.server.ts
                       ──imports──►  app/lib/bus.server.ts
```

A voice agent importing four modules out of the React Router folder. It works — the
`.server.ts` suffix keeps them out of the browser bundle — but the boundary was being
held up by a **build convention**, not by the code. And `app/calls/page.tsx` imported
`Call`, the model, with its disk access, into the same file as the React components,
for the same reason.

Version 5 moves the business back out, and names each piece after what it is:
`src/clinic` (pure rules), `src/storage` (persistence behind an interface, plus the
composition root that binds the rules to it), `src/agent` (prompt, tools, config, wire,
log), `src/bus`, and `src/web` — the React Router app, reduced to the web app and
nothing more, mounted as the framework's `appDirectory`. `src/server.ts` is the
process. Same product, same UI, same `db.json`, same prompt — the compiled CSS is
byte-for-byte identical. What changed is that the inner three folders import no
framework at all, the clinic returns what happened instead of emitting on a global bus,
and `eslint.config.js` fails the build the moment an arrow points the wrong way:

```
web  ──►  agent  ──►  clinic  ──►  storage
```

The first four versions asked nicely. This one does not ask.

Four things came out of it that were not on the plan:

- **`db.server.ts` was a `Proxy` that parsed the whole file on every read and did
  `load()` + `writeFileSync` on every write.** `Call.line()` runs on every confirmed
  transcript line, so a three-minute call rewrote `db.json` dozens of times, and a
  process killed mid-write left it truncated. `src/storage` holds the truth in memory,
  serializes writes through a promise queue, debounces them, and lands each one with
  write-tmp + `rename`, which POSIX makes atomic.
- **The "lost update" that motivated the rewrite could not actually happen.** The old
  `set` did its `load()` and its `writeFileSync` in the same tick, so it always
  rebuilt the file from the newest picture. The loss appears the moment the write stops
  being synchronous — which is any store that does not block the event loop. The test
  suite reproduces the old implementation with an `await` between the read and the
  write, watches it drop a writer, and then runs the same scenario against the new
  store. A bug worth fixing; a diagnosis worth correcting.
- **The live panel kept one call.** `on("turn")`, `on("user.speaking")` and
  `on("bot.word")` never compared the call id, so while two calls overlapped, the
  second one's words were painted into the first one's transcript. It is a
  `Map<callId, LiveCall>` now, and every handler matches on the id it was handed.
- **Two `EventSource`s per tab.** The live panel opened one and the history opened
  another — two streams and two sets of bus listeners per tab, for one page. There is
  one now, refcounted in `src/web/hooks/useEvents.ts`.

1,400 lines in 39 files, plus 500 in tests, `tsc` clean. Sources are listed at the end.

> **Version 6, later: the live panel left the process.** Both of the last two bugs
> were bugs *of an in-process event bus relayed to the browser* — a thing that
> exists because the transcript was only in this process's memory. It is not:
> every call already has an append-only, seq-stamped
> [log](/guides/observe-calls) on the voice server, and the browser can read it
> with a read-only token. `/api/events`, `bus.onAny` and `useEvents.ts` were
> deleted; `useAgentCalls` + `useCall` replaced them, one observation per call
> id, and a page reload now resumes from the stored `seq` instead of showing an
> empty panel. The bus survives one event wide — `settings`, the one fact that
> really is in-process. The `Map<callId, …>` lesson survived too: it is the
> hook's `key`.

## Three designs that were rejected on the way

### A server inside the agent

Give the agent an HTTP endpoint; the console `POST`s to `/reload`. It works, and it
makes the agent a service — something has to be able to reach it. The agent should be a
process that connects *out*, like every other Pinecall agent.

### Polling

Read the settings file every few seconds, compare a timestamp. Twelve lines and a few
seconds of lag on every edit. Written, then thrown away once the obvious thing was said
out loud: in SSE the **agent is the client** — an outbound connection is not a server.
(And in the final version the question evaporates: same process, same `EventEmitter`.)

### Configuring from the console's own process

Since the console has the API key, let *it* call `agent.update()`. Impossible, and
knowing exactly why is worth more than the tutorial: `agent.update()` writes to the
WebSocket **the agent opened**. Only the process holding that socket can reconfigure
it. Minting a browser token, by contrast, is just an HTTP call carrying the key — any
trusted server can do it. The two look alike and are opposites.

## The bugs only a real call found

**It spoke markdown.** The first transcript came back with `🙂` and a booking reference
in backticks. "Sin listas ni markdown" in the prompt was not enough, because it named a
format, not a reason. What worked was telling the model what happens to its output:
*"Todo lo que digas se lee en voz alta"*, followed by the consequences — no lists, no
emoji, codes digit by digit. The same call read six free slots in a row; that one was
fixed in the **tool**, which now returns three. The model offers what you hand it.

**It confirmed an appointment that did not exist.** In version 1 the book was a `Map` at
module scope, and the agent and the console were two processes — each had its own copy.
The agent booked into its memory; the console rendered from a different, untouched one.
Nothing errored. The call sounded perfect. The rule: anything two processes share must
live somewhere both can see. In version 4 there is one process and one file, and the
tool calls `Appointment.create()` directly.

**The bot's lines did not stream.** The live transcript showed the patient and not the
agent. `bot.finished` (with `call.currentBotText`) is how a voice reply completes —
TTS streams it word by word. On chat there is no TTS; the whole reply arrives in
`bot.speaking`. The agent now listens to both and de-duplicates by `messageId`.

## The bug only a real *browser* call found — and it was not in the app

The page showed the patient's lines and none of the agent's. The agent process logged
`call.started`, `user.message`, `turn.end`, `call.ended` — and not one `bot.*`. The
SDK documents `agent.on("bot.speaking")`, the server's WebRTC transport emits it to the
SDK, the SDK forwards call events to the agent. Every piece looked right in isolation.

The instrument that settled it: `PINECALL_LOG=./pinecall.log`, which makes the SDK
write **every wire frame it receives**. (It did nothing at first — the SDK's file
logger reaches for `require`, which an ESM bundle does not have, and falls back to a
no-op in silence. `globalThis.require ??= createRequire(import.meta.url)` before the
client is built, and it writes.) The log of one browser call:

```
76  bot.word        ← received
 4  bot.speaking    ← received
 4  bot.finished    ← received
15  user.speaking   ← received
 3  user.message    ← received AND handled
 6  turn.end        ← received AND handled
```

The frames were arriving. Comparing one of each kind:

| frame | keys | reached `agent.on(...)` |
|---|---|---|
| `user.message`, `turn.end`, `llm.tool_call` | `agent_id`, `call_id`, `phone_number`, … | yes |
| `bot.speaking`, `bot.word`, `bot.finished`, `user.speaking` | `call_id`, `session_id`, … **no `agent_id`** | **no** |

Every SDK dispatch handler opens with `if (!wire.agent_id) return false`. The server has
two ways to talk to an agent: the pipeline's `EventBus` → `emit_to_call`, which stamps
`agent_id` on its way out, and the transport's direct `emit_to_client(app_id, event)`,
which did not. WebRTC's `bot.*` and `user.speaking` take the second road. So they
reached the socket and were dropped — for every WebRTC agent that ever listened for
them.

Two lines in `sdk-server` (`emit_to_client` now stamps `agent_id` exactly like
`emit_to_call`), a test, a deploy. The lesson is the method, not the fix: **when the
events do not arrive, log the wire before you touch the handlers.**

**And the first *phone* call showed the greeting twice.** One solid bubble with the
whole greeting, and under it a faded one growing word by word with the same text. The
phone transport sends `bot.speaking` *with the full text up front* (WebRTC sends it
empty), and the agent was treating "`bot.speaking` with text" as a final line — a rule
generalised from chat, where it is the only signal there is. The clean rule is the one
the official widget already follows: **the bot's line is what has been said.** On voice,
`bot.speaking` opens a draft, `bot.word` grows it, `bot.finished` closes it from
`call.currentBotText`; on chat, `bot.speaking` is the line. Keyed on `call.transport`,
and the `messageId` de-duplication set that papered over the symptom goes away.

Three smaller things the same calls taught:

- **An English voice speaking Spanish sounds like a tourist.** `elevenlabs/sarah` with
  `language: "es"` is exactly that. The default is now a native es-ES voice
  (`elevenlabs/carolina-2`) and the form offers only native ones.
- **The SSE endpoint crashed the server on hang-up.** When the tab closed, the
  `ReadableStream` was cancelled but the loader's `request.signal` never fired, so the
  bus listener kept writing into a closed controller — an exception inside an
  `EventEmitter` listener, which is an uncaught exception, which is the process gone.
  Handle `cancel()` as well as `abort`, and let a failed `enqueue` unsubscribe.
- **The ready-made widget hid all of this.** `<VoiceWidget>` shows a transcript from
  the DataChannel, so the browser side looked fine while the agent side was blind. The
  page now drives `VoiceSession` itself and shows both views; "it works in the widget"
  and "the agent received it" are different claims.

## The bugs only a real build found

**The database moved.** The store resolved `db.json` relative to the module with
`import.meta.url`. In development that is the project root; bundled, the module lives
in `build/server/assets/`, so production read a file that did not exist and served the
defaults — `sarah` while the form said `valentina`. Resolve against `process.cwd()`,
which is what `src/config.ts` does now, in the one place the path is written down.

**The agent did not start until the first visitor.** The official template loads the
server module lazily, inside the request handler. Fine for a web app; for a phone
agent it means nobody is answering until someone opens the browser. One
`await vite.ssrLoadModule("./src/server.ts")` at boot fixes it.

**Hot reload registered a second agent.** Vite re-evaluates `src/server.ts` on a change
to anything it imports, and a second `pc.agent("dental-desk")` in the same process is
refused by the server. `remember("agent", startAgent)` — a handful of lines in
`src/remember.ts` that keep one instance on `globalThis`, the pattern Epic Stack ships
as `@epic-web/remember` — and the same for the event bus and the store, so a reload
never leaves the agent subscribed to a stale emitter or two stores taking turns
overwriting the file. (The first cut was a bare `declare global` +
`globalThis.__agent ??=` in the server module; it worked and it read like plumbing. The
helper is the same five characters of semantics with a name.)

## What it cost

| | |
|---|---|
| Repository | ~40 files, ~1,400 lines, plus 5 test files and ~500 lines · `tsc` clean, `eslint` clean, 45 tests |
| Processes | 1 |
| Pinecall surface | `pc.agent()`, `agent.update()`, `tool()`, `createToken()`, `VoiceSession`, fifteen agent events |
| Lines that make it configurable | `agentConfig()` (12, half of them constants) · `bus.on("settings", …)` (1) · the form's `action` (4) |
| Lines that make the page live | none of ours: `useAgentCalls` + `useCall` read the [call log](/guides/observe-calls) over SSE, and `call.log()` writes the bookings into it |
| The rule that keeps it honest | `no-restricted-imports`, one override per folder: `web → agent → clinic → storage`, and nothing imports `src/web` |

Making an agent configurable from a UI is not a framework feature. It is one function
that decides which settings may move, one `agent.update()` when they do, and a clear
answer to "where does the agent live" — which, it turned out, the React Router template
had already half given. The other half took five versions: the template says where
*framework* code goes, and says nothing about the clinic. The agent belongs with the
clinic, and neither of them belongs inside the web app.

## Sources

- [react-router-templates / node-custom-server](https://github.com/remix-run/react-router-templates/tree/main/node-custom-server)
- [React Router — Resource Routes](https://reactrouter.com/how-to/resource-routes)
- [React Router decision 0011 — `routes.ts`](https://github.com/remix-run/react-router/blob/main/decisions/0011-routes-ts.md)
- [Epic Stack — routing discussion](https://github.com/epicweb-dev/epic-stack/discussions/962)
- [Vertical Slice Architecture in Node.js](https://thetshaped.dev/p/vertical-slice-architecture-in-nodejs-typescript-one-folder-per-use-case)
- [AdonisJS — folder structure](https://docs.adonisjs.com/guides/folder-structure)

## What's next

- [An agent your customer can configure](/tutorial/configurable-agent) — the tutorial itself
- [Hot-Reload](/concepts/hot-reload) — the mechanism the whole design rests on
- [Multi-Tenant Dashboards](/guides/multi-tenant) — where this app goes next

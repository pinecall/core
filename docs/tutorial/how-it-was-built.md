---
title: "How it was built"
description: "The build log behind the tutorial — four versions, the designs that were rejected at each step, the patterns that were borrowed instead of invented, and the bugs only a real call and a real build exposed."
---

# How it was built

[The tutorial](/tutorial/configurable-agent) shows the finished shape in the order that
makes sense to read. It was not built in that order. It was built **four times**, each
version rejected for a specific reason, and the reasons are more useful than the result.

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

481 lines, 20 files, `tsc` clean. Sources are listed at the end.

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

## The bugs only a real build found

**The database moved.** `db.server.ts` resolved `db.json` relative to the module with
`import.meta.url`. In development that is the project root; bundled, the module lives
in `build/server/assets/`, so production read a file that did not exist and served the
defaults — `sarah` while the form said `valentina`. Resolve against `process.cwd()`.

**The agent did not start until the first visitor.** The official template loads
`server/app.ts` lazily, inside the request handler. Fine for a web app; for a phone
agent it means nobody is answering until someone opens the browser. One
`await vite.ssrLoadModule("./server/app.ts")` at boot fixes it.

**Hot reload registered a second agent.** Vite re-evaluates `server/app.ts` on a change
to anything it imports, and a second `pc.agent("dental-desk")` in the same process is
refused by the server. `remember("agent", startAgent)` — four lines that keep one
instance on `globalThis`, the pattern Epic Stack ships as `@epic-web/remember` — and
the same for the event bus, so a reload never leaves the agent subscribed to a stale
emitter. (The first cut was a bare `declare global` + `globalThis.__agent ??=` in
`server/app.ts`; it worked and it read like plumbing. The helper is the same five
characters of semantics with a name.)

## What it cost

| | |
|---|---|
| Repository | 20 files, 481 lines, `tsc` clean |
| Processes | 1 |
| Pinecall surface | `pc.agent()`, `agent.update()`, `tool()`, `createToken()`, `<VoiceWidget>`, five agent events |
| Lines that make it configurable | `config()` (12, half of them constants) · `bus.on("settings", …)` (1) · the form's `action` (2) |
| Lines that make the page live | `events.ts` (28) · the agent's five `agent.on` relays · one `EventSource` |

Making an agent configurable from a UI is not a framework feature. It is one function
that decides which settings may move, one `agent.update()` when they do, and a clear
answer to "where does the agent live" — which, it turned out, the React Router template
had already given.

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

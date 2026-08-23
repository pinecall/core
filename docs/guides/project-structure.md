---
title: "Project Structure"
description: "How to lay out a Pinecall app so it reads like a system diagram — the business, the storage, the agent, the web — and when to split it into several processes."
---

# Project Structure

A Pinecall app is four things, and the folders should say so: **the business**
(your rules), **the storage** (how they persist), **the agent** (the voice), and
**the web** (pages and JSON, if you have any). Name the folders after those
nouns, keep the dependency arrows pointing inward, and the code reads like the
diagram. This is the layout of
[`dental-desk`](/tutorial/configurable-agent), the reference app, and it is what
we recommend you start with — one process, one repo.

```
my-app/
├── src/
│   ├── clinic/          the BUSINESS — pure rules, zero I/O, zero framework
│   │   ├── appointments.ts    availability(), book()
│   │   ├── settings.ts        defaults + apply()
│   │   ├── calls.ts           the call log
│   │   └── events.ts          the ONE typed catalogue of events
│   ├── storage/         HOW it persists — Store (interface), JsonStore, MemoryStore
│   │   └── index.ts           the composition root: the store, and the rules bound to it
│   ├── agent/           the VOICE AGENT
│   │   ├── prompt.ts          the prompt, with {{vars}} the settings fill in
│   │   ├── tools.ts           tool() definitions — thin, they call clinic/
│   │   ├── config.ts          settings → the agent's config (voice, greeting, llm, stt, tools)
│   │   ├── wire.ts            SDK events → clinic/ + bus — receives its collaborators, so it is testable
│   │   └── index.ts           startAgent(): pc.agent() + wire()
│   ├── web/             the UI (React Router)
│   │   ├── routes.ts          URL → file; routes/ mirrors the URL tree
│   │   ├── root.tsx · app.css
│   │   ├── routes/            settings.tsx · calls.tsx · api/{settings,appointments,availability,events,token}.ts
│   │   ├── components/        Bubble · Phase · CallTranscript · BrowserCall · AgentLive · …
│   │   └── hooks/useEvents.ts one EventSource per tab, refcounted
│   ├── bus.ts           the typed emitter over clinic/events
│   ├── config.ts        SLUG, PHONE, DB_FILE, PORT — one place
│   └── server.ts        THE process: config → storage → agent → web handler → listen
├── server.js            six lines: dev → Vite, prod → build/
├── .env                 PINECALL_API_KEY — and nothing else
└── package.json
```

Call `clinic/` whatever your business is — `orders/`, `fleet/`, `patients/`.
The other three names stay. The whole app, file by file, is
[`dental-desk`](https://github.com/pinecall/examples/tree/main/dental-desk).

## The rule: arrows point inward

```
web  ──►  agent  ──►  clinic  ──►  storage (the interface)
```

- `clinic/` imports nothing outside itself. It is handed a `Store`; it never
  picks one. You can test it with a list in your hand.
- `storage/` implements the interface. Its `index.ts` is the one place an arrow
  points back out — somebody has to bind the rules to a store — and it says so.
- `agent/` imports `clinic/` and `storage/`. It never imports `web/`, React or
  React Router; it must run from a test or a cron with no web app around.
- `web/` may import anything. It is the outermost ring.

**Enforce it.** A boundary that is only a convention breaks the first time
somebody is in a hurry — in `dental-desk` the agent ended up importing three
models and the bus out of the framework's folder, and nobody noticed because
nothing was watching. One ESLint `no-restricted-imports` rule per folder turns
the arrow into a build failure. Keep the lint to that one thing: a lint that
reports forty opinions is a lint people stop reading.

## The rules inside the folders

### The business returns; the caller announces

```ts
// src/clinic/appointments.ts — pure. No disk, no bus, no clock it does not own.
export function book(appointments: readonly AppointmentRow[], input: NewAppointment): AppointmentRow {
  if (!availability(appointments, input.date).slots.includes(input.time)) {
    throw new Error(`${input.date} ${input.time} is not available`);
  }
  return { ...input, reference: reference(input.date, input.time) };
}
```

`book()` does not emit an event. The route that booked, or the tool that
booked, is the one that tells the world — the rules do not know a bus exists.
That is what keeps them testable in one hand.

### One typed catalogue of events

```ts
// src/clinic/events.ts — the only place an event is declared
export type Events = {
  "settings":     SettingsRow;
  "appointment":  AppointmentRow;
  "call.started": CallRow;
  "transcript":   { id: string } & Line;
};
```

The bus is typed over it, the SSE route iterates its keys, the browser types
its payloads. Adding an event is one line in one file, and a typo is a compile
error instead of a silent listener.

### Storage: the truth in memory, written atomically

Load once at boot, keep the truth in memory, serialise writes through a queue,
write `tmp` then `rename` (atomic on POSIX), debounce the chatty writes and
flush on `call.ended` and on `SIGTERM`. A read-modify-write against the file on
every event is how you lose the last quarter second of a call on shutdown. A
`Store` interface is what lets `JsonStore` become SQLite in one file when a
second process needs the data.

### The agent: wiring receives its collaborators

```ts
// src/agent/wire.ts — SDK events → the business + the bus
export function wire(agent: Agent, { bus, log, flush }: Deps) { /* … */ }
```

`wire()` is passed the bus and the logger; it does not import them. That is the
difference between "given `bot.finished`, exactly one transcript line is
written" being a unit test and being a live call.

### `.env` holds `PINECALL_API_KEY`, and nothing else

Everything about the agent — model, voice, STT, greeting, phone number — lives
in `src/agent/config.ts` and `src/config.ts`, where it is diffable and reviewed.
The env file exists because a credential cannot be committed. If `.env` grows a
second row of agent config, that config has escaped code review.

The one legitimate second variable is the **dev slug**: `pc.agent()` hot-reloads
the live agent, so running the file locally against a production key retargets
production. `DENTAL_DESK_SLUG=dev-me npm run dev` — and empty `PHONE` with it, or
your laptop takes the production number. See [Dev Mode](/guides/dev-mode).

### Phone lines live with the agent

A [phone line](/guides/phone-lines) — `pc.line()`, the number that answers with
code before any agent — is part of the voice layer, not the web layer:
`src/agent/line.ts` (or `src/lines/` when there are several). It reads the same
`config.ts` and hands calls to the agent in the same process.

### The token route is a web route

The browser connects straight to `voice.pinecall.io`; the only thing your
backend does is mint a short-lived token. In one process that is
`src/web/routes/api/token.ts`, reading `SLUG` from `src/config.ts` so a slug
rename is one edit. When the agent becomes its own process (below), the token
route moves with the agent — it is the one piece of HTTP that must agree with
the agent's slug and hold the API key.

## When one process stops being enough

Start with one process. Split when one of these is true, not before:

| signal | what it means |
|---|---|
| The web and the agent deploy on different cadences, and a web deploy dropping calls in flight is a real cost | The agent becomes its own process. |
| You have several agents with nothing in common but the SDK | One folder per agent, one process each — two agents in one process share a crash, a deploy and a restart. |
| Another service needs the data | `storage/` swaps the JSON file for a real database behind the same `Store` interface. |

### Two processes: what it looks like

This is [`bistro`](https://github.com/pinecall/examples/tree/main/bistro), the
reference app for the standalone topology. The same four nouns, under the same
`src/` — the difference between one process and two is **a second entry
file**, not a monorepo:

```
bistro/
├── src/
│   ├── kitchen/        the BUSINESS — reservations.ts · settings.ts — pure rules
│   │   └── index.ts        createKitchen(store): the rules bound to a Store
│   ├── storage/        HOW it persists — store.ts (interface) · sqlite.ts (WAL) · index.ts (this process's handle)
│   ├── agent/          the VOICE — prompt.ts · tools.ts · config.ts · watch.ts · index.ts · main.ts (the process)
│   ├── web/            the HOST STAND — React Router: routes.ts · root.tsx · routes/ · components/
│   ├── server.ts       the host-stand process: Express in front of React Router
│   ├── config.ts       SLUG, PHONE, PORT, DB_FILE — read by both
│   └── remember.ts
├── agent.js            PROCESS 1 → src/agent/main.ts     a Pinecall process — no port, no HTTP
├── server.js           PROCESS 2 → src/server.ts         never imports src/agent
├── Procfile            web + agent
└── package.json        one
```

Three things change when you cross that line, and they are the whole
difference:

1. **Storage becomes a real database.** A JSON file with the truth in memory is
   one truth per process — which is two truths. `bistro` uses SQLite in WAL mode
   (`node:sqlite`, no native build) behind the same `Store` interface the
   one-process app had; the swap is one file.
2. **The processes never talk.** The agent is a Pinecall process and nothing
   else — no HTTP of its own, no endpoint the web calls. The host stand writes
   settings to the database; the agent **watches the row** (`src/agent/watch.ts`,
   one read a second) and `agent.update()`s itself when the stamp moves. Tokens
   are minted by the web process with `createToken()` — it reads the same
   `.env`. The database is the fact.
3. **The web observes through the [call log](/guides/call-log), never through
   the agent.** The browser mints a stream token (`/api/token`) and attaches to
   the voice server directly: `useAgentCalls()` for which calls exist,
   `useCall()` for the transcript. No SSE from the agent, no socket between the
   processes, nothing that a redeploy of the web app can interrupt.

And one more line in the lint: **`src/web` and `src/server.ts` never import
`src/agent`.** A web deploy that restarted the agent would defeat the split.

Because the folders were already the nouns, this is a move, not a rewrite:
`agent.js` goes next to `server.js`, and `storage/` swaps its store. See
[Deployment Topologies](/concepts/deployment-topologies).

## What's next

- [An agent your customer can configure](/tutorial/configurable-agent) — the
  one-process reference app (`dental-desk`)
- [Build a live call app](/guides/build-a-live-call-app) — the two-process
  reference app (`bistro`)
- [Phone lines](/guides/phone-lines) — the number that answers with code
- [Dev Mode](/guides/dev-mode) — prod and dev agents on the same number
- [Deployment Topologies](/concepts/deployment-topologies) — embedded, standalone, headless

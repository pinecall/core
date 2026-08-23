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
│   ├── agent/           the VOICE AGENT — prompt.ts · tools.ts · config.ts · wire.ts
│   ├── web/             the UI — routes.ts · routes/{settings,calls,api/*} · components/ · hooks/
│   ├── bus.ts           the typed emitter over clinic/events
│   ├── config.ts        SLUG, PHONE, DB_FILE, PORT — one place
│   └── server.ts        THE process: config → storage → agent → web handler → listen
├── server.js            six lines: dev → Vite, prod → build/
├── .env                 PINECALL_API_KEY — and nothing else
└── package.json
```

Call `clinic/` whatever your business is — `orders/`, `fleet/`, `patients/`.
The other three names stay.

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

| signal | what to do |
|---|---|
| The web and the agent deploy on different cadences, and a web deploy dropping calls in flight is a real cost | The agent becomes its own process: `apps/agent/` and `apps/web/`, with `src/clinic` + `src/storage` promoted to `packages/<domain>/` that both import. The token route goes with the agent. |
| You have several agents with nothing in common but the SDK | One folder per agent under `apps/`, one process each — two agents in one process share a crash, a deploy and a restart. |
| Another service needs the data | `storage/` swaps `JsonStore` for a real database behind the same `Store` interface. |

Because the folders are already the nouns, this is a move, not a rewrite:
`clinic/` + `storage/` become the package, `agent/` and `web/` become the apps.
A monorepo for 47 files is ceremony; a monorepo for two deployables is the
right tool. See [Deployment Topologies](/concepts/deployment-topologies) for
the trade-offs of each shape.

## What's next

- [An agent your customer can configure](/tutorial/configurable-agent) — the
  reference app, built in this shape
- [Phone lines](/guides/phone-lines) — the number that answers with code
- [Dev Mode](/guides/dev-mode) — prod and dev agents on the same number
- [Deployment Topologies](/concepts/deployment-topologies) — embedded, standalone, headless

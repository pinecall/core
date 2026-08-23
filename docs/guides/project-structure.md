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
│   │   ├── calls.ts           the app's own archive of past calls
│   │   └── events.ts          the typed catalogues: the bus, and what call.log() writes
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
│   │   ├── routes/            settings.tsx · calls.tsx · api/{settings,appointments,availability,token}.ts
│   │   ├── components/        Bubble · Phase · CallTranscript · BrowserCall · AgentLive · LiveCall · …
│   │   └── lib/token.ts       the two tokens the browser is given (talk, and watch)
│   ├── bus.ts           the typed emitter over clinic/events — one event wide
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

### Two typed catalogues, and they are not the same thing

```ts
// src/clinic/events.ts — the only place either is declared
export type Events = {                    // the in-process bus
  "settings": SettingsRow;
};

export type CallLog = {                   // what call.log() writes into the call's log
  "appointment.booked": AppointmentRow;
  "appointment.refused": { date: string; time: string; reason: string };
};
```

The bus is typed over `Events`; `useCall<CallLog>` is typed over the other, so
`s.custom` is a union of typed rows and `onCustom` narrows `value` on `name`.
Adding either is one line in one file, and a typo is a compile error instead of
a silent listener.

**Keep the bus narrow.** A fact about a *call* does not belong on it: the call
log already gives it a `seq`, replay, history and a reader in any process, and
an in-process emitter would be a second, worse copy that dies with the process.
`dental-desk`'s bus is **one event wide** — `settings`, with one listener, the
agent. Everything else the browser needs it reads from the log. See
[Observe calls](/guides/observe-calls).

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

**Almost nothing.** The split is a second entry file: `agent.js` → the voice
process, `server.js` → the web process, the four nouns unchanged with the
business and the storage moved under a `shared/` folder both import. One
`package.json`, two lines in a Procfile, no monorepo and no workspaces. Two
things actually change, and they are the whole difference: **storage becomes a
real database** (a JSON file with the truth in memory is one truth per process,
which is two truths — the same `Store` interface over SQLite in WAL mode is one
new file), and **the two processes never talk** (the web app writes settings to
the database, the agent watches the row and `agent.update()`s itself; tokens are
minted by whichever process holds the API key). The lint gains one line:
`agent/` and `server/` never import each other.

What does **not** change is the live panel. The browser was already reading the
[call log](/guides/observe-calls) with a stream token, straight from the voice
server — it never depended on sharing a process with the agent, so the same
component, the same hooks and the same token route work on both sides of the
split. That is the point of observation being a read: the topology stops being
an observability decision. See
[Deployment Topologies](/concepts/deployment-topologies).

## What's next

- [An agent your customer can configure](/tutorial/configurable-agent) — the
  one-process reference app (`dental-desk`)
- [Build a live call app](/guides/build-a-live-call-app) — the same app with the
  live console, end to end
- [Observe calls](/guides/observe-calls) — how the web layer watches a call
- [Phone lines](/guides/phone-lines) — the number that answers with code
- [Dev Mode](/guides/dev-mode) — prod and dev agents on the same number
- [Deployment Topologies](/concepts/deployment-topologies) — embedded, standalone, headless

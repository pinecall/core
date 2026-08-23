---
title: "An agent your customer can configure"
description: "Build a voice agent for a dental clinic that answers both a phone number and the browser, whose settings are edited from a web console, and whose call page moves by itself — one React Router app, one process."
---

# An agent your customer can configure

Every voice agent you ship for someone else runs into the same wall. The clinic wants
a different greeting. The receptionist wants a different voice. Opening hours change
in August. None of that is your job, and all of it currently requires you to edit a
file and redeploy.

This tutorial builds the way out: a dental clinic's receptionist that **answers a
phone number and the browser as one agent**, whose settings live in a web console the
clinic operates, and whose call page **moves by itself** — the transcript appears line
by line while somebody is on the phone, and the call drops into the history, with
everything it said, the moment it hangs up.

One React Router app, one process, one `.env`. The finished code is the
`dental-desk/` app in [**github.com/pinecall/examples**](https://github.com/pinecall/examples)
— about 1,400 lines in 39 files, plus 500 more in tests.

## The line this tutorial is really about

Elsewhere in these docs, [Project Structure](/guides/project-structure) is blunt:
everything about the agent — model, voice, STT, number, greeting, prompt — belongs in
the agent file, where it is diffable and reviewable. Config that escapes code review is
config nobody can reason about.

A configurable agent breaks that rule on purpose, so it had better break it precisely:

| | Lives in | Who changes it |
|---|---|---|
| Name, greeting, voice, language, hours, services | the database | the clinic, from a form |
| Model, STT provider, which tools exist | `src/agent/config.ts` · `src/agent/tools.ts` | you, in a pull request |

The first row is what a receptionist would change if they could. The second is made of
decisions with consequences for latency, cost and quality — a text box is the wrong
place for them. The code keeps that line in one function, `agentConfig(settings, tools)` — the top
half of the object it returns reads from the settings, the bottom half is constants.

## The shape

```
src/
├── clinic/            THE BUSINESS — pure rules: availability · booking · the call log · settings
│   └── events.ts      the typed catalogue — the ONE place an event is declared
├── storage/           HOW IT PERSISTS — db.json behind an interface, in memory, written atomically
│   └── index.ts       the composition root: the store, and the clinic bound to it
├── agent/             THE VOICE AGENT — prompt · tools · config (settings → SDK config) · wire · log
├── web/               THE REACT ROUTER APP (appDirectory)
│   ├── routes.ts         the whole surface, URL → file
│   ├── routes/           settings.tsx · calls.tsx · api/{settings,appointments,availability,token}.ts
│   ├── components/       Bubble · Phase · CallTranscript · PastCall · BrowserCall ·
│   │                     AgentLive · LiveCall · LiveTimeline · LoggedFact · …
│   └── lib/token.ts      the two tokens the browser is given: one to talk, one to watch
├── bus.ts             a typed emitter over clinic/events.ts — one event wide
├── config.ts          slug · phone number · port · db path
└── server.ts          THE process: Express, the React Router handler, and startAgent()

server.js              the process entry — Vite in dev, the build in prod. Nothing else.
```

Four decisions, each borrowed rather than invented.

**Every top-level folder is a noun, and the arrows between them point one way:
`web → agent → clinic → storage`.** The clinic's rules — when it opens, that two
people cannot have the same slot — are not the website's rules, and the voice agent has
nothing to do with React Router. So the business, its storage and the agent are three
folders that import no framework at all, and `src/web` is only the web app. This is not
a convention: `eslint.config.js` is one override per folder and it fails the build if
anything reaches back out into `src/web`, and CI runs it. The first version of this repo
asked nicely instead, and within a month the agent was importing three models and the
event bus out of the framework's folder.

**The mount is React Router's own
[custom-server template](https://github.com/remix-run/react-router-templates/tree/main/node-custom-server).**
`server.js` boots; `src/server.ts` is Express plus the RR request handler and is
*bundled by Vite together with the routes*, so the agent, the clinic and the pages share
one module graph — one process, one bus, one store. `src/server.ts` is the only file
that is neither business nor page: it is the mount, and it starts the agent.

**Files are named after the one thing in them.** Open `src/clinic/appointments.ts` and
the whole of appointments is in it; open `src/web/routes/` and the folder tree is the
URL tree. The practical effect is that "where is X?" always has the same answer.

**The API is resource routes.** A React Router route file with a `loader` and/or
`action` and no component *is* a JSON endpoint. There is no second router to learn:

```ts
// src/web/routes/api/settings.ts — GET and PUT /api/settings, the entire file
export const loader = () => Response.json(Settings.get());

export const action = async ({ request }: Route.ActionArgs) => {
  const settings = Settings.update(await request.json());
  bus.emit("settings", settings); // the agent listens: the next call is born with it
  return Response.json(settings);
};
```

(The clinic does not announce anything by itself — `Settings.update()` returns the new
settings and the caller emits. That is what lets `src/clinic` stay free of the bus, and
it is why the agent's booking tool emits for itself too.)

And the map of it all fits on one screen:

```ts
// src/web/routes.ts
export default [
  index("routes/settings.tsx"),
  route("call", "routes/calls.tsx"),
  ...prefix("api", [
    route("settings", "routes/api/settings.ts"),
    route("appointments", "routes/api/appointments.ts"),
    route("availability", "routes/api/availability.ts"),
    route("token", "routes/api/token.ts"),
  ]),
] satisfies RouteConfig;
```

## 1. The agent

`src/agent/config.ts` builds the whole configuration in one function of the settings.
Four lines deserve a note.

```ts
// src/agent/config.ts
export const agentConfig = (s: SettingsRow, tools: Tool[]) => ({
  greeting: s.greeting,               // ── from the form
  voice: s.voice,
  language: s.language,
  promptVars: vars(s),

  prompt: PROMPT,                     // ── from a pull request
  timezone: "Europe/Madrid",
  llm: "openai/gpt-5.4-nano",
  stt: "deepgram/flux",
  tools,
  phoneNumber: PHONE,                 // undefined → browser only
});
```

`src/agent/index.ts` is where that meets the process — the only file in `src/agent/`
that touches the real SDK, the real bus and the real store:

```ts
// src/agent/index.ts
const tools = createTools({ appointments: Appointment, calls: Call, bus, log: consoleLog });
const config = (settings: SettingsRow) => agentConfig(settings, tools);

const pc = new Pinecall();
const agent = pc.agent(SLUG, config(Settings.get()));

wire({ agent, calls: Call, bus, log: consoleLog, config, flush: () => void store.flush() });
```

**`stt: "deepgram/flux"`** — Flux detects the end of a turn inside the STT stream:
no separate voice-activity model, no added latency. Set this and **do not set
`turnDetection` or `vad`**; the server derives both, and overriding them by hand is how
agents end up interrupting people. See [Turn Detection](/concepts/turn-detection).

**`timezone`** — the built-in `{{date}}` and `{{time}}` resolve in the clinic's zone,
on every channel, with no round-trip. Without it, "¿a qué hora abren?" is answered
against the server's clock.

**`phoneNumber`** is the entire telephony setup. There is no webhook to configure.

**`agentConfig(settings, tools)`** is the line from the top of this page, made
executable — and because it is *one* function, the same call that creates the agent is
the call that updates it (step 3). No spread, no "base config plus overrides". It takes
the tools as an argument rather than importing them, which is the same reason it takes
the settings: a function that receives its world can be checked without one.

**`SLUG`** comes from `src/config.ts` (`process.env.DENTAL_DESK_SLUG ?? "dental-desk"`).
Two checkouts cannot register the same agent id, and the deployed one owns
`dental-desk` — so a local clone points itself at `dev-<you>` without editing a file
that would then be committed.

**The voice has to be native.** The first build used `elevenlabs/sarah`, an English
voice, with `language: "es"` — it spoke Spanish with a tourist's accent. The catalogue
has forty-odd native Spanish voices (`pinecall voices --language es`, or `list_voices`
in the MCP); the default is now `elevenlabs/carolina-2` (es-ES) and the form only
offers native ones. `language` picks the STT and the TTS model; it does not fix a
voice's accent.

The agent is started once per process, from `src/server.ts`:

```ts
// src/server.ts
import { startAgent } from "~/agent";
remember("agent", startAgent);
```

`remember` is a handful of lines in `src/remember.ts`: keep one instance on
`globalThis`, create it the first time only. It is not decoration. In development Vite
re-evaluates `src/server.ts` on a hot reload, and an agent registered twice under the
same slug is refused by the server. The event bus is remembered the same way, so a
reload never leaves the agent listening to a stale copy. (Epic Stack ships the same
idea as `@epic-web/remember`.)

## 2. Settings become data

The prompt is a **template**; the holes are filled from the settings:

```ts
export const PROMPT = `Eres la recepcionista de {{name}}, una clínica dental. …
Horario: {{hours}}
Servicios: {{services}}
Hoy es {{date}} y son las {{time}}. …`;
```

`src/clinic/settings.ts` is the model — the defaults, a gate, and `get`/`update` over
a `Store`. The gate is the whole of the validation, and it is deliberately small:

```ts
// src/clinic/settings.ts — only the seven known fields get through, each as a string
export function apply(current: SettingsRow, patch: Record<string, unknown>): SettingsRow {
  const next: SettingsRow = { ...current, updatedAt: Date.now() };
  for (const key of FIELDS) if (key in patch) next[key] = String(patch[key]);
  return next;
}
```

Notice what `update()` does *not* do: it does not emit. It writes and returns the new
settings, and the caller announces them. A model that reaches for a global bus cannot be
run from a test, a CLI or a cron — and this one is the thing the next two steps are
built on, so it had better be the easiest thing in the repo to run.

`src/storage/index.ts` binds it to the process's store, and is the only impure line of
the pair — import it and you have touched the disk; import `src/clinic` and you have
not:

```ts
// src/storage/index.ts
export const Appointment = createAppointments(store);
export const Call = createCalls(store);
export const Settings = createSettings(store);
```

The form is a React Router page with a `loader`, an `action` and a `<Form>` — no
`fetch`, no state management, no API call to itself:

```tsx
// src/web/routes/settings.tsx
export const loader = () => Settings.get();
export const action = async ({ request }: Route.ActionArgs) => {
  const settings = Settings.update(Object.fromEntries(await request.formData()));
  bus.emit("settings", settings);
  return settings;
};
```

`promptVars` is sent **at registration**, so the very first sentence of the very first
call already has the right clinic name, hours and services.

## 3. Telling the running agent

Same process, so this is one line — the first one in `src/agent/wire.ts`:

```ts
// src/agent/wire.ts
bus.on("settings", (s) => agent.update(config(s)));
```

`agent.update()` travels down the WebSocket the agent already holds.
**Nothing restarts.** Calls in progress keep the settings they started with; the next
call is born with the new ones. That is [hot-reload](/concepts/hot-reload), and it is
what makes a configurable agent possible at all.

Two facts about it that shape every variant of this design, including the ones where
the console is a separate service:

> `agent.update()` can only be called by the process that opened the agent's socket.
> No HTTP request to Pinecall can reconfigure a running agent on another process's
> behalf. If your console and your agent are different processes, the console has to
> *tell* the agent — and the agent has to be the one that calls `update()`.

> On the phone, voice and greeting are resolved when the call is picked up. There is no
> window to change them after the first ring. So they have to be right *before* the
> phone rings — which is why the push above is not optional, and why hours and services
> (which only matter once the model generates) can be refreshed later, at
> `call.started`.

## 4. The page that moves by itself

This part flows the *other* way — from the call to the browser — and it does not
go through this process at all. The page reads the **[call log](/guides/observe-calls)**:
the append-only, seq-stamped record every call already has on the voice server.

```
the agent ──► voice.pinecall.io ──► the call's log ──SSE──► the browser
```

The clinic's own `db.json` is still the archive (`src/agent/wire.ts` writes it,
the history at the bottom of the page renders it server-side). But the *live*
panel is not a copy of the transcript kept in this process's memory — it is the
log itself, read directly.

The loader mints the token it runs on, so the panel is watching on the first
paint, and the key never leaves the server:

```ts
// src/web/routes/calls.tsx
export const loader = async () => ({
  agent: SLUG,
  observe: await pc.createToken("stream", SLUG, undefined, { scope: "observe" }),
  history: clinic.calls.recent(),
});
```

Two hooks, chained, and that chain is the design:

```tsx
// src/web/components/AgentLive.tsx — which calls exist, which are live
const { live } = useAgentCalls(agent, { token, server });
return live.map((row) => <LiveCall key={row.call} call={row.call} token={token} server={server} />);

// src/web/components/LiveCall.tsx — one call's content
const s = useCall<CallLog>({ call, token, server });
<LiveTimeline messages={s.messages} tools={s.toolCalls} custom={s.custom} phase={s.phase} />
```

One observation **per live call, keyed by call id** — two calls at once are two
panels. The version that kept a single slot painted the second call's words into
the first one's transcript, which is the same bug the old in-process version
had; the fix is the same, and the key is the reason.

Three things fall out of this that no in-process bus could give you:

- **A page reload keeps the transcript.** `reconnectOnMount` (on by default)
  parks the last `seq` in `localStorage` and resumes from it. Nothing in memory
  replays — the cursor does the work.
- **It is not *this* process's call.** Any copy of the app answering the phone
  shows up here, and so does a call that started before the tab was opened.
- **No WebSocket.** `transport` defaults to `auto`, which is SSE degrading to
  the JSON cursor. Observing is a read.

### What the agent writes into it

`book_appointment` books the slot and then says so *in the call*:

```ts
// src/agent/tools.ts
call.log("appointment.booked", booked, { id: `${booked.date}T${booked.time}` });
```

That is a durable `custom` entry with a `seq` of its own — so `LiveTimeline`
draws it **between the tool chip that made it and the sentence the bot said
next**, not in a list off to one side. `id` is the slot, so a model that calls
the tool twice for the same appointment upserts one row instead of confirming
twice.

The names and their shapes are one type, and the hook takes it:

```ts
// src/clinic/events.ts — two catalogues, and they are not the same thing
export type Events  = { settings: SettingsRow };            // the in-process bus
export type CallLog = {                                      // what call.log() writes
  "appointment.booked": AppointmentRow;
  "appointment.refused": { date: string; time: string; reason: string };
};
```

`useCall<CallLog>` makes `s.custom` a union of typed rows and narrows `value` on
`name` in `onCustom`.

> ⚠️ **`onCustom` narrows only at exact arity.** Write
> `(name, value, _entry) => …`. Drop the third parameter and TypeScript stops
> contextually typing the union of tuples, and `value` widens back to
> `unknown`.

### The bus that survived

`src/bus.ts` is still there, and it is **one event wide**:

```
form action ──► Settings.update() ──► bus.emit("settings") ──► agent.update()
```

That is a real in-process fact with a real in-process listener. A fact about a
*call* is not: it already has a log with a cursor, replay, history and a reader
in any process. `bus.onAny`, `/api/events` and `useEvents.ts` are gone, and
nothing replaced them.

Two details about the transcript are worth keeping, because they are the
reducer's rules now rather than yours. **The bot's line is what has been
*said*** — `bot.speaking` may carry the whole text up front (the phone does,
for the greeting), and the reducer keeps it as a *speaking* draft until
`bot.finished`; rendering `bot.speaking.text` as final puts the greeting on
screen twice, once before it is spoken and once while it is, which is exactly
what the first phone call did. And **the tool calls are part of the
transcript**: `s.toolCalls` carries `{ name, args, result, ms }`, so the
timeline shows

```
⚙ check_availability {date:2026-08-28} → {open:true,slots:[09:00,09:30,10:00],total:22}
```

between the patient's question and the agent's answer. A transcript that shows
the lookup is the difference between "it said there was a slot at nine" and "it
*checked*".

> **If `agent.on("bot.word")` never fires on a browser call, it is not your code.**
> Until sdk-server `17f7df3` the WebRTC transport sent `bot.speaking`, `bot.word`,
> `bot.finished` and `user.speaking` to the SDK *without an `agent_id`*, and every SDK
> handler drops a frame that has none — so they reached the socket and vanished, while
> `user.message` and `turn.end` (which travel a different path that stamps it) arrived.
> The way to see it is `PINECALL_LOG=./pinecall.log`, which writes every wire frame the
> SDK receives; [How it was built](/tutorial/how-it-was-built) has the whole hunt.

## 5. The same agent, in the browser

The browser needs a short-lived token. Minting one is an HTTP call carrying the org's
API key, so it is a resource route:

```ts
// src/web/routes/api/token.ts — POST /api/token[?scope=observe]
export const action = async ({ request }: Route.ActionArgs) => {
  const scope = new URL(request.url).searchParams.get("scope");
  return Response.json(
    scope === "observe"
      ? await createToken({ channel: "stream", agentId: SLUG, scope: "observe", apiKey })  // to WATCH
      : await createToken({ channel: "webrtc", agentId: SLUG, apiKey }),                   // to TALK
  );
};
```

Two tokens, one route: the WebRTC one lets this tab *talk*, the stream one lets
it *watch* — and the watcher is read-only, one agent wide.

The page does not use the ready-made widget. It builds its own button over
`VoiceSession` from `@pinecall/web/core` — a connect/disconnect, the phase, the duration,
mute — and reads the transcript straight from the session's state, which already
carries interim user text, the bot's words as they play, and tool calls as `system`
messages:

```tsx
// src/web/components/BrowserCall.tsx — `agent` comes from the loader, not a second hardcoded slug
const session = new VoiceSession({ agent, tokenProvider: token });
const state = useSyncExternalStore(session.subscribe, session.getState);   // status · phase · messages · duration
<button onClick={() => (state.status === "connected" ? session.disconnect() : session.connect())}>…</button>
```

There is genuinely no second agent: the phone number and this button are two doors
into the same `pc.agent(SLUG, …)` — and the browser is told which slug that is by the
route's loader, so there is exactly one place the name is written down. `VoiceSession`
touches browser audio APIs, so it is imported on the client only (`import()` inside an
effect).

## 6. Where config ends and code begins

The console can change what the agent *says*. It cannot change what it can *do*:

```ts
// src/agent/tools.ts
const checkAvailability = tool({
  name: "check_availability",
  description: "Free slots on a date. Always call this before proposing a time.",
  schema: z.object({ date }),
  execute: traced("check_availability", async ({ date }) => {
    const { open, slots } = appointments.free(date);
    return open ? { open, slots: slots.slice(0, 3), total: slots.length } : { open };
  }),
});
```

Two habits from this snippet are worth stealing. **Return three slots, not twelve** —
the model offers what you hand it, and shaping the tool's *output* for speech is more
reliable than asking the prompt to be brief. **Say "always call this first" in the
description** — it is the difference between an agent that checks the book and one that
invents a plausible time.

The tool calls the clinic directly — `appointments.free(date)` — because it is the same
process. There is no HTTP between the agent and its own data. And `appointments` is a
parameter of `createTools()`, not an import, which is why the same tools can be pointed
at an in-memory store in a test.

That is also where the line at the top of this page stops being rhetoric.
`src/clinic/appointments.ts` is the clinic: `availability()` is the opening hours, `book()` is the
one invariant ("no two appointments in the same slot"), and neither of them can reach a
disk, a bus or a browser. The form can change every word the agent says. It cannot
change what a free slot *is*.

## Run it

```bash
git clone https://github.com/pinecall/examples
cd examples/dental-desk && npm install
cp .env.example .env          # paste your key
npm run dev                   # http://localhost:3000
```

Press the call button, talk to it. Change the voice, save, call again. Open the call
page and phone the number. `PHONE` is optional — without it, everything works in the
browser.

## What's next

- [How it was built](/tutorial/how-it-was-built) — the designs that were rejected and the bugs the first real call found
- [Hot-Reload](/concepts/hot-reload) — the mechanism step 3 rests on
- [Tools and Functions](/guides/tools-and-functions) — the full tool surface
- [WebRTC in the Browser](/guides/webrtc-browser) — tokens, sessions and the widget
- [Multi-Tenant Dashboards](/guides/multi-tenant) — one agent for every clinic

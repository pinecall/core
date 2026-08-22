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

One React Router app, one process, one `.env`. The finished code is at
[**github.com/pinecall/dental-desk-sse**](https://github.com/pinecall/dental-desk-sse)
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
src/                   the clinic. Nothing in here knows React Router exists.
├── domain/            the rules, pure: availability · booking · the call log · settings
│   └── events.ts      the typed catalogue — the ONE place an event is declared
├── store/             persistence behind an interface: db.json in memory, written atomically
├── agent/             prompt · tools · config (settings → SDK config) · wire (SDK events → domain)
├── bus.ts             a typed emitter over domain/events.ts
├── models.ts          the composition root: the domain, bound to this process's store
└── config.ts          slug, phone number, db path

app/                   ONLY React Router
├── routes.ts          the whole surface, URL → file
├── settings/          page (the form) · api
├── appointments/      api · availability
├── calls/             page (live call + history) · events (SSE) · token
├── components/        Bubble · Phase · CallTranscript · PastCall · BrowserCall · AgentLive
└── hooks/useEvents.ts ONE /api/events connection per tab, refcounted

server/app.ts          Express + the React Router handler + startAgent()
server.js              the process entry — Vite in dev, the build in prod. Nothing else.
```

Four decisions, each borrowed rather than invented.

**One arrow, and it only points one way: `app/` may import `src/`, `src/` may never
import `app/`.** The clinic's rules — when it opens, that two people cannot have the
same slot — are not the website's rules, and the voice agent has nothing to do with
React Router. So the business, its storage and the agent live in `src/`, which imports
no framework at all, and `app/` is only the web app. This is not a convention: one
ESLint rule fails the build if `src/` reaches into `app/`, and CI runs it. The first
version of this repo asked nicely instead, and within a month the agent was importing
three models and the event bus out of the framework's folder.

**The mount is React Router's own
[custom-server template](https://github.com/remix-run/react-router-templates/tree/main/node-custom-server).**
`server.js` boots; `server/app.ts` is Express plus the RR request handler and is
*bundled by Vite together with the routes*, so the agent, the domain and the pages share
one module graph — one process, one bus, one store. `server/app.ts` is the only file
that is neither: it is the mount, and it starts the agent.

**Folders are named after what they do, not what they are.** Open `src/domain/
appointments.ts` and the whole of appointments is in it; open `app/appointments/` and
so are both of its endpoints. This is the feature-first layout that has replaced
`models/ controllers/ routes/` in most codebases; the practical effect is that "where
is X?" always has the same answer.

**The API is resource routes.** A React Router route file with a `loader` and/or
`action` and no component *is* a JSON endpoint. There is no second router to learn:

```ts
// app/settings/api.ts — GET and PUT /api/settings, the entire file
export const loader = () => Response.json(Settings.get());

export const action = async ({ request }: Route.ActionArgs) => {
  const settings = Settings.update(await request.json());
  bus.emit("settings", settings); // the agent listens: the next call is born with it
  return Response.json(settings);
};
```

(The domain does not announce anything by itself — `Settings.update()` returns the new
settings and the caller emits. That is what lets `src/` stay free of the bus, and it is
why the agent's booking tool emits for itself too.)

And the map of it all fits on one screen:

```ts
// app/routes.ts
export default [
  index("settings/page.tsx"),
  route("call", "calls/page.tsx"),
  ...prefix("api", [
    route("settings", "settings/api.ts"),
    route("appointments", "appointments/api.ts"),
    route("availability", "appointments/availability.ts"),
    route("events", "calls/events.ts"),
    route("token", "calls/token.ts"),
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

The agent is started once per process, from `server/app.ts`:

```ts
// server/app.ts
import { startAgent } from "@/agent";
export const agent = remember("agent", startAgent);
```

`remember` is four lines in `src/remember.ts`: keep one instance on
`globalThis`, create it the first time only. It is not decoration. In development Vite
re-evaluates `server/app.ts` on a hot reload, and an agent registered twice under the
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

`src/domain/settings.ts` is the model — the defaults, a gate, and `get`/`update` over
a `Store`. The gate is the whole of the validation, and it is deliberately small:

```ts
// src/domain/settings.ts — only the seven known fields get through, each as a string
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

`src/models.ts` binds it to the process's store, and is the only impure line of the
pair:

```ts
// src/models.ts
export const Appointment = createAppointments(store);
export const Call = createCalls(store);
export const Settings = createSettings(store);
```

The form is a React Router page with a `loader`, an `action` and a `<Form>` — no
`fetch`, no state management, no API call to itself:

```tsx
// app/settings/page.tsx
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

This is the part that earns the "SSE" in the repo's name, and it flows the *other* way:
from the server **to the browser**.

`app/calls/events.ts` is a resource route whose loader returns a stream:

```ts
export const loader = ({ request }: Route.LoaderArgs) => {
  const stream = new ReadableStream({
    start(controller) {
      const send = (event, data) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      for (const name of EVENTS) bus.on(name, (data) => send(name, data));
      request.signal.addEventListener("abort", /* unsubscribe, close */);
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", … } });
};
```

That route keeps no list of its own: `EVENTS` is the catalogue in
`src/domain/events.ts`, which is the single place an event is declared — its name, its
payload, and a type-level assertion that the runtime list and the type map cannot drift
apart.

```ts
// src/domain/events.ts
export type Events = {
  settings: SettingsRow;
  appointment: AppointmentRow;
  "call.started": CallRow;
  "call.ended": { id: string; reason: string; endedAt?: number };
  turn: { id: string; state: TurnState };
  "user.speaking": { id: string; text: string };
  "bot.word": { id: string; text: string };
  transcript: { id: string } & Line;
};
```

Adding an event is a line there; the bus types it, this route forwards it, and the
browser gets the payload typed without a cast. The agent feeds the call events in
`src/agent/wire.ts`, which is the whole translation from the SDK to this catalogue:

```ts
// src/agent/wire.ts — the log returns what it wrote; the agent says it happened
agent.on("call.started", (call) => bus.emit("call.started", calls.start({ id: call.id, from: call.from ?? "navegador", transport: call.transport })));
agent.on("user.message", ({ text }, call) => line(call, "user", text));
agent.on("bot.finished", (_, call) => { if (voice(call) && call.currentBotText) line(call, "bot", call.currentBotText); });
```

`wire()` takes the agent, the bus and the logger as parameters instead of importing
them, so "does `bot.finished` write exactly one line?" is a unit test with doubles
rather than a phone call.

And the call page hangs off **one** `EventSource` per tab, refcounted in
`app/hooks/useEvents.ts` — the live panel and the history share it instead of opening
one each:

```tsx
useEvents({
  "call.started": (call) => setLive((l) => new Map(l).set(call.id, blank(call))),
  turn:           ({ id, state }) => patch(id, (l) => ({ ...l, state })),
  transcript:     ({ id, ...line }) => patch(id, (l) => ({ ...l, lines: [...l.lines, line] })),
  "call.ended":   ({ id }) => drop(id),
});
```

The panel is a `Map<callId, LiveCall>` and every handler matches on the id it was
given. Two calls at once are two panels; the version that kept a single slot painted
the second call's words into the first one's transcript.

Phone the number, and the page shows the phase (escuchando · pensando · hablando), the
patient's words, the agent's replies, and — when it hangs up — the whole call in the
history. No polling, no refresh. `appointment` rides the same stream, so a page that
wants to show the agenda live already has the event.

Two details worth knowing. **The bot's line is what has been *said*.** On voice,
`bot.speaking` may carry the whole text up front — the phone does, for the greeting —
but it is not shown until the audio plays: `bot.word` grows a draft, and
`bot.finished` closes it as the line, from `call.currentBotText`. Chat has no audio and
no words, so there `bot.speaking` *is* the line. One rule, keyed on `call.transport`;
showing `bot.speaking.text` early puts the greeting on screen twice — once before it is
spoken and once while it is — which is exactly what the first phone call did. And the
**tool calls are part of the transcript**: the tools are ours, so a tiny wrapper logs
what was asked and what came back as a `tool` line —

```
⚙ check_availability {date:2026-08-28} → {open:true,slots:[09:00,09:30,10:00],total:22}
```

— between the patient's question and the agent's answer. A transcript that shows the
lookup is the difference between "it said there was a slot at nine" and "it *checked*".
(`llm.toolCall` fires too, with the names; the result is only known to the tool itself,
which is why the wrapper lives there and not in an event handler.)

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
// app/calls/token.ts — POST /api/token
export const action = async () =>
  Response.json(await createToken({ channel: "webrtc", agentId: SLUG, apiKey: process.env.PINECALL_API_KEY! }));
```

The page does not use the ready-made widget. It builds its own button over
`VoiceSession` from `@pinecall/web/core` — a connect/disconnect, the phase, the duration,
mute — and reads the transcript straight from the session's state, which already
carries interim user text, the bot's words as they play, and tool calls as `system`
messages:

```tsx
// app/components/BrowserCall.tsx — `agent` comes from the loader, not a second hardcoded slug
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

The tool calls the domain directly — `appointments.free(date)` — because it is the same
process. There is no HTTP between the agent and its own data. And `appointments` is a
parameter of `createTools()`, not an import, which is why the same tools can be pointed
at an in-memory store in a test.

That is also where the line at the top of this page stops being rhetoric. `src/domain/
appointments.ts` is the clinic: `availability()` is the opening hours, `book()` is the
one invariant ("no two appointments in the same slot"), and neither of them can reach a
disk, a bus or a browser. The form can change every word the agent says. It cannot
change what a free slot *is*.

## Run it

```bash
git clone https://github.com/pinecall/dental-desk-sse
cd dental-desk-sse && npm install
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

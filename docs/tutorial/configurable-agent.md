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
by line while somebody is on the phone, and the appointment the agent just booked
shows up in the agenda without a refresh.

One React Router app, one process, one `.env`. The finished code is at
[**github.com/pinecall/dental-desk-sse**](https://github.com/pinecall/dental-desk-sse)
— about 480 lines in 20 files.

## The line this tutorial is really about

Elsewhere in these docs, [Project Structure](/guides/project-structure) is blunt:
everything about the agent — model, voice, STT, number, greeting, prompt — belongs in
the agent file, where it is diffable and reviewable. Config that escapes code review is
config nobody can reason about.

A configurable agent breaks that rule on purpose, so it had better break it precisely:

| | Lives in | Who changes it |
|---|---|---|
| Name, greeting, voice, language, hours, services | the database | the clinic, from a form |
| Model, STT provider, which tools exist | `server/agent/agent.ts` | you, in a pull request |

The first row is what a receptionist would change if they could. The second is made of
decisions with consequences for latency, cost and quality — a text box is the wrong
place for them. The code keeps that line in one function, `config(settings)` — the top
half of the object it returns reads from the settings, the bottom half is constants.

## The shape

```
server.js              the process entry — Vite in dev, the build in prod. Nothing else.
server/app.ts          Express + the React Router handler + startAgent()
server/agent/          pc.agent() with its two tools, and the prompt
app/routes.ts          the whole surface, URL → file
app/settings/          model · page (the form) · api
app/appointments/      model · api · availability
app/calls/             page (live call + agenda) · events (SSE) · token
app/lib/               db (a JSON file) · bus (in-process events)
```

Three decisions, each borrowed rather than invented.

**The mount is React Router's own
[custom-server template](https://github.com/remix-run/react-router-templates/tree/main/node-custom-server).**
`server.js` boots; `server/app.ts` is Express plus the RR request handler and is
*bundled by Vite together with the routes*, so the agent, the models and the pages share
one module graph. `server/` means "Node-only code that starts with the process" — and
an agent is exactly that, so that is where it lives.

**Folders are named after what they do, not what they are.** Open `app/appointments/`
and everything about appointments is in it: the model, the endpoint, the availability
query. This is the feature-first layout that has replaced `models/ controllers/ routes/`
in most codebases; the practical effect is that "where is X?" always has the same
answer.

**The API is resource routes.** A React Router route file with a `loader` and/or
`action` and no component *is* a JSON endpoint. There is no second router to learn:

```ts
// app/settings/api.ts — GET and PUT /api/settings, the entire file
export const loader = () => Response.json(Settings.get());
export const action = async ({ request }: Route.ActionArgs) =>
  Response.json(Settings.update(await request.json()));
```

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

`server/agent/agent.ts` builds the whole configuration in one function of the settings
and registers the agent with it. Four lines deserve a note.

```ts
const config = (s: SettingsRow) => ({
  greeting: s.greeting,               // ── from the form
  voice: s.voice,
  language: s.language,
  promptVars: vars(s),

  prompt: PROMPT,                     // ── from a pull request
  timezone: "Europe/Madrid",
  llm: "openai/gpt-5.4-nano",
  stt: "deepgram/flux",
  tools: [checkAvailability, bookAppointment],
  phoneNumber: process.env.PHONE,     // undefined → browser only
});

const agent = pc.agent("dental-desk", config(Settings.get()));
```

**`stt: "deepgram/flux"`** — Flux detects the end of a turn inside the STT stream:
no separate voice-activity model, no added latency. Set this and **do not set
`turnDetection` or `vad`**; the server derives both, and overriding them by hand is how
agents end up interrupting people. See [Turn Detection](/concepts/turn-detection).

**`timezone`** — the built-in `{{date}}` and `{{time}}` resolve in the clinic's zone,
on every channel, with no round-trip. Without it, "¿a qué hora abren?" is answered
against the server's clock.

**`phoneNumber`** is the entire telephony setup. There is no webhook to configure.

**`config(settings)`** is the line from the top of this page, made executable — and
because it is *one* function, the same call that creates the agent is the call that
updates it (step 3). No spread, no "base config plus overrides".

The agent is started once per process, from `server/app.ts`:

```ts
// server/app.ts
export const agent = remember("agent", startAgent);
```

`remember` is four lines in `app/lib/remember.server.ts`: keep one instance on
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

`app/settings/model.server.ts` is the model — `Settings.get()` and
`Settings.update(patch)` over a JSON file, forty lines. The one thing it does besides
reading and writing is what the next two steps are built on:

```ts
update(patch) {
  // …
  db.settings = next;
  bus.emit("settings", next);   // ← tell whoever is listening
  return next;
}
```

The form is a React Router page with a `loader`, an `action` and a `<Form>` — no
`fetch`, no state management, no API call to itself:

```tsx
// app/settings/page.tsx
export const loader = () => Settings.get();
export const action = async ({ request }: Route.ActionArgs) =>
  Settings.update(Object.fromEntries(await request.formData()));
```

`promptVars` is sent **at registration**, so the very first sentence of the very first
call already has the right clinic name, hours and services.

## 3. Telling the running agent

Same process, so this is one line:

```ts
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
      for (const topic of TOPICS) bus.on(topic, (data) => send(topic, data));
      request.signal.addEventListener("abort", /* unsubscribe, close */);
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", … } });
};
```

Everything on the bus goes down that stream: `settings`, `appointment`,
`call.started`, `call.ended`, `transcript`. The agent feeds the last three in
`server/agent/agent.ts`:

```ts
agent.on("call.started", (call) => bus.emit("call.started", { id: call.id, from: call.from }));
agent.on("user.message", ({ text }, call) => bus.emit("transcript", { id: call.id, who: "user", text }));
agent.on("bot.finished", (_, call) => bus.emit("transcript", { id: call.id, who: "bot", text: call.currentBotText }));
```

And the call page is an `EventSource` and four listeners:

```ts
const events = new EventSource("/api/events");
on("call.started", (call) => { setLive(call); setLines([]); });
on("transcript",   (line) => setLines((l) => [...l, line]));
on("appointment",  (a)    => setAppointments((all) => [...all, a]));
```

Phone the number, and the page shows "📞 En llamada", the patient's words, the agent's
replies, and — when the agent books — the new row in the agenda. No polling, no
refresh.

One detail worth knowing: the bot's transcript line comes from **`bot.finished` +
`call.currentBotText`** on voice (TTS streams the reply word by word, so the full text
only exists at the end) and from **`bot.speaking`** on chat (where the whole reply
arrives at once). The agent listens to both and de-duplicates by `messageId`.

## 5. The same agent, in the browser

The browser needs a short-lived token. Minting one is an HTTP call carrying the org's
API key, so it is a resource route:

```ts
// app/calls/token.ts — POST /api/token
export const action = async () =>
  Response.json(await createToken({ channel: "webrtc", agentId: "dental-desk", apiKey: process.env.PINECALL_API_KEY! }));
```

```tsx
<VoiceWidget agent="dental-desk" name="Recepción" tokenProvider={token} />
```

There is genuinely no second agent: the phone number and the widget are two doors into
the same `pc.agent("dental-desk", …)`. The widget touches browser audio APIs, so the
page renders it client-side only — a `lazy` import behind a "has mounted" flag.

## 6. Where config ends and code begins

The console can change what the agent *says*. It cannot change what it can *do*:

```ts
const checkAvailability = tool({
  name: "check_availability",
  description: "Free slots on a date. Always call this before proposing a time.",
  schema: z.object({ date }),
  execute: async ({ date }) => {
    const { open, slots } = Appointment.free(date);
    return open ? { open, slots: slots.slice(0, 3), total: slots.length } : { open };
  },
});
```

Two habits from this snippet are worth stealing. **Return three slots, not twelve** —
the model offers what you hand it, and shaping the tool's *output* for speech is more
reliable than asking the prompt to be brief. **Say "always call this first" in the
description** — it is the difference between an agent that checks the book and one that
invents a plausible time.

The tool calls the model directly — `Appointment.free(date)` — because it is the same
process. There is no HTTP between the agent and its own data.

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

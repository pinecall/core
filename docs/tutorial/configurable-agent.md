---
title: "An agent your customer can configure"
description: "Build a voice agent for a dental clinic that answers both a phone number and the browser, and whose settings are edited from a web console instead of a source file."
---

# An agent your customer can configure

Every voice agent you ship for someone else runs into the same wall. The clinic wants
a different greeting. The receptionist wants a different voice. Opening hours change
in August. None of that is your job, and all of it currently requires you to edit a
file and redeploy.

This tutorial builds the way out: a dental clinic's receptionist that **answers a
phone number and the browser as one agent**, and whose settings live in a web console
that the clinic operates. Change the voice, press save, call again — the new voice
answers. Nothing restarts. Calls already in progress are undisturbed.

The finished code is at
[**github.com/pinecall/dental-desk**](https://github.com/pinecall/dental-desk) —
around 1,200 lines, most of them comments explaining the decisions below.

## The line this tutorial is really about

Elsewhere in these docs, [Project Structure](/guides/project-structure) is blunt:
everything about the agent — model, voice, STT, number, greeting, prompt — belongs in
`index.mjs`, where it is diffable and reviewable. That rule exists because config that
escapes code review is config nobody can reason about.

A configurable agent breaks that rule on purpose, so it had better break it precisely.
Draw the line like this:

| | Lives in | Who changes it |
|---|---|---|
| Name, greeting, voice, language, hours, services | the store | the clinic, from a form |
| Model, STT provider, which tools exist, the topology | the repository | you, in a pull request |

The first row is what a receptionist would change if they could. The second row is
made of decisions with consequences for latency, cost and quality — a text box is the
wrong place for them.

The whole tutorial is an argument for keeping that line in **one file**.

## The shape

Two processes, and neither of them is what people expect.

```
┌──────────────┐   PUT /api/config    ┌──────────────┐
│   console    │ ───────────────────► │  settings    │
│  (browser)   │                      │   (store)    │
└──────────────┘                      └──────┬───────┘
       ▲                                     │ read at boot,
       │ POST /api/token                     │ read per call
       │                              ┌──────▼───────┐
┌──────┴───────┐  SSE: config changed │              │   phone  ☎
│  apps/ui     │ ───────────────────► │  apps/agent  │ ◄────────
│  + server    │                      │              │   browser 🎙
└──────────────┘                      └──────────────┘
```

```
apps/
  agent/           the Pinecall agent — a process, not a server
    index.mjs        registers, listens for changes, refreshes per call
    config.mjs       settings row → agent configuration (the only translator)
    tools.mjs        consultar_disponibilidad · agendar_cita
    watch.mjs        an SSE client, because Node has no EventSource
  ui/              the console — the only process with a port open
    server.mjs       /api/config · /api/config/stream · /api/token
    src/             the form, the call widget, the agenda
packages/
  config-store/    what the receptionist edits. Knows nothing about Pinecall.
  domain/          the appointment book. Knows nothing about Pinecall either.
```

Two rules make this layout worth copying.

**`packages/` never imports Pinecall.** The store returns a plain object; the
appointment book takes dates and names. Neither knows an agent exists. That is what
keeps the console a plain form instead of a Pinecall control panel, and it is what
lets you test the booking logic without a microphone.

**The agent opens no port.** It is not a web server with an agent inside it. That
constraint is what the rest of this tutorial has to solve, and the solution is more
interesting than the problem.

## 1. The agent, before anything is configurable

Start with the version that has no console at all — settings hard-coded, one number,
one prompt.

```js
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall();               // reads PINECALL_API_KEY, connects itself

const agent = pc.agent("dental-desk", {
  prompt: "Eres la recepcionista de la Clínica Dental Sonrisa…",
  greeting: "Clínica Dental Sonrisa, buenos días. ¿En qué puedo ayudarle?",
  voice: "elevenlabs/sarah",
  language: "es",
  timezone: "Europe/Madrid",
  llm: "openai/gpt-5.4-nano",
  stt: "deepgram/flux",
  phoneNumber: "+14847598998",
});
```

`node index.mjs`, dial the number, and a receptionist answers. Four of those lines
deserve a note.

**`stt: "deepgram/flux"`** — Flux detects the end of a turn inside the STT stream
itself: no separate voice-activity model, no added latency. Set this line and **do not
set `turnDetection` or `vad`**. The server derives both from the STT provider, and
overriding them by hand is how agents end up interrupting people. See
[Turn Detection](/concepts/turn-detection).

**`timezone`** — without it, "¿a qué hora abren?" gets answered against the server's
clock. With it, the built-in `{{date}}` and `{{time}}` variables resolve in the
clinic's own zone, on every channel, with no round-trip.

**`phoneNumber`** is the entire telephony setup. There is no webhook to configure.

**No second agent for the browser.** The same slug answers WebRTC. We wire that up in
step 5.

## 2. Settings become data

The prompt stops being a string and becomes a **template** with holes:

```js
export const PROMPT = `Eres la recepcionista de {{clinica}}, una clínica dental.

HORARIO
{{horario}}

SERVICIOS QUE OFRECEMOS
{{servicios}}

HOY ES {{date}} y son las {{time}}.`;
```

`{{date}}` and `{{time}}` are built in. The rest come from the store, and the file
that fills them is the line from the top of this tutorial, made executable:

```js
// apps/agent/config.mjs — the one place that speaks both languages
export function toAgentConfig(row, tools) {
  return {
    prompt: PROMPT,
    promptVars: toVars(row),      // ← the clinic's fields
    greeting: row.greeting,
    voice: row.voice,
    language: row.language,
    timezone: row.timezone,

    // ── Engineering. Not in the console, on purpose. ──
    llm: "openai/gpt-5.4-nano",
    stt: "deepgram/flux",
    tools,
  };
}
```

Everything above the comment comes from a form. Everything below it comes from a pull
request. When somebody asks "can the client change the model?", the answer is a
diff to this file, not an argument.

`promptVars` is sent **at registration**, which matters: those values resolve on the
first turn without a round-trip, so the very first sentence of the very first call is
already right.

## 3. Telling a running agent that something changed

Here is the problem the layout created. The console saved a new voice to the store.
The agent is a different process, holding a WebSocket, with no port open. How does it
find out?

First, what does **not** work, and why:

> **The console cannot apply the change itself.** `agent.update()` writes to the
> WebSocket that the agent opened, and the console does not have that socket. Only the
> agent's own process can call it. No HTTP request to Pinecall can do it on the
> console's behalf.

That leaves three options.

**Give the agent an HTTP server.** It works, and it costs the agent its shape: now it
listens on a port, and something has to be able to reach it.

**Poll the store.** Twelve lines, no infrastructure, and up to N seconds of lag. Fine,
and a little dumb: the agent asks "did anything change?" thousands of times a day to
hear "no".

**Let the agent listen.** This is the one, and it is worth being precise about why it
does not contradict "the agent opens no port":

> In SSE, the **agent is the client**. It makes an *outbound* connection to the
> console and holds it open. An outbound connection is not a server: no port, no
> inbound route, no NAT problem. It is exactly how the agent already connects to
> Pinecall.

The console keeps the open responses and writes one line down each of them on save:

```js
// apps/ui/server.mjs
const listeners = new Set();

app.get("/api/config/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  write(res, read());        // say hello: a listener must not sit on stale settings
  listeners.add(res);

  // Proxies drop a silent connection; a comment line keeps it alive.
  const beat = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
  req.on("close", () => { clearInterval(beat); listeners.delete(res); });
});

app.put("/api/config", (req, res) => {
  const row = save(pick(req.body, Object.keys(DEFAULTS)));
  broadcast(row);            // ← the agent hears this before the response lands
  res.json({ config: row, listeners: listeners.size });
});
```

Returning `listeners` is a small thing that pays for itself: the form can say
*"aplicado · 1 agente escuchando"* instead of *"guardado"*. Saved-to-a-database and
heard-by-something are different facts, and a console that conflates them will one
day lie to its user.

On the agent's side, Node has no `EventSource` global, so the client is hand-written
(`apps/agent/watch.mjs`, about forty lines: read the stream, split on the blank line
between events, reconnect on any drop). Then:

```js
follow(`${CONSOLE_URL}/api/config/stream`, () => {
  const next = read();
  if (next.updatedAt === row.updatedAt) return;   // a replay after reconnect: ignore
  row = next;
  agent.update(toAgentConfig(row, tools));
});
```

`agent.update()` travels down the WebSocket the agent is already holding. **Nothing
restarts.** Calls in progress keep the settings they started with; the next call is
born with the new ones. That is [hot-reload](/concepts/hot-reload), and it is the
reason this whole design is possible.

## 4. The other half: freshness per call

`agent.update()` handles the agent's **defaults** — what a call is born with. But a
call that starts thirty seconds after an edit should not need a push at all to know
the new opening hours. So read the store when the call starts:

```js
agent.on("call.started", async (call) => {
  row = read();
  await call.setPromptVars(toVars(row));
});
```

These two mechanisms are not redundant, and the difference is worth understanding:

| | mechanism | why not the other one |
|---|---|---|
| Hours, services, clinic name | read at `call.started` | they only matter once the model generates, and that is after `call.started` |
| Voice, greeting, language | pushed via `agent.update()` | on a phone call there is no window to change them after the call arrives — the greeting is already being spoken |

That asymmetry is real and worth knowing. On WebRTC, the server waits briefly after
`call.started` for the SDK to reconfigure the session before synthesising the
greeting, precisely so a per-call `call.update()` lands before the first word. **On
the phone that window does not exist**: the voice and language a phone call uses are
resolved when the call is picked up. Which is why the defaults have to be right
*before* the phone rings — and why the push in step 3 is not optional.

## 5. The same agent, in the browser

The browser needs a short-lived token. Minting one is an HTTP call carrying the org's
API key, which means **any trusted server can do it** — it does not have to be the
process that owns the agent. So it lives in the console:

```js
// apps/ui/server.mjs
app.post("/api/token", async (_req, res) => {
  const token = await createToken({
    channel: "webrtc",
    agentId: "dental-desk",              // the same slug the phone rings
    apiKey: process.env.PINECALL_API_KEY,
  });
  res.json(token);                        // { token: "wrt_…", server }
});
```

```jsx
// apps/ui/src/CallPanel.jsx
<VoiceWidget
  agent="dental-desk"
  tokenProvider={async () => (await fetch("/api/token", { method: "POST" })).json()}
/>
```

The API key never reaches the browser; the token expires in sixty seconds. And there
is genuinely no second agent — the phone and the widget are two doors into the same
`pc.agent("dental-desk", …)`.

> **The cost of keeping the agent portless.** `PINECALL_API_KEY` now lives in two
> `.env` files: the agent needs it to register, the console needs it to mint. That is
> a real consequence of this design, not an oversight — better to name it than to
> discover it in production.

## 6. Where config ends and code begins

The console can change what the agent *says*. It cannot change what the agent can
*do*. Tools are code:

```js
export const consultarDisponibilidad = tool({
  name: "consultar_disponibilidad",
  description:
    "Huecos libres de un día concreto. Úsala SIEMPRE antes de proponer una hora: " +
    "nunca prometas una cita que no hayas consultado.",
  schema: z.object({ fecha }),
  async execute({ fecha }) {
    const { open, slots } = availability(fecha);
    if (!open) return { fecha, abierto: false, mensaje: "Ese día la clínica está cerrada." };
    // Three, not twelve: a list read aloud stops being useful past two or three.
    return { fecha, abierto: true, huecos: slots.slice(0, 3), total: slots.length };
  },
});
```

Two habits from this snippet are worth stealing.

**Return three slots, not twelve.** The model offers what you hand it, and twelve
times read aloud is unusable. Shaping the tool's *output* for speech is more reliable
than asking the prompt to be brief.

**Say "always use this first" in the description.** It is the difference between an
agent that checks the book and an agent that invents a plausible time.

## What the first real conversation taught us

Both of these came out of actually calling the thing, and both are in the finished
repo.

**It answered with emoji and markdown.** The transcript came back with `🙂` and a
booking reference in backticks — invisible in a chat window, absurd read aloud. The
prompt now says so explicitly:

```
Todo lo que escribas se va a LEER EN VOZ ALTA, así que:
- Frases cortas, como habla una persona. Nunca listas, viñetas ni markdown.
- Nada de emojis ni asteriscos ni comillas de código: no se pueden pronunciar.
- Los códigos y números se dicen despacio y dígito a dígito.
```

**The appointment it booked did not exist.** The agent confirmed a booking and the
console's agenda stayed empty — because the book was a `Map` at module scope, and the
agent and the console are **two processes**, each with its own copy. Anything two
processes share has to live somewhere both can see. The store had always been a file;
the book had to become one too.

That is the kind of bug that only shows up when you run both halves at once, which is
the argument for building the demo before writing the tutorial.

## Run it

```bash
git clone https://github.com/pinecall/dental-desk
cd dental-desk && npm install
cp .env.example apps/agent/.env && cp .env.example apps/ui/.env   # paste your key in both

npm run dev:ui      # the console, http://localhost:5174
npm run dev:agent   # the agent, in a second terminal
```

Open the console, press the call button, talk to it. Then change the voice, save, and
call again. `DENTAL_DESK_PHONE` is optional: leave it empty and everything still works
in the browser.

## Where to take it next

**Multi-tenant.** One agent for every clinic instead of one process each: mint the
token with the tenant's identity sealed inside it, read it as `call.metadata`, and
scope every tool by it. See [Multi-Tenant Dashboards](/guides/multi-tenant).

**A real database.** `read()`, `save()`, `availability()` and `book()` are the entire
surface either process sees. Swap the JSON files and nothing else changes — including
the fact that both processes currently have to share a machine.

**Watch the calls.** The console already knows the agent; adding a live transcript is
a [stream token](/guides/call-log) and a list. That is the observability half, and it
is a different mechanism from everything here: it flows *from* Pinecall *to* the
browser.

## What's next

- [Hot-Reload](/concepts/hot-reload) — the mechanism step 3 is built on
- [Tools and Functions](/guides/tools-and-functions) — the full tool surface
- [WebRTC in the Browser](/guides/webrtc-browser) — tokens, sessions and the widget
- [How it was built](/tutorial/how-it-was-built) — the designs that were rejected and the bugs the first call found
- [Multi-Tenant Dashboards](/guides/multi-tenant) — the next step for this app

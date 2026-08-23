---
title: "The run console"
description: "pinecall run gives you a terminal live view and a local web console — call the agent from the browser, watch every call live, chat by text. Both are observers of one event bus."
---

# The run console

`pinecall run agent/index.mjs` is the whole development loop in one command: it
starts your agent process, draws a **live terminal view** of every call, and
serves a **local web console** you can talk to the agent from.

```bash
pinecall run agent/index.mjs
```

```
  ⚡ booting dental-desk  ·  gpt-4.1-mini · cartesia/sonic
  ⚙ tools: checkAvailability, makeReservation
  ☎ listening on +14155550177 …
  ◉ console → http://127.0.0.1:4747   (p open · c chat · e events · q quit)
```

Open that URL and you get a page that already knows everything the terminal
knows — the same calls, the same transcripts, the same tool results — plus two
things a terminal cannot do: **place a real WebRTC call from the browser** and
**chat with the agent by text**.

Your agent file needs zero changes. The console is not something you import or
configure; it is the runner, watching the process it already runs.

> Nothing here is production. The console binds `127.0.0.1`, exists only while
> `pinecall run` is running, and disappears with it. When you want a dashboard
> your users see, build one — [Build a live call app](/guides/build-a-live-call-app)
> is that guide, and the [call log](/guides/observe-calls) is the API it uses.

---

## What the page shows

Three columns over one event stream, on the Pinecall design system (light and
dark, following your OS).

**Top bar** — what is running: the agent, its number, its model and voice, its
channels. With several agents in one file a picker chooses which one you are
looking at. A badge on the right says whether the stream is `live` or
`reconnecting`, and the **Events** button opens the raw stream drawer.

**Calls** (left) — every call the process is handling, live ones first:
channel glyph (`☎` phone, `◉` webrtc, `💬` chat, `✆` whatsapp), who is on the
other end, the turn state (`ringing` / `listening` / `thinking` / `speaking`)
and a timer that keeps running. Under them, **Recent**: the calls that already
ended, with their duration and how they ended. The console follows whatever is
live until you click a call yourself — then it stays where you put it.

**Transcript** (centre) — the selected call, as it happens: the caller on the
left, the agent on the right, tools in the middle. The caller's line is the
interim speech-to-text (dimmed) until the final text replaces it; the agent's
line grows **word by word as the audio is heard** and is fixed when the
utterance finishes — or marked `⏏` when the caller cut in. Tool calls render
inline as `⚡ name(args)` → `✓ result`, expandable. Auto-scroll follows the
conversation and steps aside the moment you scroll up. A live call can be hung
up from here.

**Talk to the agent** (right) — two doors into your own agent:

- **Voice** — a real WebRTC call from the page (mic in, audio out), the same
  path [`@pinecall/web`](/web/widget/overview) takes in production.
- **Chat** — a text session over the same agent.

Neither draws its own transcript, because neither needs to: a browser call is
an ordinary call of the process, so it arrives on the same event stream and is
rendered in the centre column exactly like a phone call. That is the point —
you test the agent, not a simulator of it.

**Events drawer** — every frame off the stream with a filter box: name, call,
and a compact payload summary. It is what `--events` prints in the terminal,
in a panel you can search.

### Terminal keys

While `pinecall run` is in the foreground (a TTY):

| Key | What it does |
|-----|--------------|
| `p` | open the console in your default browser |
| `c` | open a one-line chat prompt (`you › `) under the live view — Enter sends, Esc or an empty line closes. The message goes out on the agent's own socket as an ordinary text-chat turn, so the reply shows up in the terminal, the web console and any `pc.stream()` observer as a normal chat call (no API key involved, no second socket). With several agents a numbered chooser asks which one (skip it with `--agent <id>`) |
| `e` | toggle event printing on and off, live (same as `--events`) |
| `q` | quit: close the console, disconnect, restore the terminal (so does `Ctrl-C`) |

Off a TTY (piped, CI, under a supervisor) stdin is left alone — no raw mode, no
swallowed input.

### Flags

| Flag | Env | Default |
|------|-----|---------|
| `--open` | `PINECALL_RUN_OPEN=1` | open the browser on boot |
| `--no-ui` | `PINECALL_RUN_UI=0` | terminal only, no web console |
| `--ui-port <n>` | `PINECALL_RUN_UI_PORT` | `4747` (the next 10 ports are tried if it is busy) |
| `--ui-host <h>` | `PINECALL_RUN_UI_HOST` | `127.0.0.1` |
| `--events` | `PINECALL_RUN_EVENTS=1` | print every event in the terminal |
| `--call <number>` | `PINECALL_RUN_CALL` | once the agent is registered, have it **ring you** at that number (E.164, e.g. `+34600000000`, or a SIP URI) — an ordinary outbound call that shows up in both observers. Needs a phone channel on the agent; refusals (no phone, bad number, plan gate, busy) print as one line with the fix |
| `--agent <id>` | `PINECALL_RUN_AGENT` | in a multi-agent file: which agent `--call` dials and `c` talks to (otherwise `c` asks) |

```bash
pinecall run agent/index.mjs --open              # straight into the browser
pinecall run agent/index.mjs --no-ui             # just the terminal (c / e / q still work)
pinecall run agent/index.mjs --ui-port 4800
pinecall run agent/index.mjs --ui-host 0.0.0.0   # reachable from your phone
pinecall run agent/index.mjs --call +34600000000 # the agent rings you as soon as it is up
```

`GET /api/agents` (and the console's top bar) tells you which agents can dial:
each row carries `canCall: true` when the agent owns a phone channel — the same
test `--call` makes before dialling.

If the console cannot start (every port taken, a host that will not bind) the
agent still runs — the banner says `console off — <reason>` and that is all
that changes.

---

## Testing from your phone

`--ui-host 0.0.0.0` binds every interface, so the console is reachable from
another device on the same network — useful for trying the WebRTC call on a
real phone, where the microphone and the network are the ones your users have.

```bash
pinecall run agent/index.mjs --ui-host 0.0.0.0
```

```
  ◉ console → http://127.0.0.1:4747/?k=7f3c…   (p open · c chat · e events · q quit)
  · bound to 0.0.0.0 — every request needs the run key above (?k=…)
```

Off loopback the console is **key-guarded**: every request must carry `?k=<key>`
or it is `401`. The key is minted fresh for each run and lives only in that
process. Open the URL once with the key and the page sets a cookie, so its own
requests carry it from then on — you only paste it in the address bar (swap
`127.0.0.1` for your machine's LAN address).

> Browsers only grant microphone access on a secure origin. `localhost` counts;
> a plain `http://192.168.x.x` does not, so a phone on the LAN can *watch*
> calls but will be refused the mic. Put a tunnel with TLS in front of the
> console (e.g. `ngrok http 4747`) when you want to talk from the phone, and
> pass the key on that URL too.

---

## One bus, three observers

The console is not a feature bolted onto the runner; it is an **observer** of
the process, and so is everything else that watches a call.

```
                   agent process (the subject)
                            │
      ┌─────────────────────┼─────────────────────┐
      ▼                     ▼                     ▼
 terminal view        web console           your own code
 (pinecall run)     (/events → SSE)     (pc.stream() / agent.on())
```

One typed event bus, several readers, none of them special:

- the **terminal live view** renders it as lines;
- the **web console** reads it over `GET /events`, which is the SDK's own
  [`pc.stream()`](/api/pinecall) with a `console.hello` frame in front
  carrying the agents and the calls so far (a page that reconnects resyncs in
  one round trip);
- **your own server** can do the same thing in-process with
  [`pc.stream(res)`](/api/pinecall) — though for anything a user sees,
  read the [call log](/guides/observe-calls) instead: it has a cursor, replay,
  history, and works from a process that does not run the agent.

Because they are readers of the same bus, they can never disagree about what
was said. The web console and the terminal even share the reducer that turns
events into transcript lines — it is exported as `@pinecall/sdk/console`
(`apply`, `settle`, `CallSnapshot`, `createCallsModel`), a pure, dependency-free
state machine you can run in a browser if you are building your own view.

### A fourth observer

Adding one is not an integration; it is an event listener. Here is a transcript
logger — ten lines, no server, no dependencies:

```javascript
import { appendFileSync } from "node:fs";
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall();
const clinic = pc.agent("dental-desk", { prompt: "You are the receptionist at a dental clinic." });

const line = (who, text) =>
  appendFileSync("transcript.log", `${new Date().toISOString()} ${who} › ${text}\n`);

clinic.on("user.message", (e) => line("caller", e.text));   // final caller turn
clinic.on("bot.speaking", (e) => line("clinic", e.text));   // what the agent says
```

Run it with `pinecall run` and you now have four observers of the same call: the
terminal, the console page, `transcript.log`, and anything you add next. See
[Events](/guides/events) for the full catalogue.

---

## The HTTP surface

You rarely touch it — the page does — but the console is a plain HTTP server,
so `curl` works and so does your own script:

| Endpoint | What it returns |
|----------|-----------------|
| `GET /` | the console app (a prebuilt SPA shipped inside the package) |
| `GET /api/agents` | what this process is running: id, label, channels, phone, model, voice, tools |
| `GET /api/calls` | the live calls plus the last 50 that ended |
| `GET /events` | SSE: `console.hello` first, then every agent event |
| `POST /token` | `{ agent }` → a WebRTC token, minted per request |
| `POST /chat-token` | `{ agent }` → a chat token, minted per request |
| `POST /api/calls/:id/hangup` | end a live call |

`GET /events` accepts `?agent=<id>` to scope the stream to one agent.

In a source checkout of the SDK that has not been built there is no `dist/ui/`;
the console then serves a small page listing exactly these endpoints instead of
a blank 404, and the API keeps working.

---

## Security

The console is a development tool, and it is built to be one:

- **Loopback by default.** It binds `127.0.0.1`, where anything able to reach
  it is already running as you.
- **Any other host is key-guarded.** `--ui-host 0.0.0.0` (or a LAN address)
  makes the per-run key mandatory on every request; the key is random per run
  and never leaves the process.
- **Your API key never reaches the page.** Browser tokens are minted
  server-side by the runner, short-lived and single-use, exactly as your own
  backend would mint them in production.
- **Console sessions are labelled.** Every token carries `{ console: true }`
  metadata, so an agent can tell a dev-console call from a real one — see
  [Token metadata](/guides/token-metadata).
- **Nothing is logged.** The console prints no keys, no tokens and no
  transcripts; everything you see goes through the terminal view.

Still, it is a door into a process holding your API key. Do not run
`--ui-host 0.0.0.0` on a network you do not trust, and do not put the console
on the public internet — deploy an agent instead.

---

## Next

- [Build a live call app](/guides/build-a-live-call-app) — the dashboard your
  users see, built by hand.
- [Observe calls](/guides/observe-calls) — the console's job, done properly: any process, any browser, with replay and resume.
- [Events](/guides/events) — every event the observers see.
- [CLI reference](/reference/cli) — `pinecall run` and the rest.

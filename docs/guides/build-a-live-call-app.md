---
title: "Build a Live Call App"
description: "Two processes: a voice agent that books tables, and a host stand that watches the calls live — the agent and the web app deployed apart, a database between them, the call log as the live view."
---

# Build a Live Call App

> **`pinecall run` ships a console that does this out of the box** — call the
> agent from the browser, watch every call live, with no code
> ([The run console](/guides/run-console)). It is a development tool. Build your
> own when you need **your** design, **your** auth and **your** data next to the
> call — this guide is how.

This guide walks through **Bistro Aurora** — the finished code is
[`bistro/` in pinecall/examples](https://github.com/pinecall/examples/tree/main/bistro):

- a host that answers a **phone number** and **browser calls**, and books tables
  with a tool;
- a **host stand**: tonight's reservations, and every call **as it happens** —
  transcript, tool calls, who is speaking;
- as **two processes**. The agent is one, the web app is another. Deploy the
  web app ten times a day and not one call drops.

```
   guests ☎ 🎙 ───▶  Pinecall voice server ──▶ call log (seq, cursor)
                         ▲                           │ observe (stream token)
                         │ SDK websocket             ▼
            agent.js                          server.js (React Router)
            pc.agent · tools · watch          tonight · live calls · settings · /api/token
                         │                           │
                         └──────▶ bistro.db ◀────────┘      src/kitchen — the rules
```

If your app is small and one process is fine, read
[An agent your customer can configure](/tutorial/configurable-agent) instead —
same four nouns, one process, SSE in-process. This guide is for when that
stops being enough: see [Project structure](/guides/project-structure#when-one-process-stops-being-enough).

## 0. The layout

The same four nouns as the one-process app, under `src/`. Two processes means
**two entry files** — `agent.js` and `server.js` — not a monorepo:

```
bistro/
├── src/
│   ├── kitchen/      the business: reservations · settings — pure rules
│   ├── storage/      a Store interface, and SQLite (WAL) behind it
│   ├── agent/        the voice: prompt · tools · config · watch · main.ts (the process)
│   ├── web/          the host stand: React Router — tonight · live calls · settings
│   ├── server.ts     the host-stand process
│   └── config.ts     SLUG, PHONE, DB_FILE — read by both
├── agent.js          PROCESS 1 — a Pinecall process, no port, no HTTP
├── server.js         PROCESS 2 — never imports src/agent
└── Procfile          web + agent
```

```bash
git clone https://github.com/pinecall/examples && cd examples/bistro
npm install && cp .env.example .env     # PINECALL_API_KEY, a dev- slug, no phone yet
npm run build
```

## 1. The business, and the database both processes share

`src/kitchen` knows nothing about Pinecall or the web. The rules are pure
functions over a list:

```ts
// src/kitchen/reservations.ts
export function book(reservations: readonly Reservation[], input: NewReservation): Reservation {
  if (!availability(reservations, input.day).slots.includes(input.time)) {
    throw new Error(`${input.day} at ${input.time} is not available`);
  }
  const table = reservations.filter((r) => r.day === input.day && r.time === input.time).length + 1;
  return { ...input, reference: reference(input.day, input.time, table) };
}
```

and `createKitchen(store)` binds them to a `Store`. The store is **SQLite** —
`node:sqlite`, no native build — in WAL mode, because two processes read and
write it at once. A JSON file with the truth in memory would be one truth per
process, which is two truths. That is the first thing that changes when you
split: storage becomes a database.

`npm test` proves the two-process property without a socket: a booking made
through one `SqliteStore` is read through another opened on the same file.

## 2. The agent process

`src/agent/config.ts` — settings (the host's) on top, code (ours) below:

```ts
export const agentConfig = (s: Settings, tools: Tool[]) => ({
  greeting: s.greeting,
  voice: s.voice,
  language: s.language,
  promptVars: vars(s),

  prompt: PROMPT,
  llm: "openai/gpt-5.4-nano",
  stt: "soniox/stt-rt-v5",
  tools,
  phoneNumber: PHONE,
});
```

The tools are five lines each and the line that matters calls the kitchen:

```js
execute: async (input) => {
  try { return { booked: true, ...kitchen.reservations.book(input) }; }
  catch (err) { return { booked: false, reason: err.message }; }
},
```

That is the whole process — a Pinecall process, no port, no HTTP. The one
thing it does besides answering calls is **stay true to the database**. The
host saves settings in the other process; nobody tells the agent, so the agent
looks:

```ts
// src/agent/watch.ts — one row, once a second, and onChange when its stamp moved
export function watchSettings(kitchen: Kitchen, onChange: (s: Settings) => void, everyMs = 1000) {
  let seen = kitchen.settings.get().updatedAt;
  const timer = setInterval(() => {
    const settings = kitchen.settings.get();
    if (settings.updatedAt === seen) return;
    seen = settings.updatedAt;
    onChange(settings);
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
```

```ts
// src/agent/index.ts
const agent = pc.agent(SLUG, config(kitchen.settings.get()));
watchSettings(kitchen, (settings) => agent.update(config(settings)));
```

The next call is born with the new settings; calls in progress are not
disturbed. If the agent is down, the save still happened and it picks the
settings up at boot.

```bash
npm run agent      # registers the agent
```

## 3. The web app — never imports the agent

`src/web` is plain React Router. It never imports `src/agent` — ESLint makes
that a build failure — and the two processes never talk. The settings route
writes the shared database, and that is all:

```ts
// src/web/routes/api/settings.ts
export const action = async ({ request }) =>
  Response.json(kitchen.settings.update(await request.json()));   // bistro.db — the agent is watching
```

Tonight's service is a loader reading the same file the agent writes:

```ts
export const loader = () => ({ day, reservations: kitchen.reservations.service(day), agent: SLUG });
```

And the browser's tokens are minted here, with the key this process reads from
the same `.env` — a token needs the key, not the agent:

```ts
// src/web/routes/api/token.ts
export const action = async ({ request }) => {
  const { kind } = await request.json();                       // "webrtc" to talk, "stream" to watch
  return Response.json(await createToken({ channel: kind === "stream" ? "stream" : "webrtc", agentId: SLUG, apiKey }));
};
```

## 4. Talk — a call from the page

`VoiceSession` from `@pinecall/web/core`, with a token provider that calls
`/api/token`:

```tsx
sessionRef.current = new VoiceSession({
  agent,
  tokenProvider: () => fetch("/api/token", { method: "POST", body: JSON.stringify({ kind: "webrtc" }), headers: { "content-type": "application/json" } }).then((r) => r.json()),
});
```

## 5. Watch — calls you are not in, from a process that does not run the agent

This is the part that makes two processes work. Nothing travels through the web
server. The browser mints a **stream token** (`/api/token`) and attaches
**directly** to the voice server's [call log](/guides/call-log). Two hooks,
chained — that chain is the design:

```tsx
// src/web/components/LiveCalls.tsx
import { useAgentCalls, useCall } from "@pinecall/web/log/react";

function Calls({ agent, server, token }) {
  // 1 — which calls exist / are live: the agent's lifecycle log
  const { live, calls } = useAgentCalls(agent, { token, server });
  const current = live[0] ?? null;
  if (!current) return <p>Nobody on the line.</p>;
  return <Transcript call={current.call} token={token} server={server} />;
}

function Transcript({ call, token, server }) {
  // 2 — that call's log: messages as they are transcribed, tools as they land
  const s = useCall({ call, token, server });
  return (
    <ol>
      {s.messages.map((m) => <Bubble key={m.seq} who={m.role === "user" ? "user" : "bot"} text={m.text} draft={m.interim || m.speaking} />)}
      {s.toolCalls.map((t, i) => <Bubble key={i} who="tool" text={`${t.name} → ${short(t.result)}`} />)}
    </ol>
  );
}
```

Late join replays the backlog; a dropped socket resumes from the last `seq`;
a redeploy of the web app does not blink the panel. `@pinecall/web/log` is the
framework-free layer (`tail`, `poll`, `observe`, `CallLogView`) if you are not
on React.

> Needs `@pinecall/web` **≥ 0.5.1**: earlier builds keyed the agent log on
> the envelope's `call`, which is null there (the id is in `data.call`), and
> `useAgentCalls()` came back empty with the socket live. This very app is how
> that was found.

## 6. Run the whole thing

```bash
npm run agent      # terminal 1 — or `foreman start`: the Procfile is these two lines
npm start          # terminal 2 — http://localhost:3000
```

Open the host stand, press **Call the host**, ask for a table — and watch
yourself appear under *On the phone now*, tool call included, from a process
that has no idea you are talking to the other one. Edit the greeting under
*Settings*, save, and call again: the agent reloaded without restarting, and
nothing you did to the web app touched the call.

## What you did NOT build

An HTTP server inside the agent. An event bus between the processes. A webhook
receiver. A "was it delivered" table. The database is the fact; the call log
is the live view; the cursor is the protocol.

## What's next

- [Project structure](/guides/project-structure) — one process first, and what
  changes when you split
- [The call log](/guides/call-log) — the observation model this rests on
- [Deployment topologies](/concepts/deployment-topologies) — embedded vs
  standalone vs headless
- [Multi-tenant dashboards](/guides/multi-tenant) — scoping stream tokens per
  customer

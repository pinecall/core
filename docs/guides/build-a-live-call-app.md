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
            apps/agent (node)                 apps/web (React Router)
            pc.agent · tools · /token         tonight · live calls · settings
                         │                           │
                         └──────▶ bistro.db ◀────────┘      packages/kitchen — the rules
```

If your app is small and one process is fine, read
[An agent your customer can configure](/tutorial/configurable-agent) instead —
same four nouns, one process, SSE in-process. This guide is for when that
stops being enough: see [Project structure](/guides/project-structure#when-one-process-stops-being-enough).

## 0. The layout

```
bistro/
├── packages/kitchen/     the business + its storage: reservations, settings, SQLite (WAL)
├── apps/agent/           the voice: pc.agent() · tools · a tiny HTTP (tokens, reload)
├── apps/web/             the host stand: React Router — tonight · live calls · settings
└── bistro.db             one file, two processes
```

```bash
git clone https://github.com/pinecall/examples && cd examples/bistro
npm install && cp .env.example .env     # PINECALL_API_KEY, a dev- slug, no phone yet
npm run build
```

## 1. The business, and the database both processes share

`packages/kitchen` knows nothing about Pinecall or the web. The rules are pure
functions over a list:

```ts
// packages/kitchen/src/reservations.ts
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

`npm test` in the package proves the two-process property without a socket:
a booking made through one `SqliteStore` is read through another opened on the
same file.

## 2. The agent process

`apps/agent/src/agent.mjs` — settings (the host's) on top, code (ours) below:

```js
export function agentConfig(settings, kitchen) {
  return {
    greeting: settings.greeting,
    voice: settings.voice,
    language: settings.language,
    promptVars: { name: settings.name, hours: settings.hours, menu: settings.menu, notes: settings.notes },

    prompt: PROMPT,
    llm: "openai/gpt-5.4-nano",
    stt: "soniox/stt-rt-v5",
    tools: tools(kitchen),
    ...(PHONE ? { phoneNumber: PHONE } : {}),
  };
}
```

The tools are five lines each and the line that matters calls the kitchen:

```js
execute: async (input) => {
  try { return { booked: true, ...kitchen.reservations.book(input) }; }
  catch (err) { return { booked: false, reason: err.message }; }
},
```

And because **the API key lives in this process**, this process serves the two
things that need it — a tiny `node:http`:

| | |
|---|---|
| `POST /token { kind }` | `webrtc` / `chat` → `agent.createToken(kind)` — participate; `stream` → `pc.createToken("stream", slug)` — observe |
| `POST /reload` | re-read settings from the kitchen, `agent.update(agentConfig(...))` — the next call is born with them |
| `GET /health` | |

Loopback by default: the web app is the only caller.

```bash
npm run start:agent      # registers the agent · http on :8790
```

## 3. The web app — no key, no agent import

`apps/web` is plain React Router. It holds no Pinecall key and never imports
the agent. Two server-only helpers are the whole coupling:

```ts
// apps/web/app/lib/agent.server.ts
export async function reloadAgent(): Promise<boolean> {
  try { return (await fetch(`${config.agentUrl}/reload`, { method: "POST" })).ok; }
  catch { return false; }           // a host stand must save even if the agent is down
}
export async function mintToken(kind: "webrtc" | "stream") {
  return fetch(`${config.agentUrl}/token`, { method: "POST", body: JSON.stringify({ kind }), headers: { "content-type": "application/json" } });
}
```

The settings route writes the shared database, then asks the agent to reload:

```ts
// apps/web/app/routes/api/settings.ts
export const action = async ({ request }) => {
  const settings = kitchen.settings.update(await request.json());   // bistro.db
  const reloaded = await reloadAgent();                              // the other process
  return Response.json({ ...settings, agentReloaded: reloaded });
};
```

Tonight's service is a loader reading the same file the agent writes:

```ts
export const loader = () => ({ day, reservations: kitchen.reservations.service(day), agent: config.slug });
```

## 4. Talk — a call from the page

`VoiceSession` from `@pinecall/web/core`, with a token provider that goes
through our proxy (`/api/token` → the agent's `/token`):

```tsx
sessionRef.current = new VoiceSession({
  agent,
  tokenProvider: () => fetch("/api/token", { method: "POST", body: JSON.stringify({ kind: "webrtc" }), headers: { "content-type": "application/json" } }).then((r) => r.json()),
});
```

## 5. Watch — calls you are not in, from a process that does not run the agent

This is the part that makes two processes work. Nothing travels through the web
server. The browser mints a **stream token** (through the proxy) and attaches
**directly** to the voice server's [call log](/guides/call-log). Two hooks,
chained — that chain is the design:

```tsx
// apps/web/app/components/LiveCalls.tsx
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
npm run start:agent      # terminal 1
npm run start:web        # terminal 2 — http://localhost:3000
```

Open the host stand, press **Call the host**, ask for a table — and watch
yourself appear under *On the phone now*, tool call included, from a process
that has no idea you are talking to the other one. Edit the greeting under
*Settings*, save, and call again: the agent reloaded without restarting, and
nothing you did to the web app touched the call.

## What you did NOT build

An event bus between the processes. A webhook receiver. A "was it delivered"
table. The database is the fact; the call log is the live view; the cursor is
the protocol.

## What's next

- [Project structure](/guides/project-structure) — one process first, and what
  changes when you split
- [The call log](/guides/call-log) — the observation model this rests on
- [Deployment topologies](/concepts/deployment-topologies) — embedded vs
  standalone vs headless
- [Multi-tenant dashboards](/guides/multi-tenant) — scoping stream tokens per
  customer

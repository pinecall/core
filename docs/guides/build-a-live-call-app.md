---
title: "Build a Live Call App"
description: "One process, one .env: a dental clinic agent that answers the phone and the browser, and a console that shows every call as it happens — read from the call log over SSE, with call.log() writing the bookings into it."
---

# Build a Live Call App

> **`pinecall run` ships a console that does this out of the box** — call the
> agent from the browser, watch every call live, with no code
> ([The run console](/guides/run-console)). It is a development tool. Build your
> own when you need **your** design, **your** auth and **your** data next to the
> call — this guide is how.

This guide walks through **Dental Desk** — the finished code is
[`dental-desk/` in pinecall/examples](https://github.com/pinecall/examples/tree/main/dental-desk):

- an agent that answers a **phone number** and **browser calls**, and books
  appointments with a tool;
- a **console**: the clinic's settings, its archive, and every call **as it
  happens** — transcript, tool calls, who is speaking, and the bookings the
  agent made *inside* the timeline;
- as **one process**, one `.env`, four nouns. Splitting it later changes almost
  nothing, because the live panel never depended on sharing a process.

```
   patients ☎ 🎙 ───▶  voice.pinecall.io  ───▶  the call's log (seq, append-once)
                            ▲                        │
                            │ SDK websocket          │ GET …/events
                            │                        │ Accept: text/event-stream
                     src/agent  ──call.log()─────────┘        │
                            │                                 ▼
                            └──▶ src/clinic ──▶ db.json    the browser
                                 the rules      the archive  useAgentCalls + useCall
```

Two roads, and they never cross. Settings travel **inward** through the app's
own bus; everything about a **call** travels through the call log, which the
browser reads directly.

## 0. The layout — four nouns

```
dental-desk/
├── src/
│   ├── clinic/       THE BUSINESS — pure rules, zero I/O: appointments.ts · settings.ts · calls.ts · events.ts
│   ├── storage/      HOW IT PERSISTS — Store (interface) · JsonStore · MemoryStore · index.ts (the composition root)
│   ├── agent/        THE VOICE — prompt.ts · tools.ts · config.ts · wire.ts · index.ts
│   ├── web/          THE REACT ROUTER APP — routes/ · components/ · lib/token.ts
│   ├── bus.ts        a typed emitter — one event wide: "settings"
│   ├── config.ts     SLUG · PHONE · PORT · DB_FILE
│   └── server.ts     THE process: the agent boots, Express fronts React Router
└── server.js         chooses Vite or the build, opens the port
```

```bash
git clone https://github.com/pinecall/examples && cd examples/dental-desk
npm install && cp .env.example .env     # PINECALL_API_KEY, a dev- slug, no phone yet
npm run dev                             # http://localhost:3000
```

The dependency rule is `web → agent → clinic → storage`, every arrow pointing
inward, enforced by one ESLint override per folder. See
[Project structure](/guides/project-structure).

## 1. The business, and the tool that calls it

`src/clinic` is plain functions over plain data — no Pinecall, no React, no
disk:

```ts
// src/clinic/appointments.ts
export function book(rows: readonly AppointmentRow[], input: NewAppointment): AppointmentRow {
  if (!availability(rows, input.date).slots.includes(input.time)) {
    throw new Error(`${input.date} ${input.time} is not available`);
  }
  return { ...input, reference: reference(input.date, input.time) };
}
```

The tool is thin, and it does **two** things: it books, and it says so *in the
call*.

```ts
// src/agent/tools.ts
const bookAppointment = tool({
  name: "book_appointment",
  description: "Book an appointment for a patient.",
  schema: z.object({ date: z.string(), time: z.string(), patient: z.string() }),
  execute: async (input, call) => {                       // ← the Call, second argument
    try {
      const booked = clinic.appointments.book(input);
      call.log("appointment.booked", booked, { id: `${booked.date}T${booked.time}` });
      return { booked: true, ...booked };
    } catch (err) {
      call.log("appointment.refused", { ...input, reason: err.message });
      return { booked: false, reason: err.message };
    }
  },
});
```

`call.log(name, value, { id })` appends a durable `custom` entry to this call's
log — with its own `seq`, next to the transcript, persisted, replayed to a tab
that reloads. `id` is the slot, so a model that calls the tool twice for the
same appointment **upserts one row** instead of confirming twice.

The vocabulary is one type, so the browser can be typed against it:

```ts
// src/clinic/events.ts
export type CallLog = {
  "appointment.booked": AppointmentRow;
  "appointment.refused": { date: string; time: string; reason: string };
};
```

## 2. The token route — the only thing your backend does for the panel

The browser reads `voice.pinecall.io` directly. Your server's whole job is to
mint a short-lived, read-only token with the API key it already has:

```ts
// src/web/routes/api/token.ts
export const action = async ({ request }: Route.ActionArgs) => {
  const scope = new URL(request.url).searchParams.get("scope");
  return Response.json(
    scope === "observe"
      ? await pc.createToken("stream", SLUG, undefined, { scope: "observe" })  // to WATCH
      : await pc.createToken("webrtc", SLUG),                                  // to TALK
  );
};
```

The call page mints the observe token **in its loader**, so the panel is
watching on the first paint; the route is what an expired tab comes back to.
`scope: "observe"` means exactly that: no microphone, no control verbs, no other
agent, and the API key never leaves the server.

## 3. The live panel — two hooks, chained

```tsx
// src/web/components/AgentLive.tsx — which calls exist, which are live
import { useAgentCalls } from "@pinecall/web/log/react";

export function AgentLive({ agent, token, server }) {
  const { live } = useAgentCalls(agent, { token, server });
  if (live.length === 0) return <p>Nobody on the line.</p>;
  return live.map((row) => <LiveCall key={row.call} call={row.call} token={token} server={server} />);
}
```

One `<LiveCall>` per live call, **keyed by call id** — two calls at once are two
panels, never one painted over the other.

```tsx
// src/web/components/LiveCall.tsx — one call's content
import { useCall } from "@pinecall/web/log/react";
import type { CallLog } from "~/clinic/events";

export function LiveCall({ call, token, server }) {
  // throttle and reconnectOnMount are left at their defaults on purpose:
  // one render per macrotask, and a reload resumes from the stored seq.
  const s = useCall<CallLog>({
    call, token, server,
    onCustom: (name, value, _entry) => {          // three params — the arity matters
      if (name === "appointment.booked") toast(`Booked ${value.reference}`);
    },
  });

  return <LiveTimeline messages={s.messages} tools={s.toolCalls} custom={s.custom} phase={s.phase} />;
}
```

> ⚠️ **`onCustom` narrows only at exact arity.** Declare all three parameters —
> `(name, value, _entry) => …`. Drop `_entry` and TypeScript stops
> contextually typing the union of parameter tuples, and `value` widens back to
> `unknown`.

`LiveTimeline` merges `messages`, `toolCalls` and `custom` **by `seq`**, which is
the whole point of the booking being a log entry: it draws between the tool call
that made it and the sentence the bot said next, not in a list off to one side.

**Three things you get for free, and none of them are React:**

- **A page reload keeps the transcript.** `reconnectOnMount` (default `true`)
  parks `{seq, ts}` in `localStorage` under `pc:log:<call>` and resumes from it.
  Nothing in memory replays; the cursor does the work. It is cleared when
  `call.summary` lands and ignored after 24 h.
- **It is not *this* process's call.** Any copy of the app answering the phone
  shows up here, and so does a call that started before the tab was opened.
- **No WebSocket is opened.** `transport` defaults to `"auto"` = SSE, degrading
  to the JSON cursor. Observing is a read. See
  [Observe calls](/guides/observe-calls).

## 4. Talk — a call from the same page

`VoiceSession` from `@pinecall/web/core`, with a token provider that calls the
same route:

```tsx
new VoiceSession({
  agent: SLUG,
  tokenProvider: () => fetch("/api/token", { method: "POST" }).then((r) => r.json()),
});
```

While *you* talk, the transcript grows word by word straight off the
DataChannel — that is what **this browser** is hearing. The panel below it is
the other view: the agent's own log, which includes the call you are on and
every other one.

## 5. Settings — the road that is not the call log

```
form action ──► Settings.update() ──► bus.emit("settings") ──► agent.update()
```

One event, one process, one listener. `pc.agent()` hot-reloads: the next call is
born with the new voice, calls in progress are not disturbed, nothing restarts.
The clinic never emits it — `Settings.update()` returns the new settings and the
caller announces them.

That bus is **one event wide** on purpose. Everything about a call already has a
log with a cursor, replay and history; re-broadcasting it through an in-process
emitter would be a second, worse copy that dies with the process.

## 6. Run it

```bash
npm run dev            # http://localhost:3000
```

Press **Llamar**, ask for an appointment on a free slot — and watch yourself
appear under *En el agente ahora*: the transcript, the `book_appointment` chip,
and the booking row between them. Reload the page mid-call: the transcript is
still there. Change the voice under *Settings*, save, call again.

`PHONE` is optional — without it, everything works in the browser. Set
`DENTAL_DESK_SLUG=dev-<you>` and leave `PHONE` empty while you develop, or your
laptop claims the production number ([Dev mode](/guides/dev-mode)).

`npm run typecheck` · `npm run lint` (the arrow) · `npm test` · `npm run build`.

## What you did NOT build

An `/api/events` route relaying an event bus. A "was it delivered" table. A
webhook receiver. A WebSocket. A second copy of the transcript in your database
so a reload has something to show.

The clinic's own archive (`db.json`, written by `src/agent/wire.ts`) is the
business fact. The call log is the live view, and the cursor is the protocol.

## What's next

- [Observe calls](/guides/observe-calls) — every way to read the log, and every default
- [The Call Log](/guides/call-log) — the wire this rests on
- [Project structure](/guides/project-structure) — the four nouns, and what changes when you split
- [Deployment topologies](/concepts/deployment-topologies) — embedded vs standalone vs headless
- [Multi-tenant dashboards](/guides/multi-tenant) — scoping stream tokens per customer

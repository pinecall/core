---
title: "SSE Event Streaming"
description: "Stream agent events to your frontend in real time with Server-Sent Events."
---

# SSE Event Streaming

> **Building a dashboard or observing calls? Use the [call log](/guides/call-log) instead.**
> SSE only exists inside the process that runs the agent, has no cursor, and a
> disconnected client silently loses everything emitted while it was away. The
> call log (`WS /v1/attach` + `@pinecall/web/log`) works from **any** process,
> replays what you missed, and reconnects without losing an entry. SSE remains
> useful as a zero-dependency, in-process tap — e.g. piping raw events into an
> analytics pipeline that lives in the same process as the agent.

The SDK can stream every agent event (calls, speech, tools, metrics) to any HTTP client as Server-Sent Events, as long as the client connects to the process that runs the agent.

## The basics

```typescript
import express from "express";
import { Pinecall } from "@pinecall/sdk";

const app = express();
const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });

// Stream all events from all agents
app.get("/events", (req, res) => pc.stream(res));

app.listen(3000);
```

Open `http://localhost:3000/events` in a browser or connect with `EventSource` — you'll see every event as it happens.

## Two ways to stream

### `pc.stream()` — all agents

Streams events from every agent on this `Pinecall` instance:

```typescript
// Express / Node.js ServerResponse
app.get("/events", (req, res) => pc.stream(res));

// Hono / Web API Response (no res argument)
app.get("/events", () => pc.stream());
```

### `agent.stream()` — one agent

Streams events scoped to a single agent:

```typescript
const mara = pc.agent("mara", { /* ... */ });

app.get("/events/mara", (req, res) => mara.stream(res));
app.get("/events/mara", () => mara.stream());
```

### Filtering by agent name

If you have multiple agents but only want events from specific ones:

```typescript
app.get("/events", (req, res) => pc.stream(res, { agents: ["mara", "support"] }));
```

## Event format

Each SSE event has an `event:` type and a JSON `data:` body:

```
event: call.started
data: {"callId":"CA_abc","from":"+34611111111","agent":"mara","direction":"inbound"}

event: user.message
data: {"callId":"CA_abc","text":"Hola, quiero reservar","messageId":"msg_1","agent":"mara"}

event: bot.speaking
data: {"callId":"CA_abc","text":"¡Claro! ¿Para cuándo?","messageId":"msg_2","agent":"mara"}

event: call.ended
data: {"callId":"CA_abc","reason":"hangup","duration":45,"agent":"mara"}
```

A `:ping` comment is sent every 30 seconds as a keepalive to prevent proxy timeouts.

## Connecting from the browser

Use the native `EventSource` API:

```typescript
const events = new EventSource("/events");

events.addEventListener("call.started", (e) => {
  const data = JSON.parse(e.data);
  console.log(`New call from ${data.from} on agent ${data.agent}`);
});

events.addEventListener("user.message", (e) => {
  const data = JSON.parse(e.data);
  addToTranscript("user", data.text);
});

events.addEventListener("bot.speaking", (e) => {
  const data = JSON.parse(e.data);
  addToTranscript("bot", data.text);
});

events.addEventListener("call.ended", (e) => {
  const data = JSON.parse(e.data);
  console.log(`Call ended: ${data.reason} (${data.duration}s)`);
});
```

`EventSource` auto-reconnects on disconnect — no manual retry logic needed.

## Building a live call monitor

A minimal React component that shows active calls:

```tsx
function CallMonitor() {
  const [calls, setCalls] = useState(new Map());

  useEffect(() => {
    const es = new EventSource("/events");

    es.addEventListener("call.started", (e) => {
      const d = JSON.parse(e.data);
      setCalls((prev) => new Map(prev).set(d.callId, {
        from: d.from, agent: d.agent, started: Date.now(), transcript: [],
      }));
    });

    es.addEventListener("user.message", (e) => {
      const d = JSON.parse(e.data);
      setCalls((prev) => {
        const next = new Map(prev);
        const call = next.get(d.callId);
        if (call) call.transcript.push({ role: "user", text: d.text });
        return next;
      });
    });

    es.addEventListener("call.ended", (e) => {
      const d = JSON.parse(e.data);
      setCalls((prev) => { const next = new Map(prev); next.delete(d.callId); return next; });
    });

    return () => es.close();
  }, []);

  return (
    <div>
      <h2>Active Calls ({calls.size})</h2>
      {[...calls.entries()].map(([id, call]) => (
        <div key={id}>
          <strong>{call.agent}</strong> — {call.from}
          {call.transcript.map((t, i) => <p key={i}>{t.role}: {t.text}</p>)}
        </div>
      ))}
    </div>
  );
}
```

## When SSE works (and when it doesn't)

SSE streaming requires the agent and the HTTP endpoint to run in the **same process**. This is the key architectural constraint:

| Topology | SSE works? | Why |
|---|---|---|
| Agent + web server in one process | ✅ | `pc.stream()` has direct access to events |
| Agent in a separate process (Docker, serverless) | ❌ | Events never reach the web server process |

If you run agents in separate processes, don't build an event bus — that's exactly the case the [call log](/guides/call-log) exists for: any process attaches to `WS /v1/attach` with a stream token and reads the same log, with replay and cursor resume included. See [Deployment Topologies](/concepts/deployment-topologies).

## Framework examples

### Express

```typescript
app.get("/events", (req, res) => pc.stream(res));
```

### Hono

```typescript
app.get("/events", () => pc.stream());
```

### Next.js API Route

```typescript
// app/api/events/route.ts
export async function GET() {
  return pc.stream();
}
```

### Fastify

```typescript
fastify.get("/events", (req, reply) => {
  pc.stream(reply.raw);
});
```

## What's next

- [The Call Log](/guides/call-log) — the canonical way to observe calls, from any process
- [WebSocket Streaming](/guides/ws-streaming) — bidirectional in-process alternative
- [Events reference](/reference/events) — every event with payload shapes
- [Multi-tenant](/guides/multi-tenant) — scope observation per customer

---
title: "WebSocket Event Streaming"
description: "Stream agent events over WebSocket for bidirectional, real-time communication with your frontend."
---

# WebSocket Event Streaming

The SDK can stream agent events over WebSocket — a bidirectional alternative to [SSE streaming](/guides/sse-streaming). Like SSE, your agent and web server must run in the same process. Unlike SSE, WebSocket supports **two-way communication** and works better for complex client apps.

## When to use WebSocket vs SSE

| Feature | SSE (`agent.stream()`) | WebSocket (`agent.ws()`) |
|---|---|---|
| Direction | Server → Client only | Bidirectional |
| Client sends actions | ❌ | ✅ `ping` (more planned) |
| Session scoping | ❌ All events broadcast | ✅ Filter to one call |
| Tool results | ❌ | ✅ `llm.tool_result` |
| Browser API | `EventSource` | `WebSocket` |
| Auto-reconnect | Built into `EventSource` | SDK provides `createEventStream` |

**Use SSE** for simple dashboards where you just display data.
**Use WebSocket** when you need to send actions back, scope events to a session, or receive tool results.

## Server-side: `agent.ws()`

Pipe all events from an agent to a WebSocket connection:

```typescript
import express from "express";
import { Pinecall } from "@pinecall/sdk";
import { WebSocketServer } from "ws";

const app = express();
const pc = new Pinecall();

const pines = pc.agent("pines", { /* ... */ });

const server = app.listen(3000);
const wss = new WebSocketServer({ server, path: "/ws/events" });

wss.on("connection", (ws) => {
  pines.ws(ws);
});
```

Each event is sent as a JSON message:

```json
{ "event": "call.started", "callId": "CA_abc", "from": "+1234", "agent": "pines" }
{ "event": "bot.word", "word": "hello", "agent": "pines" }
{ "event": "call.ended", "callId": "CA_abc", "reason": "hangup", "agent": "pines" }
```

### Session scoping

Filter events to a specific call:

```typescript
wss.on("connection", (ws, req) => {
  const sessionId = new URL(req.url!, "http://x").searchParams.get("session");
  pines.ws(ws, { sessionId: sessionId || undefined });
});
```

Now only events from that call are forwarded — useful for per-customer dashboards.

### Include tool results

By default, `llm.toolCall` is included but `llm.tool_result` is not. Enable it:

```typescript
pines.ws(ws, { toolResults: true });
```

## Client-side: `createEventStream()`

The SDK includes a browser client with auto-reconnect:

```typescript
import { createEventStream } from "@pinecall/sdk";

const stream = createEventStream({
  url: "ws://localhost:3000/ws/events",
});

stream.on("call.started", (data) => {
  console.log(`Call from ${data.from}`);
});

stream.on("bot.word", (data) => {
  appendToTranscript(data.word);
});

stream.on("llm.tool_result", (data) => {
  updateToolCard(data.name, data.result);
});

// Wildcard — receive all events
stream.on("*", (data) => {
  console.log(data.event, data);
});
```

### Sending actions

WebSocket is bidirectional — send messages back to the server:

```typescript
stream.send({ action: "ping" }); // server replies with { event: "pong" }
```

> Action support is currently limited to `ping`. Richer actions (`inject_text`, `set_context`) are planned.

### Connection status

```typescript
stream.onStatus((status) => {
  // "idle" | "connecting" | "connected" | "error"
  updateConnectionBadge(status);
});
```

### Cleanup

```typescript
stream.close();  // Disconnects and stops auto-reconnect
```

## Building a live call monitor (WebSocket version)

```tsx
import { createEventStream } from "@pinecall/sdk";

function CallMonitor() {
  const [calls, setCalls] = useState(new Map());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const stream = createEventStream({
      url: "ws://localhost:3000/ws/events",
    });

    stream.onStatus((s) => setConnected(s === "connected"));

    stream.on("call.started", (d) => {
      setCalls((prev) => new Map(prev).set(d.callId, {
        from: d.from, agent: d.agent, transcript: [],
      }));
    });

    stream.on("bot.word", (d) => {
      setCalls((prev) => {
        const next = new Map(prev);
        const call = next.get(d.callId);
        if (call) call.transcript.push(d.word);
        return next;
      });
    });

    stream.on("call.ended", (d) => {
      setCalls((prev) => {
        const next = new Map(prev);
        next.delete(d.callId);
        return next;
      });
    });

    return () => stream.close();
  }, []);

  return (
    <div>
      <h2>Active Calls ({calls.size}) {connected ? "🟢" : "🔴"}</h2>
      {[...calls.entries()].map(([id, call]) => (
        <div key={id}>
          <strong>{call.agent}</strong> — {call.from}
          <p>{call.transcript.join(" ")}</p>
        </div>
      ))}
    </div>
  );
}
```

## Framework examples

### Express + ws

```typescript
import { WebSocketServer } from "ws";

const server = app.listen(3000);
const wss = new WebSocketServer({ server, path: "/ws/events" });
wss.on("connection", (ws) => pines.ws(ws));
```

### Fastify + @fastify/websocket

```typescript
fastify.register(require("@fastify/websocket"));
fastify.get("/ws/events", { websocket: true }, (socket) => {
  pines.ws(socket);
});
```

### Next.js (Pages API)

```typescript
// pages/api/ws.ts
export default function handler(req, res) {
  if (!res.socket.server.wss) {
    const wss = new WebSocketServer({ noServer: true });
    res.socket.server.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => pines.ws(ws));
    });
    res.socket.server.wss = wss;
  }
  res.end();
}
```

## Topology constraints

Like SSE, WebSocket streaming requires the agent and web server in the **same process**:

| Topology | Works? | Why |
|---|---|---|
| Agent + web server in one process | ✅ | `agent.ws()` has direct event access |
| Agent in a separate process | ❌ | Events don't cross process boundaries |

## What's next

- [SSE Streaming](/guides/sse-streaming) — the simpler, one-way alternative
- [WebRTC Browser](/guides/webrtc-browser) — for voice calling from the browser
- [Events Reference](/reference/events) — every event with payload shapes

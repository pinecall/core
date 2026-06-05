---
title: "Pinecall"
description: "The WebSocket client. Manages auth, reconnection, and agent multiplexing."
---

# Pinecall

The WebSocket client. One per process. Manages the connection to `voice.pinecall.io`, handles auth and reconnection, and multiplexes events across multiple agents.

## Constructor

```typescript
new Pinecall(options)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | — *(required)* | Your Pinecall API key |
| `url` | `string` | `wss://voice.pinecall.io/client` | WebSocket endpoint |
| `reconnect` | `boolean` | `true` | Auto-reconnect on disconnect |
| `pingInterval` | `number` | `30000` | Keepalive interval in ms |

### Example

```typescript
const pc = new Pinecall({
  apiKey: process.env.PINECALL_API_KEY!,
});
```

## Methods

### `connect()`

Open the WebSocket connection and authenticate. Returns a promise that resolves when auth succeeds.

```typescript
await pc.connect();
```

### `disconnect()`

Gracefully close the connection.

```typescript
await pc.disconnect();
```

### `agent(id, config?)`

Create or retrieve an agent. If an agent with this ID already exists, returns it (idempotent).

```typescript
const agent = pc.agent("support", {
  voice: "elevenlabs/sarah",
  language: "en",
  llm: { provider: "openai", model: "gpt-4.1-mini", enabled: true, prompt: "..." },
});
```

See [`Agent`](/api/agent) for full config.

### `deploy(id, config)`

Shortcut for `agent() + addChannel()`. Combines agent creation, LLM config, and channel registration in one call.

```typescript
const mara = pc.deploy("mara", {
  prompt: "You are Mara. Be concise.",
  model: "gpt-4.1-mini",
  voice: "elevenlabs/sarah",
  greeting: "Hi! How can I help you today?",
  language: "es",
  channels: ["webrtc", "+13186330963"],
});
```

Dynamic greetings with a function:

```typescript
greeting: async (call) => {
  const customer = await db.findByPhone(call.from);
  return `Hi ${customer.name}! How can I help?`;
},
```

Greeting without LLM history (e.g. a standalone announcement):

```typescript
greeting: { text: "Welcome! Please hold.", addToHistory: false },
```

**`DeployConfig` fields:**

| Field | Type | Description |
|---|---|---|
| `prompt` | `string` | System prompt for the LLM |
| `model` | `string` | LLM model (default: `gpt-4.1-mini`) |
| `voice` | `string` | TTS voice shortcut (e.g. `elevenlabs/sarah`) |
| `stt` | `string` | STT shortcut (e.g. `deepgram/flux-en`) |
| `greeting` | `string \| { text, addToHistory? } \| (call) => string` | Greeting spoken on inbound calls. Added to LLM history by default. |
| `language` | `string` | BCP-47 language code |
| `tools` | `array` | OpenAI function-calling tool definitions |
| `channels` | `string[]` | Channels to register: `"webrtc"`, `"chat"`, or phone numbers |
| `sessionLimits` | `object` | Session timeout config (see [Session Limits](/reference/session-limits)) |
| `allowedOrigins` | `string[]` | Allowed origins for public browser token access (see [Security](/security)) |

### `getAgent(id)`

Look up an agent by ID. Returns `Agent | undefined`.

```typescript
const mara = pc.getAgent("mara");
```

### `removeAgent(id)`

Unregister an agent. Returns `boolean` indicating whether the agent existed.

```typescript
const removed = pc.removeAgent("mara");
```

### `createToken(channel, agentId)`

Generate a short-lived, single-use token for browser WebRTC or chat connections. Used to mint tokens for browsers.

```typescript
const token = await pc.createToken("webrtc", "mara");
// { token, server, expiresIn }
```

See [Security](/security) for the full token model.

### `stream(res?, options?)`

Open an SSE stream of agent events. Works with any framework — returns a Web API `Response` or writes to a Node.js `ServerResponse`.

```typescript
// Web API (Remix, Next.js, Hono, Bun)
app.get("/events", () => pc.stream());

// Express / Node.js
app.get("/events", (req, res) => pc.stream(res));

// Filtered to specific agents
app.get("/events", () => pc.stream({ agents: ["mara", "support"] }));
app.get("/events", (req, res) => pc.stream(res, { agents: ["mara"] }));
```

See [Multi-tenant guide](/guides/multi-tenant) for the filtering pattern.

## Events

Subscribe via `pc.on(event, handler)`.

| Event | Signature | When |
|---|---|---|
| `connected` | `()` | WebSocket auth succeeded |
| `disconnected` | `(reason)` | Connection closed |
| `reconnecting` | `(attempt)` | Auto-reconnect attempt N |
| `error` | `(err)` | Protocol or transport error |

```typescript
pc.on("connected", () => console.log("Live"));
pc.on("disconnected", (reason) => console.log("Down:", reason));
pc.on("reconnecting", (n) => console.log(`Retry ${n}`));
pc.on("error", (err) => console.error(err));
```

## What's next

- [`Agent`](/api/agent) — channels, events, hot-reload, dial
- [`Call`](/api/call) — per-session control
- [Security](/security) — token model and best practices

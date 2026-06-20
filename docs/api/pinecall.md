---
title: "Pinecall"
description: "The WebSocket client. Manages auth, reconnection, and agent multiplexing."
---

# Pinecall

The WebSocket client. One per process. Manages the connection to `voice.pinecall.io`, handles auth and reconnection, and multiplexes events across multiple agents.

**Auto-connects on construction.** When you create a `Pinecall` instance with an API key, it connects immediately — no need to call `connect()`.

## Constructor

```typescript
new Pinecall(options)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | `PINECALL_API_KEY` env var | Your Pinecall API key. Auto-read from env if not provided. |
| `apiUrl` | `string` | `wss://voice.pinecall.io` | Server URL |
| `autoReconnect` | `boolean` | `true` | Auto-reconnect on disconnect |
| `promptsDir` | `string` | `"prompts"` | Prompts directory for `setPromptFile` |

### Example

```typescript
// Reads PINECALL_API_KEY from env automatically
const pc = new Pinecall();

// Or pass explicitly
const pc = new Pinecall({ apiKey: "pk_..." });
```

Agents can be created immediately — they queue and register when the connection is ready:

```typescript
const pc = new Pinecall();
const agent = pc.agent("support", { /* ... */ }); // works before connected
```

## Methods

### `ready`

`Promise<void>` that resolves when the connection is established. Use it when you need to wait for the connection before proceeding (e.g. before dialing an outbound call).

```typescript
await pc.ready;
const call = await agent.dial({ to: "+14155551234" });
```

### `connect()`

Manually open the WebSocket connection. **Rarely needed** — the constructor auto-connects when an API key is present. Idempotent (safe to call multiple times).

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
  llm: "openai/gpt-5-chat-latest",
  stt: "deepgram/flux",
  prompt: "You are a support agent. Be concise.",
  greeting: "Hi! How can I help you today?",
  phoneNumber: "+13186330963",
});
```

**`AgentConfig` fields:**

| Field | Type | Description |
|---|---|---|
| `voice` | `string \| VoiceConfig` | TTS voice shortcut (e.g. `elevenlabs/sarah`) |
| `language` | `string` | BCP-47 language code |
| `stt` | `string \| STTConfig` | STT shortcut (e.g. `deepgram/flux`) |
| `llm` | `string \| LLMConfig` | LLM shortcut (e.g. `openai/gpt-5-chat-latest`) or full config |
| `prompt` | `string` | System prompt for the LLM |
| `greeting` | `string \| { text, addToHistory? } \| (call) => string` | Greeting spoken on inbound calls. Added to LLM history by default. |
| `tools` | `Tool[]` | Declarative tool definitions created with `tool()` |
| `phoneNumber` | `string \| PhoneNumberConfig` | Phone number or SIP URI to register (Twilio) |
| `phoneNumbers` | `Array<string \| PhoneNumberConfig>` | Multiple phone numbers with per-number config (e.g. one per language) |
| `whatsapp` | `WhatsAppChannelConfig[]` | WhatsApp channels (Meta Cloud API credentials) |
| `sessionLimits` | `object` | Session timeout config (see [Session Limits](/reference/session-limits)) |
| `allowedOrigins` | `string[]` | Allowed origins for public browser token access (see [Security](/security)) |

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

See [`Agent`](/api/agent) for full API reference.

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

### `createToken(channel, agentId, metadata?)`

Generate a short-lived, single-use token for browser **WebRTC** or **chat** connections. Used to mint tokens for browsers.

```typescript
const token = await pc.createToken("webrtc", "mara");
// { token, server, expiresIn }
```

**Sealed session metadata** — pass a third argument to bake trusted context into the token:

```typescript
const token = await pc.createToken("chat", "mara", { userId: "u_123", plan: "pro" });
```

The metadata is **sealed into the signed token on your server**, so the browser cannot forge or alter it. It surfaces as [`call.metadata`](/api/call) in your `call.started` handler — use it for per-user / multi-tenant context you can trust (auth identity, plan, tenant id). Works identically for `"webrtc"` and `"chat"`.

> With an `Agent` instance, use `agent.createToken(channel, metadata?)` (the `agentId` is implicit).

> ⚠️ This is **not** the client-supplied `metadata` prop on the widget / `VoiceSession` — that is set in the browser and can be forged. For anything used in authorization, seal it in the token here.

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
| `reconnecting` | `(attempt, delay)` | Auto-reconnect attempt N |
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

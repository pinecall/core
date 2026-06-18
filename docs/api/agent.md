---
title: "Agent"
description: "Owns channels, routes call events, stores defaults, dials outbound calls."
---

# Agent

Created via `pc.agent(id, config?)`. Owns channels, routes call events, stores defaults, dials outbound calls.

## Creation

```typescript
import { tool } from "@pinecall/sdk";
import { z } from "zod";

const lookupOrder = tool({
  name: "lookupOrder",
  description: "Look up an order by ID",
  schema: z.object({ id: z.string() }),
  execute: async ({ id }) => ({ status: "shipped", eta: "today" }),
});

const agent = pc.agent("my-agent", {
  voice: "elevenlabs/sarah",
  language: "es",
  stt: "deepgram/flux",
  llm: "openai/gpt-5-chat-latest",
  prompt: "System prompt with {{template_vars}}.",
  greeting: "Hello! How can I help you today?",
  phoneNumber: "+13186330963",
  tools: [lookupOrder],
});
```

| Config field | Type | Description |
|---|---|---|
| `voice` | `string \| VoiceConfig` | TTS provider — shortcut or full config |
| `language` | `string` | BCP-47 language code |
| `stt` | `string \| STTConfig` | STT provider — shortcut or full config |
| `llm` | `LLMConfig` | LLM provider, model, prompt, enabled flag |
| `tools` | `Tool[]` | Declarative tools created with `tool()` + Zod schemas (auto-executed) |
| `phoneNumber` | `string \| PhoneNumberConfig` | Phone number to register (E.164 or SIP URI) |
| `phoneNumbers` | `Array<string \| PhoneNumberConfig>` | Multiple numbers with per-number config |
| `whatsapp` | `WhatsAppChannelConfig[]` | WhatsApp channels to register |
| `history` | `HistoryStore` | Conversation persistence (see [History](/guides/conversation-history)) |
| `sessionLimits` | `SessionLimits` | Duration / idle timeout config |
| `interruption` | `InterruptionConfig` | Energy thresholds for barge-in |
| `analysis` | `AnalysisConfig` | Audio metrics streaming |
| `allowedOrigins` | `string[]` | Public token access (see [Security](/security)) |

See [Reference → Providers](/reference/stt-providers) for full provider configs.

## Phone numbers

### `addPhoneNumber(number, config?)`

Register a phone number or SIP URI. Idempotent — calling again with the same number updates its config.

```typescript
agent.addPhoneNumber("+13186330963");
agent.addPhoneNumber("sip:bot@trunk.twilio.com");

// Per-number config overrides
agent.addPhoneNumber("+34911234567", {
  voice: "elevenlabs/valentina",
  language: "es",
});
```

### `removePhone(number)`

Unregister a phone number.

```typescript
agent.removePhone("+34911234567");
```

## WhatsApp

### `addWhatsapp(config)`

Register a WhatsApp channel. Idempotent.

```typescript
agent.addWhatsapp({
  phoneNumberId: "123456789012345",
  accessToken: "EAABx...",
  verifyToken: "my-secret",
  appSecret: "abc123...",
});
```

See [WhatsApp guide](/guides/whatsapp) for full config.

### `removeWhatsapp(phoneNumberId)`

Unregister a WhatsApp channel.

```typescript
agent.removeWhatsapp("123456789012345");
```

## Config & hot-reload

### `update(opts)`

Hot-reload the agent's defaults. Affects all **future** calls — existing calls keep their current config.

```typescript
agent.update({ voice: "elevenlabs/claire", language: "fr" });
agent.update({ stt: "gladia" });
agent.update({ llm: "openai/gpt-5-chat-latest", prompt: "..." });
```

### `configureSession(callId, opts)`

Update config for a live call (equivalent to `call.update()`).

```typescript
agent.configureSession("CA7ec...", { language: "es" });
```

### `getConfig()`

Returns the current `AgentConfig`.

```typescript
const cfg = agent.getConfig();
```

## Outbound calls

### `dial(options)`

Make an outbound call. Returns `Promise<Call>`.

```typescript
const call = await agent.dial({
  to: "+14155551234",
  from: "+13186330963",
  greeting: "Hi! This is a follow-up call.",
  metadata: { appointmentId: "appt_001" },
  config: { voice: "cartesia/yumiko", language: "ar" },
});
```

| Field | Type | Required | Description |
|---|---|---|---|
| `to` | `string` | ✅ | Destination number (E.164) |
| `from` | `string` | — | Caller ID — auto-resolved if agent has one phone channel. Required when multiple. |
| `greeting` | `string` | — | Text the server speaks when callee picks up |
| `metadata` | `object` | — | Custom data attached to the call |
| `config` | `object` | — | Per-call config override (voice, STT, language) |

See [Outbound Calls guide](/guides/outbound-calls) for the full pattern.

## Tokens

### `createToken(channel)`

Mint a short-lived token for browser WebRTC or chat. Scoped to this agent.

```typescript
const token = await agent.createToken("webrtc");
// { token, server, expiresIn }
```

## Dev mode

### `routeCallers(numbers)`

Route phone and WhatsApp messages from these numbers to this agent (instead of any other agent registered on the same channel). Used for dev mode isolation.

```typescript
agent.routeCallers(["+34600123456", "+34612345678"]);
```

See [Dev mode guide](/guides/dev-mode).

## Human-in-the-loop

Pause the AI so a human can take over the conversation. Works on WhatsApp and (soon) voice/chat channels.

### `pause(target?)`

Pause the agent. While paused, incoming messages are forwarded to the SDK but the LLM doesn't respond.

```typescript
// Pause a specific session
agent.pause("wa-abc123");

// Pause all sessions with a contact
agent.pause({ contact: "+34612345678" });

// Pause the entire agent
agent.pause();
```

### `resume(target?)`

Resume the AI after a pause. Global resume clears all session and contact pauses.

```typescript
agent.resume("wa-abc123");
agent.resume({ contact: "+34612345678" });
agent.resume();
```

### `sendMessage(opts)`

Send a message as the human operator. The message is delivered through the channel (e.g. WhatsApp) and added to LLM history so the AI has context when resumed.

```typescript
agent.sendMessage({
  sessionId: "wa-abc123",
  text: "Hi, I'm taking over this conversation.",
});
```

| Field | Type | Required | Description |
|---|---|---|---|
| `sessionId` | `string` | ✅ | Target session ID (e.g. `wa-abc123`) |
| `text` | `string` | ✅ | Message body |

See [Human Takeover guide](/guides/human-takeover) for the full pattern.

## Calls

### `call(callId)`

Look up a live `Call` by ID. Returns `Call | undefined`.

```typescript
const call = agent.call("CA7ec...");
```

## Observability

### `stream(res?)`

Open an SSE stream of this agent's events. Same shape as `pc.stream()` but scoped to one agent.

```typescript
app.get("/events", () => agent.stream());
app.get("/events", (req, res) => agent.stream(res));
```

## Events

Subscribe via `agent.on(event, handler)`. All call-scoped events include `call` as the last argument.

### Lifecycle

| Event | Signature | When |
|---|---|---|
| `call.started` | `(call)` | New call connected |
| `call.ended` | `(call, reason)` | Call disconnected |

### User speech

| Event | Signature | When |
|---|---|---|
| `speech.started` | `(event, call)` | User began speaking (VAD) |
| `speech.ended` | `(event, call)` | User stopped speaking (VAD) |
| `user.speaking` | `(event, call)` | Interim STT transcript (updates live) |
| `user.message` | `(event, call)` | Final confirmed user text |

### Turns

| Event | Signature | When |
|---|---|---|
| `eager.turn` | `(turn, call)` | Early turn signal (low-latency response) |
| `turn.end` | `(turn, call)` | Final turn signal |
| `turn.continued` | `(event, call)` | User kept talking (auto-aborts active streams) |

### Bot speech

| Event | Signature | When |
|---|---|---|
| `bot.speaking` | `(event, call)` | Bot started speaking a message |
| `bot.word` | `(event, call)` | Individual word as TTS plays it |
| `bot.finished` | `(event, call)` | Bot finished speaking a message |
| `bot.interrupted` | `(event, call)` | Bot was cut off by user |

### Protocol

| Event | Signature | When |
|---|---|---|
| `message.confirmed` | `(event, call)` | Server acknowledged bot message |
| `llm.toolCall` | `(data, call)` | Server-side LLM requests a tool call |
| `session.idleWarning` | `(event, call)` | Warning — user hasn't spoken, call will timeout soon |
| `session.timeout` | `(event, call)` | Session timeout fired (max duration / idle) |

### WhatsApp

| Event | Signature | When |
|---|---|---|
| `whatsapp.sessionStarted` | `(event)` | New WhatsApp conversation started |
| `whatsapp.message` | `(event)` | Incoming WhatsApp message received |
| `whatsapp.response` | `(event)` | Agent sent a WhatsApp response |
| `whatsapp.status` | `(event)` | Message delivery status |

See [Events reference](/reference/events) for full event data shapes.

### Human-in-the-loop

| Event | Signature | When |
|---|---|---|
| `session.paused` | `(event)` | AI paused for a session, contact, or globally |
| `session.resumed` | `(event)` | AI resumed |

See [Human Takeover guide](/guides/human-takeover).

## Escape hatch

### `send(data)`

Send a raw protocol message. Use only when no higher-level method covers your case.

```typescript
agent.send({ type: "custom.command", payload: { /* ... */ } });
```

## What's next

- [`Call`](/api/call) — per-session methods
- [Events reference](/reference/events) — full event data shapes
- [Hot-reload](/concepts/hot-reload) — patterns for `configure()` and `setPrompt()`

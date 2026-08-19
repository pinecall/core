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
  llm: "openai/gpt-5.4-nano",
  prompt: "System prompt with {{template_vars}}.",
  greeting: "Hello! How can I help you today?",
  phoneNumber: "+13186330963",
  tools: [lookupOrder],
});
```

| Config field | Type | Description |
|---|---|---|
| `voice` | `string \| VoiceConfig` | TTS provider — shortcut or full config |
| `language` | `string` | BCP-47 language code. Non-English auto-selects ElevenLabs `eleven_multilingual_v2` |
| `flash` | `boolean` | Keep ElevenLabs `eleven_flash_v2_5` on a non-English agent (lowest latency/cost) instead of the multilingual auto-default. ElevenLabs-only; see [TTS Providers](/reference/tts-providers) |
| `stt` | `string \| STTConfig` | STT provider — shortcut or full config |
| `llm` | `LLMConfig` | LLM provider, model, prompt, enabled flag |
| `tools` | `Tool[]` | Declarative tools created with `tool()` + Zod schemas (auto-executed) |
| `phoneNumber` | `string \| PhoneNumberConfig` | Phone number to register (E.164 or SIP URI) |
| `phoneNumbers` | `Array<string \| PhoneNumberConfig>` | Multiple numbers with per-number config |
| `whatsapp` | `WhatsAppChannelConfig[]` | WhatsApp channels to register |
| `history` | `HistoryStore` | Conversation persistence (see [History](/guides/conversation-history)) |
| `sessionLimits` | `SessionLimits` | Duration / idle timeout config |
| `interruption` | `InterruptionConfig` | Barge-in gates: min duration/volume/words, backchannel filter |
| `analysis` | `AnalysisConfig` | Audio metrics streaming |
| `greeting` | `string \| { text, addToHistory? } \| { [lang]: string } \| (call) => string` | First thing the agent says — see [Greeting](#greeting) |
| `greetingInChat` | `boolean` | Deliver the greeting on chat sessions too (default `false`) |
| `memory` | `MemoryConfig` | Long-term memory per contact — see [Memory](/guides/memory) |
| `allowedOrigins` | `string[]` | Public token access (see [Security](/security)) |

See [Reference → Providers](/reference/stt-providers) for full provider configs.

## Greeting

The first thing the agent says. **The server delivers it** — you do not send it yourself — so it is one text with one owner, and it lands in the LLM history: the model knows it already greeted and does not introduce itself again.

```typescript
pc.agent("front-desk", { greeting: "Thanks for calling Studio Bella, this is Lucía. How can I help?" });
```

| Shape | Use |
|---|---|
| `"Hi! How can I help?"` | one language, every channel |
| `{ text, addToHistory? }` | same, with explicit history control |
| `{ en: "Hi!…", es: "¡Hola!…" }` | **one text per language** — the server picks the entry matching the session's [`call.language`](/api/call#language) |
| `(call) => string` | computed per call (a name from your CRM). Runs in **your** process on `call.started`, voice only |

**Channels.** Voice (phone and WebRTC) is greeted by default. Chat is not, because most chat UIs paint their own opening line — set `greetingInChat: true` to have the server send it there too, as the session's first bot message:

```typescript
pc.agent("front-desk", {
  greeting: { en: "Hi, this is Lucía. How can I help?", es: "Hola, habla Lucía. ¿En qué te ayudo?" },
  greetingInChat: true,
});
```

> **Do not greet twice.** Declaring `greeting` *and* saying hello yourself from `call.started`, or painting a welcome line in the browser, produces two greetings back to back. Pick one owner: the `greeting` field (the server) or your own `call.say` — not both.

## Memory

`agent.memory` reads what the server remembers about this agent's contacts — `get(contact)`, `search(query, { contact?, k? })`, `forget(contact)` — over REST with your API key; the agent need not be online. Facts arrive live on `agent.on("memory.ops", (m, call) => …)`. The whole story: [Memory](/guides/memory).

## Registration

`pc.agent()` returns **synchronously** — it only queues `agent.create` on the socket. The agent exists server-side once the server acks it, and only then can it be reached from outside your process (token mints, inbound routing).

### `ready`

`Promise<void>` that resolves when the **server** has acknowledged the registration. Await it before anything that needs the agent to exist server-side.

```typescript
const agent = pc.agent("recepcion", { prompt });
await agent.ready;                    // the server now knows this agent
```

Rejects with `AgentConflictError` if the registration is terminally refused (the id is held by another **live** process — run `pinecall kick <id>` or pick another id). Goes back to pending if the socket drops, and resolves again once the reconnect re-registers the agent.

Rejects with `ServerAtCapacityError` if the server's client-slot ceiling refused the registration. Nothing is wrong with your agent — the **server** is full:

```typescript
import { ServerAtCapacityError } from "@pinecall/sdk";

try {
    await agent.ready;
} catch (err) {
    if (err instanceof ServerAtCapacityError) {
        console.error(`server full: ${err.used}/${err.limit} slots`);
        // `pinecall agents` lists the holders; free one, then retry.
    }
}
```

> Worth knowing, because it used to be invisible: when a registration is refused for capacity, the agent never appears server-side, so a token mint for it answers `404 Agent '<id>' is not online`. That 404 is a *consequence*, not the cause — always read the registration error first.

### `registered`

`boolean` — whether the server has acked the registration right now.

> You rarely need either one: `createToken()` already waits for the ack internally, so a register-then-mint sequence works without any delay on your side. Await `ready` when *you* need to know, or to surface a registration failure to your caller.

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
agent.update({ llm: "openai/gpt-5.4-nano", prompt: "..." });
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

### `createToken(channel, metadata?)`

Mint a short-lived, single-use token for browser **WebRTC** or **chat**. Scoped to this agent (the agent-form shortcut for [`pc.createToken(channel, agentId, metadata?)`](/api/pinecall#createtokenchannel-agentid-metadata)).

```typescript
const token = await agent.createToken("webrtc");
// { token, server, expiresIn }
```

Safe to call immediately after `pc.agent()`: the mint waits for the agent's [registration ack](#ready) first, so it can't race ahead of the registration and come back `Agent '<id>' is not online`. If the agent is never registered (socket down, id held by a live process) the call **fails** rather than minting a token that would 404.

**Sealed session metadata** — pass a second argument to bake trusted context into the token:

```typescript
const token = await agent.createToken("chat", { userId: "u_123", role: "admin" });
```

The metadata is **sealed into the signed token on your server**, so the browser can't forge or alter it — it surfaces as [`call.metadata`](/api/call) in your `call.started` handler. Use it for per-user / multi-tenant identity you can trust.

> ⚠️ Arg position differs by form: `agent.createToken(channel, metadata)` (metadata 2nd, `agentId` implicit) vs `pc.createToken(channel, agentId, metadata)` (metadata 3rd). It is **not** the forgeable client-side `metadata` prop on the widget / `VoiceSession`. See [Multi-Tenant → sealed token metadata](/guides/multi-tenant) and [Security](/security).

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

The canonical way to observe this agent's calls — live, late, or after the fact — is the **[call log](/guides/call-log)**: mint a stream token (`pc.createToken("stream", agent.id)`) and attach from any process or browser, with replay and cursor resume.

### `stream(res?)`

Open an **in-process** SSE stream of this agent's events (no replay, no cursor — the client must share this process's HTTP server). Same shape as `pc.stream()` but scoped to one agent.

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
| `call.preparing` | `(call)` | Before every LLM generation — the server holds the turn while your handler refreshes per-turn `{{vars}}`. Return a promise and it waits for it. See [the guide](/guides/events#call-preparing). |
| `call.preparingTimeout` | `(event, call)` | The `preparing` budget expired and the turn rendered with the previous values |

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

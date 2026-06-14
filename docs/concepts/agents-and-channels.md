---
title: "Agents and Channels"
description: "The mental model: how Pinecall, Agent, Channel, and Call fit together."
---

# Agents and Channels

The Pinecall SDK has four nouns. Understanding them is most of understanding the SDK.

## The four nouns

```
Pinecall (the client)
   │
   └── Agent (a personality)
            │
            ├── Phone: +1-555-123-4567
            ├── WhatsApp: +51-987-654-321
            │
            └── Call (a live session)
            (WebRTC + Chat: work via tokens, no declaration)
```

### `Pinecall` — the client

One per process. Owns the WebSocket connection to `voice.pinecall.io`, handles auth and reconnection, and multiplexes events across multiple agents. **Auto-connects on construction.**

```typescript
const pc = new Pinecall(); // reads PINECALL_API_KEY from env, connects automatically
```

### `Agent` — a personality

A configured assistant. Has a name (the agent ID), a voice, an STT provider, an LLM config, and a list of tools. Listens for events; owns channels.

```typescript
const agent = pc.agent("support", {
  voice: "elevenlabs/sarah",
  language: "en",
  llm: "openai/gpt-5-chat-latest",
  stt: "deepgram/flux",
  prompt: "...",
});
```

You can have many agents on the same `Pinecall` instance — `support`, `sales`, `intake` — each with their own personality and channels.

### `Channel` — a way to reach the agent

A surface through which calls arrive. Some channels need explicit registration; others work automatically:

```typescript
// Phone number — declared in config
const agent = pc.agent("support", {
  phoneNumber: "+13186330963",
  whatsapp: [{ phoneNumberId: "123", accessToken: "..." }],
});

// Or imperatively:
agent.addPhoneNumber("+13186330963");
agent.addWhatsapp({ phoneNumberId: "123", accessToken: "..." });

// WebRTC + Chat: work via tokens, no registration needed
const token = await agent.createToken("webrtc");
```

Channel types:

| Type | Registration | How users connect |
|---|---|---|
| `phone` | `phoneNumber: "+1..."` | Call the number |
| `whatsapp` | `whatsapp: [{...}]` | Send a WhatsApp message |
| `webrtc` | **None** (automatic) | Browser widget + token |
| `chat` | **None** (automatic) | WebSocket + token |

### `Call` — a live session

Created automatically when someone connects on a channel. You receive a `Call` object in the `call.started` event. Use it to:

- Speak (`call.say`, `call.reply`, `call.replyStream`)
- Control the call (`call.hangup`, `call.forward`, `call.hold`)
- Update mid-call (`call.update`, `call.setPrompt`, `call.addContext`)
- Read state (`call.transcript`, `call.from`, `call.duration`)

## Creating an agent

### With `phoneNumber` (declarative)

Pass a phone number directly in the config:

```typescript
const mara = pc.agent("mara", {
  voice: "elevenlabs/sarah",
  language: "es",
  llm: "openai/gpt-5-chat-latest",
  stt: "deepgram/flux",
  prompt: "You are Mara. Be concise.",
  phoneNumber: "+13186330963",
});
```

WebRTC and Chat work automatically — no declaration needed. Just create tokens.

### With `agent.addPhoneNumber()` (imperative)

Use `agent.addPhoneNumber()` when you need per-number config overrides:

```typescript
const mara = pc.agent("mara", {
  voice: "elevenlabs/sarah",
  language: "es",
  llm: "openai/gpt-5-chat-latest",
  stt: "deepgram/flux",
  prompt: "You are Mara. Be concise.",
});

mara.addPhoneNumber("+13186330963", {
  voice: "elevenlabs/daniel",
});
```

## Per-number config overrides

The agent has defaults. Each phone number can override voice, language, and STT. This is how you give the same agent different settings per number:

```typescript
const agent = pc.agent("support", {
  llm: "openai/gpt-5-chat-latest",
  stt: "deepgram/flux",
  voice: "elevenlabs/sarah",
  phoneNumber: { number: "+34911234567", voice: "elevenlabs/valentina", language: "es" },
});
```

For multiple numbers with different overrides — including STT provider — use `phoneNumbers`:

```typescript
const agent = pc.agent("global-support", {
  prompt: "You are a multilingual support agent.",
  llm: "openai/gpt-5-chat-latest",
  phoneNumbers: [
    { number: "+14155551234", language: "en", voice: "elevenlabs/sarah", stt: "deepgram/flux" },
    { number: "+34612345678", language: "es", voice: "elevenlabs/valentina", stt: "deepgram/flux" },
    // Arabic requires Nova-3 (Flux doesn't support it)
    { number: "+972501234567", language: "ar", voice: "elevenlabs/ahmad", stt: "deepgram/nova-3" },
  ],
});
```

The agent's prompt, tools, and LLM stay the same — only the audio surface changes per number. Turn detection and VAD are auto-derived from the STT provider (Flux → native, Nova-3 → smart_turn + silero).

## Why this design

The agent-and-channels split exists because voice agents have two completely different concerns:

1. **Who the agent is** — personality, knowledge, tools, business logic
2. **How users reach it** — a phone number, a SIP trunk, a browser widget, a WhatsApp chat

Most platforms conflate the two: you build a "Twilio bot" or a "WhatsApp bot." Pinecall keeps them separate so you can build the agent once and expose it through whatever channel you need today (or tomorrow).

## What's next

- [Server-side vs client-side LLM](/concepts/server-vs-client-llm) — the most important architectural decision
- [Hot-reload](/concepts/hot-reload) — change voice, language, prompt, or tools mid-call
- [Deployment topologies](/concepts/deployment-topologies) — embedded, standalone, or headless

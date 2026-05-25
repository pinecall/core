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
            ├── Channel: phone +1-555-123-4567
            ├── Channel: webrtc
            └── Channel: whatsapp
                  │
                  └── Call (a live session)
```

### `Pinecall` — the client

One per process. Owns the WebSocket connection to `voice.pinecall.io`, handles auth and reconnection, and multiplexes events across multiple agents.

```typescript
const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY });
await pc.connect();
```

### `Agent` — a personality

A configured assistant. Has a name (the agent ID), a voice, an STT provider, an LLM config, and a list of tools. Listens for events; owns channels.

```typescript
const agent = pc.agent("support", {
  voice: "elevenlabs:abc",
  language: "en",
  llm: { provider: "openai", model: "gpt-4.1-mini", enabled: true, prompt: "..." },
});
```

You can have many agents on the same `Pinecall` instance — `support`, `sales`, `intake` — each with their own personality and channels.

### `Channel` — a way to reach the agent

A surface through which calls arrive. The same agent can have many channels; each call lands on the same agent and emits the same events.

```typescript
agent.addChannel("phone", "+13186330963");      // Twilio phone number
agent.addChannel("phone", "sip:bot@trunk.io");  // SIP trunk
agent.addChannel("webrtc");                      // browser audio
agent.addChannel("chat");                        // browser text
agent.addChannel("whatsapp", { /* config */ });  // WhatsApp Cloud API
```

Channels come in five types:

| Type | What it is |
|---|---|
| `phone` | A Twilio number or SIP URI |
| `webrtc` | Browser audio (the user clicks a widget, talks through their mic) |
| `chat` | Browser text (typed messages via WebSocket) |
| `whatsapp` | WhatsApp Cloud API messages |
| `mic` | Local microphone (development / desktop apps) |

### `Call` — a live session

Created automatically when someone connects on a channel. You receive a `Call` object in the `call.started` event. Use it to:

- Speak (`call.say`, `call.reply`, `call.replyStream`)
- Control the call (`call.hangup`, `call.forward`, `call.hold`)
- Configure mid-call (`call.configure`, `call.setPrompt`, `call.addContext`)
- Read state (`call.transcript`, `call.from`, `call.duration`)

## Two ways to create an agent

### `pc.deploy()` — the shortcut

Combines agent creation, LLM config, and channel registration in one call. Best for getting started.

```typescript
const mara = pc.deploy("mara", {
  prompt: "You are Mara. Be concise.",
  model: "gpt-4.1-mini",
  voice: "elevenlabs:EXAVITQu4vr4xnSDxMaL",
  language: "es",
  channels: ["webrtc", "+13186330963"],
});
```

### `pc.agent()` — the explicit form

More verbose, more control. Use this when you need to set advanced provider configs, configure channels with per-channel overrides, or build the agent dynamically.

```typescript
const mara = pc.agent("mara", {
  voice: "elevenlabs:EXAVITQu4vr4xnSDxMaL",
  language: "es",
  stt: "deepgram-flux",
  llm: {
    provider: "openai",
    model: "gpt-4.1-mini",
    enabled: true,
    prompt: "You are Mara. Be concise.",
  },
});

mara.addChannel("webrtc");
mara.addChannel("phone", "+13186330963", {
  voice: "elevenlabs:differentVoiceForPhone",
});
```

The two approaches are interchangeable — `deploy()` is just `agent()` + `addChannel()` calls under the hood.

## Per-channel config overrides

The agent has defaults. Each channel can override them. This is how you give the same agent a different voice on a Spanish phone number vs a French one:

```typescript
agent.addChannel("phone", "+34911234567", {
  voice: "elevenlabs:spanishVoiceId",
  language: "es",
});

agent.addChannel("phone", "+33145678901", {
  voice: "elevenlabs:frenchVoiceId",
  language: "fr",
});
```

The agent's prompt, tools, and LLM stay the same — only the audio surface changes per number.

## Why this design

The agent-and-channels split exists because voice agents have two completely different concerns:

1. **Who the agent is** — personality, knowledge, tools, business logic
2. **How users reach it** — a phone number, a SIP trunk, a browser widget, a WhatsApp chat

Most platforms conflate the two: you build a "Twilio bot" or a "WhatsApp bot." Pinecall keeps them separate so you can build the agent once and expose it through whatever channel you need today (or tomorrow).

## What's next

- [Server-side vs client-side LLM](/docs/concepts/server-vs-client-llm) — the most important architectural decision
- [Hot-reload](/docs/concepts/hot-reload) — change voice, language, prompt, or tools mid-call
- [Deployment topologies](/docs/concepts/deployment-topologies) — embedded, standalone, or headless

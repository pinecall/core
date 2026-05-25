---
title: "Pinecall SDK"
description: "Build real-time voice & messaging AI agents in TypeScript."
---

# Pinecall SDK

**Build real-time voice & messaging AI agents in TypeScript.** One package, one WebSocket connection, all your channels.

```bash
npm install @pinecall/sdk
```

Pinecall is **code-first** voice AI: the agent runs inside your app, uses your database, calls your internal APIs, and handles tool calls as local functions. There are no webhooks to expose, no platform dashboard to configure, no JSON tool schemas to maintain separately from your code.

```typescript
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });
await pc.connect();

const mara = pc.deploy("mara", {
  prompt: "You are Mara. Be concise and warm.",
  model: "gpt-4.1-mini",
  voice: "elevenlabs:EXAVITQu4vr4xnSDxMaL",
  language: "es",
  channels: ["webrtc", "+13186330963"],
});

mara.on("call.started", (call) => call.say("¡Hola!"));
```

That snippet is a production-ready agent. It accepts phone calls, accepts browser WebRTC connections, runs an LLM, and speaks back with low-latency TTS.

## What you can build

- **Voice agents** — phone (Twilio), SIP, WebRTC widgets in the browser
- **Messaging agents** — WhatsApp Cloud API, chat widgets
- **Multi-channel agents** — the same agent handling phone, WhatsApp, and browser calls simultaneously
- **Outbound campaigns** — programmatic outbound calls with TTS greetings
- **Embedded copilots** — voice inside your web app via the React widget

## How the SDK is organized

The library has three core concepts. If you understand these, you understand the whole SDK:

- **`Pinecall`** — the WebSocket client. Manages the connection, multiplexes between agents.
- **`Agent`** — a configured personality (prompt, voice, LLM). Owns channels and emits events.
- **`Call`** — a single live session. Created automatically when someone connects. You speak to it, configure it, end it.

```
Pinecall (one connection)
   ├── Agent "support"  ──┬── Channel: +1-555-...
   │                      ├── Channel: webrtc
   │                      └── Channel: whatsapp
   ├── Agent "sales"    ──── Channel: +1-555-...
   └── Agent "intake"   ──── Channel: sip:...
```

A single `Pinecall` instance can host many agents. A single agent can serve many channels. Every channel emits the same events on the agent — your code doesn't care whether the call came from a phone, a browser, or WhatsApp.

## Where to go next

| If you want to... | Read this |
|---|---|
| Get a call working in 5 minutes | [Quickstart](/quickstart) |
| Understand the moving parts | [Concepts → Agents and Channels](/concepts/agents-and-channels) |
| Build a phone agent | [Guides → Inbound Voice](/guides/inbound-voice) |
| Build a WhatsApp bot | [Guides → WhatsApp](/guides/whatsapp) |
| Embed voice in your web app | [Guides → WebRTC in the browser](/guides/webrtc-browser) |
| Look up a method | [API Reference](/api/pinecall) |
| Tune STT, TTS, or the LLM | [Reference → Providers](/reference/stt-providers) |

## Philosophy

Pinecall SDK is designed around one idea: **any existing app can add a voice agent without changing its architecture.**

Traditional voice AI platforms make you adapt your app to them. Pinecall adapts to your app — your code stays where it is, your tools are local functions, your data never leaves your process. The voice server handles the hard real-time parts (audio transport, STT, TTS, VAD, turn detection); your code handles everything else (business logic, prompts, history, state).

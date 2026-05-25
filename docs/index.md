---
title: "Pinecall"
description: "Build real-time voice & messaging AI agents in TypeScript. Four packages, one platform."
---

# Pinecall

**Build real-time voice & messaging AI agents in TypeScript.** A server SDK in Node.js, three browser SDKs (WebRTC, React widget, chat), all talking to one voice server.

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

## The four packages

Pinecall ships as four npm packages. The server SDK runs your agent logic in Node.js; the three browser packages talk to the same agent from the browser.

| Package | Where it runs | Use it for |
|---|---|---|
| [`@pinecall/sdk`](/docs/api/pinecall) | Node.js (server) | The agent — prompt, tools, channels, calls |
| [`@pinecall/voice-core`](/docs/voice-core/overview) | Browser | WebRTC voice from any framework (vanilla, Vue, Svelte, …) |
| [`@pinecall/voice-widget`](/docs/voice-widget/overview) | Browser (React) | Drop-in animated orb widget + interactive tools API |
| [`@pinecall/chat-core`](/docs/chat-core/overview) | Browser | Text chat over WebSocket — vanilla + React hook |

The same agent (`pc.agent("mara", ...)`) can be reached over phone, WebRTC, chat, or WhatsApp — without changing your agent code.

## How `@pinecall/sdk` is organized

The server SDK has three core concepts:

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
| Get a call working in 5 minutes | [Quickstart](/docs/quickstart) |
| Understand the moving parts | [Concepts → Agents and Channels](/docs/concepts/agents-and-channels) |
| Build a phone agent | [Guides → Inbound Voice](/docs/guides/inbound-voice) |
| Build a WhatsApp bot | [Guides → WhatsApp](/docs/guides/whatsapp) |
| Embed voice in your web app (React) | [`@pinecall/voice-widget`](/docs/voice-widget/overview) |
| Embed voice in non-React apps | [`@pinecall/voice-core`](/docs/voice-core/overview) |
| Embed text chat | [`@pinecall/chat-core`](/docs/chat-core/overview) |
| Look up a server-side method | [`@pinecall/sdk` API Reference](/docs/api/pinecall) |
| Tune STT, TTS, or the LLM | [Reference → Providers](/docs/reference/stt-providers) |

## Philosophy

Pinecall SDK is designed around one idea: **any existing app can add a voice agent without changing its architecture.**

Traditional voice AI platforms make you adapt your app to them. Pinecall adapts to your app — your code stays where it is, your tools are local functions, your data never leaves your process. The voice server handles the hard real-time parts (audio transport, STT, TTS, VAD, turn detection); your code handles everything else (business logic, prompts, history, state).

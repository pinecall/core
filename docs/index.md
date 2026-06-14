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
import { Pinecall, tool } from "@pinecall/sdk";
import { z } from "zod";

const pc = new Pinecall();

const agent = pc.agent("mara", {
  prompt: "You are Mara, a friendly booking assistant.",
  llm: "openai/gpt-5-chat-latest",
  voice: "elevenlabs/sarah",
  stt: "deepgram/flux",
  phoneNumber: "+13186330963",
  greeting: "Hello! How can I help you today?",
  tools: [
    tool({
      name: "findSlots",
      description: "Find available appointment slots for a date",
      schema: z.object({ date: z.string(), service: z.string() }),
      execute: async ({ date, service }) => calendar.getSlots(date, service),
    }),
  ],
});
```

That snippet is a production-ready agent. The SDK auto-connects on construction, registers the agent, and starts accepting calls — phone, WebRTC, and chat. No `await pc.connect()` needed. Run it with `pinecall run agent/index.js` for a polished terminal UI.

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
   ├── Agent "support"  ──┬── Phone: +1-555-...
   │                      └── WhatsApp: +51-...
   ├── Agent "sales"    ──── Phone: +1-555-...
   └── Agent "intake"   ──── Phone: sip:...
           (WebRTC + Chat work via tokens on any agent)
```

A single `Pinecall` instance can host many agents. A single agent can serve many channels. Every channel emits the same events on the agent — your code doesn't care whether the call came from a phone, a browser, or WhatsApp.

## Advanced usage

### Dynamic greetings

The `greeting` config accepts a string, but also a callback that receives the `Call` object — useful for personalized greetings:

```typescript
const agent = pc.agent("mara", {
  // ...
  greeting: async (call) => {
    const user = await db.findByPhone(call.from);
    return `Hello ${user.name}! Ready to book?`;
  },
});
```

The `greeting` config is a shorthand. Under the hood it calls `call.say()` when the call connects, which sends text directly to TTS without going through the LLM. You can also use `call.say()` manually in the `call.started` event:

```typescript
agent.on("call.started", async (call) => {
  const user = await db.findByPhone(call.from);
  call.say(`Hello ${user.name}!`, { addToHistory: false });
});
```

`addToHistory: false` tells the server to speak the text but not include it in the LLM conversation history — useful for ephemeral messages like "Please hold" or "One moment."

### Multiple phone numbers

Use `phoneNumbers` (plural) to attach several numbers with per-number overrides — ideal for A/B testing, multi-language support, or regional routing:

```typescript
const agent = pc.agent("mara", {
  prompt: "You are Mara, a friendly assistant.",
  llm: "openai/gpt-5-chat-latest",
  phoneNumbers: [
    { number: "+14155551234", language: "en", stt: "deepgram/flux", voice: "elevenlabs/sarah" },
    { number: "+966501234567", language: "ar", stt: "deepgram/nova-3", voice: "elevenlabs/ahmad" },
    "+13186330963",  // inherits agent defaults
  ],
});
```

Each number can override `language`, `stt`, `voice`, and `ringing`. The agent prompt, LLM, and tools stay the same — only the voice interface changes per number.

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

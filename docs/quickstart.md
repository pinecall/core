---
title: "Quickstart"
description: "From zero to a working voice agent in under 5 minutes."
---

# Quickstart

Get a Pinecall voice agent answering calls in under 5 minutes.

## 1. Install

```bash
npm install @pinecall/sdk
```

> Node.js ≥ 18. The only runtime dependency is `ws`.

## 2. Get an API key

Sign up at [pinecall.io](https://pinecall.io), grab your API key from the dashboard, and export it:

```bash
export PINECALL_API_KEY=pk_...
```

## 3. Deploy your first agent

Create `agent.js`:

```typescript
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY });
await pc.connect();

const mara = pc.deploy("mara", {
  prompt: "You are Mara, a friendly voice assistant. Be concise.",
  model: "gpt-4.1-mini",
  voice: "elevenlabs:EXAVITQu4vr4xnSDxMaL",
  language: "en",
  channels: ["webrtc"],
});

mara.on("call.started", (call) => call.say("Hello! How can I help?"));
mara.on("call.ended", (call, reason) => {
  console.log(`Call ended: ${reason} (${call.duration}s)`);
});

console.log("Mara is live. Connect a browser via the widget to talk to her.");
```

## 4. Run it

```bash
node agent.js
```

You should see:

```
Mara is live. Connect a browser via the widget to talk to her.
```

That's a running voice agent. It's connected to Pinecall's voice server, it has a personality, and it's waiting for someone to call.

## 5. Talk to it

Connect from the browser using the [`@pinecall/voice-widget`](https://github.com/pinecall/voice-widget):

```bash
npm install @pinecall/voice-widget
```

```tsx
import { VoiceWidget } from "@pinecall/voice-widget";

export default function App() {
  return (
    <VoiceWidget
      agent="mara"
      tokenProvider={async () => {
        const res = await fetch("/api/token");
        return res.json();
      }}
    />
  );
}
```

You'll need a tiny backend endpoint to mint the token:

```typescript
app.get("/api/token", async (req, res) => {
  const token = await mara.createToken("webrtc");
  res.json(token);
});
```

Click the widget, talk to Mara. She'll respond.

## What just happened

You created an agent (`mara`), gave her a personality, exposed her over WebRTC, and connected a browser to her. The server handles STT (you speak → text), runs the LLM (text → response), and handles TTS (response → voice).

You didn't write a single line of WebSocket code, audio handling, or VAD logic. The SDK and the Pinecall server handle all of that.

## Add a phone number

Want Mara to answer phone calls too? Add a `phone` channel:

```typescript
const mara = pc.deploy("mara", {
  // ...same as before
  channels: ["webrtc", "+13186330963"],
});
```

Now the same agent serves browser **and** phone calls. The events are identical — your code doesn't need to know which transport the call came in over.

## Add a tool

Tools are local functions with Zod schemas — auto-executed by the SDK:

```typescript
import { Pinecall, tool } from "@pinecall/sdk";
import { z } from "zod";

const lookupOrder = tool({
  name: "lookupOrder",
  description: "Look up an order by ID",
  schema: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => await db.orders.findOne(orderId),
});

const mara = pc.deploy("mara", {
  prompt: "You are Mara. Look up orders when asked.",
  model: "gpt-4.1-mini",
  voice: "elevenlabs:EXAVITQu4vr4xnSDxMaL",
  language: "en",
  channels: ["webrtc"],
  tools: [lookupOrder],
});

mara.on("call.started", (call) => call.say("Hello! How can I help?"));
```

No webhook URL to expose. No manual event handler. Just a function that runs in your process.

## Where to go next

- **Build a real phone agent** → [Guides → Inbound Voice](/guides/inbound-voice)
- **Build a WhatsApp bot** → [Guides → WhatsApp](/guides/whatsapp)
- **Understand the architecture** → [Concepts → Agents and Channels](/concepts/agents-and-channels)
- **Look up every method** → [API Reference](/api/pinecall)

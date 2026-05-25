---
title: "WebRTC in the Browser"
description: "Embed a Pinecall voice agent in your web app using the React widget."
---

# WebRTC in the Browser

Browser users can talk to your agent directly through WebRTC — no phone number required. This is how voice copilots, in-app assistants, and live demos work.

## Architecture

The browser connects **directly** to `voice.pinecall.io` over WebRTC. Your backend's only job is minting short-lived tokens.

```
Browser ──► your /api/token endpoint ──► token
        ──► voice.pinecall.io with token ──► live session
```

Your backend never proxies audio. The audio path is browser ↔ voice server, peer-to-peer over WebRTC.

## 1. Add a WebRTC channel to the agent

```typescript
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });
await pc.connect();

const mara = pc.deploy("mara", {
  prompt: "You are Mara. Be concise and warm.",
  model: "gpt-4.1-mini",
  voice: "elevenlabs:EXAVITQu4vr4xnSDxMaL",
  language: "es",
  channels: ["webrtc"],
});

mara.on("call.started", (call) => call.say("¡Hola!"));
```

## 2. Mint tokens from your backend

Your token endpoint should be behind your existing auth (session cookie, JWT, OAuth — whatever you use). The endpoint calls `createToken()` and returns the result.

```typescript
// Express
app.get("/api/token", authMiddleware, async (req, res) => {
  const token = await mara.createToken("webrtc");
  res.json(token);
});
```

```typescript
// Next.js App Router
export async function GET() {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  const token = await mara.createToken("webrtc");
  return Response.json(token);
}
```

The response shape:

```json
{
  "token": "wrtc_abc123...",
  "server": "wss://voice.pinecall.io",
  "expiresIn": 60
}
```

Tokens are single-use, scoped to the agent, and expire in 60 seconds. See [Security](/docs/security) for the full security model.

## 3. Drop in the widget

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
        const res = await fetch("/api/token", { credentials: "include" });
        return res.json();
      }}
    />
  );
}
```

That's the entire frontend. Click the orb, talk, listen.

## Listening for events in the browser

Events arrive over the WebRTC DataChannel — you don't need SSE for in-browser UIs. The widget exposes them as props:

```tsx
<VoiceWidget
  agent="mara"
  tokenProvider={getToken}
  onUserMessage={(text) => addToTranscript("user", text)}
  onBotSpeaking={(text) => addToTranscript("bot", text)}
  onCallEnded={(reason) => console.log("Done:", reason)}
/>
```

For lower-level control, use `@pinecall/voice-core` directly — it gives you the raw event stream.

## Custom UI without the widget

If the widget doesn't fit your design, build your own UI with `@pinecall/voice-core`:

```typescript
import { PinecallClient } from "@pinecall/voice-core";

const client = new PinecallClient();

const { token, server } = await fetch("/api/token").then((r) => r.json());
await client.connect({ token, server, agentId: "mara" });

client.on("user.message", (e) => console.log("User:", e.text));
client.on("bot.speaking", (e) => console.log("Bot:", e.text));
client.on("bot.word", (e) => updateLiveCaption(e.word));

// User clicks "End"
await client.disconnect();
```

## Skipping the backend for demos

For pure demos or prototypes — no backend, no auth — you can opt in to public token access using `allowedOrigins`:

```typescript
const demo = pc.agent("demo-bot", {
  // ...config
  allowedOrigins: [
    "https://demo.mysite.com",
    "https://*.mysite.com",
    "http://localhost:*",
  ],
});
```

Then the widget can fetch tokens directly from the voice server, no backend needed:

```tsx
<VoiceWidget agent="demo-bot" apiKey="pk_publishable_..." />
```

> **Warning:** `allowedOrigins` protects against casual embedding but not against a determined attacker (Origin headers can be spoofed from scripts/curl). For production, always use `tokenProvider` with your backend's auth. See [Security](/docs/security).

## Chat channel (text only)

Same pattern, different channel. Use the chat channel for typed conversations without audio:

```typescript
agent.addChannel("chat");

// Backend
app.get("/api/chat-token", authMiddleware, async (req, res) => {
  const token = await agent.createToken("chat");
  res.json(token);
});
```

Connect from the browser via WebSocket:

```typescript
const ws = new WebSocket(`${server}/chat/ws?token=${token}`);
ws.onmessage = (e) => {
  const event = JSON.parse(e.data);
  if (event.type === "bot.message") appendBotMessage(event.text);
};
ws.send(JSON.stringify({ type: "user.message", text: "Hello" }));
```

## What's next

- [Security](/docs/security) — the full token security model
- [Multi-tenant](/docs/guides/multi-tenant) — scope tokens per user/tenant
- [Dev mode](/docs/guides/dev-mode) — slug-based isolation lets every dev have their own agent

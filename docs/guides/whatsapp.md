---
title: "WhatsApp"
description: "Build a WhatsApp messaging agent using Meta's Cloud API."
---

# WhatsApp

WhatsApp is a text-based channel — no STT/TTS/VAD pipeline. Messages route directly to the server-side LLM. The agent receives text, generates a response, and sends it back as a WhatsApp message.

> **Server-side LLM required.** WhatsApp channels use the same `llm` config as voice channels. Client-side LLM (bring-your-own) is not supported for WhatsApp.

## Setup

### 1. Create a Meta Business App

Go to [developers.facebook.com](https://developers.facebook.com) and create a Business app.

### 2. Add the WhatsApp product

In your app dashboard, add WhatsApp from the product catalog.

### 3. Collect your credentials

From the WhatsApp → API Setup page, grab:

- **Phone Number ID** — numeric string (e.g. `123456789012345`)
- **Permanent Access Token** — generate a system user token with `whatsapp_business_messaging` permission
- **App Secret** — from App Settings → Basic (used for webhook signature verification)

### 4. Configure the webhook in your Meta app

Webhook URL:

```
https://voice.pinecall.io/whatsapp/webhook
```

Verification token: must match the `verifyToken` you pass to the SDK (default: `pinecall-wa-verify`).

Subscribe to the `messages` field.

## Minimal WhatsApp agent

```typescript
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });
await pc.connect();

const support = pc.agent("support", {
  language: "en",
  llm: {
    provider: "openai",
    model: "gpt-4.1-mini",
    enabled: true,
    prompt: "You are a helpful support agent on WhatsApp. Be concise.",
  },
});

support.addChannel("whatsapp", {
  phoneNumberId: "123456789012345",
  accessToken: process.env.WA_TOKEN!,
  verifyToken: "my-verify-token",
  appSecret: process.env.WA_APP_SECRET!,
});

support.on("whatsapp.message", (event) => {
  console.log(`📩 ${event.name}: ${event.text}`);
});
```

That's it. The first message a new contact sends fires `whatsapp.session_started`, the LLM generates a response, and the SDK sends it back via the Cloud API.

## `WhatsAppChannelConfig`

| Field | Type | Required | Description |
|---|---|---|---|
| `phoneNumberId` | `string` | ✅ | Meta Phone Number ID from API Setup |
| `accessToken` | `string` | ✅ | Permanent Graph API access token |
| `verifyToken` | `string` | — | Webhook verification token (default: `pinecall-wa-verify`) |
| `appSecret` | `string` | — | App secret for HMAC signature verification (strongly recommended) |

## Adding tools

Tools work identically on WhatsApp and voice channels. Define them with `tool()` — the SDK handles execution on all channels:

```typescript
import { tool } from "@pinecall/sdk";
import { z } from "zod";

const lookupOrder = tool({
  name: "lookupOrder",
  description: "Look up an order by ID",
  schema: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => await db.orders.findOne(orderId),
});

const support = pc.agent("support", {
  llm: {
    provider: "openai",
    model: "gpt-4.1-mini",
    enabled: true,
    prompt: "...",
  },
  tools: [lookupOrder],
});
```

## Multi-channel: voice + WhatsApp on the same agent

The same agent can serve WhatsApp **and** phone calls. The LLM config, tools, and prompt are shared — only the transport differs.

```typescript
const support = pc.agent("support", {
  voice: "elevenlabs:abc",
  language: "en",
  llm: { provider: "openai", model: "gpt-4.1-mini", enabled: true, prompt: "..." },
  tools: [lookupOrder],
});

support.addChannel("whatsapp", { /* WhatsApp config */ });
support.addChannel("phone", "+13186330963");
support.addChannel("webrtc");

// Voice greeting (WhatsApp doesn't use this)
support.on("call.started", (call) => {
  if (call.transport === "phone" || call.transport === "webrtc") {
    call.say("Hello!");
  }
});
// Tools auto-execute on all channels — no extra handler needed.
```

## Voice notes

When a user sends a voice note on WhatsApp, the server automatically:

1. Downloads the audio (OGG/Opus) from the Cloud API
2. Transcribes it using Deepgram Nova-3
3. Feeds the transcript to the LLM as if it were a text message

The agent sees voice notes as regular text. No extra code.

> Requires `DEEPGRAM_API_KEY` set on the voice server.

## The 24-hour service window

Meta enforces a **24-hour service window** for free-form messaging:

- **Inside the window**: the agent can send any text. The window refreshes on every inbound message.
- **Outside the window**: only pre-approved **template messages** can be sent.

The SDK tracks the window automatically. If you try to send when it's closed, the server logs a warning. Template message support is on the roadmap.

## Environment variables

Set these on the voice server (`sdk-server`):

| Variable | Required | Description |
|---|---|---|
| `WHATSAPP_VERIFY_TOKEN` | — | Hub verification token (default: `pinecall-wa-verify`) |
| `WHATSAPP_APP_SECRET` | — | Meta App Secret for webhook HMAC verification |
| `DEEPGRAM_API_KEY` | For voice notes | Required if you want voice note transcription |

## All WhatsApp events

| Event | Data fields | When |
|---|---|---|
| `whatsapp.session_started` | `sessionId`, `contactPhone`, `contactName` | First message from a new contact |
| `whatsapp.message` | `sessionId`, `from`, `name`, `type`, `text`, `messageId` | Incoming message received |
| `whatsapp.response` | `sessionId`, `to`, `text` | Agent sent a response |
| `whatsapp.status` | `status`, `recipient`, `messageId` | Delivery status update |

Status values: `sent` → `delivered` → `read`.

## What's next

- [Tools and Functions](/guides/tools-and-functions) — let your WhatsApp bot take actions
- [Dev mode](/guides/dev-mode) — route specific WhatsApp senders to dev agents
- [Multi-tenant](/guides/multi-tenant) — host many tenants' WhatsApp bots on one agent

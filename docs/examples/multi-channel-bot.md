---
title: "Example: Multi-Channel Bot"
description: "One agent serving phone, WhatsApp, and browser WebRTC simultaneously."
---

# Example: Multi-Channel Bot

A support bot serving phone calls, WhatsApp messages, and a browser widget — from the **same agent**, with the **same prompt and tools**. The agent code doesn't care which transport the conversation arrived on.

## What it does

`support.js` is the support bot for Acme Corp:

- Customers call `+13186330963` (Twilio) → phone conversation
- Customers message Acme's WhatsApp Business number → WhatsApp conversation
- Customers in the app click "Talk to support" → WebRTC browser conversation

All three converge on the same agent. Same prompt. Same tools. Same database. Same logging.

## The complete file

```typescript
// support.js
import { Pinecall } from "@pinecall/sdk";
import express from "express";

// ---- Mock database (replace with yours) ----
const orders = {
  "ORD-001": { status: "shipped", tracking: "1Z999AA10123456784" },
  "ORD-002": { status: "processing" },
  "ORD-003": { status: "delivered", deliveredAt: "2026-05-20" },
};

// ---- Pinecall client ----
const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY });
await pc.connect();

// ---- The agent ----
const support = pc.agent("acme-support", {
  voice: "elevenlabs:EXAVITQu4vr4xnSDxMaL",
  language: "en",
  llm: {
    provider: "openai",
    model: "gpt-4.1-mini",
    enabled: true,
    prompt: `You are Nova, a support agent at Acme Corp.

You can:
- Look up order status with lookupOrder
- Transfer to a human with transferToHuman (use sparingly)
- End the call/conversation when the customer is done

Be concise. On voice, keep responses to 1-2 sentences.
On WhatsApp, you can be slightly longer but still brief.`,
  },
  tools: [
    {
      type: "function",
      function: {
        name: "lookupOrder",
        description: "Look up an order by its ID (format: ORD-XXX)",
        parameters: {
          type: "object",
          properties: { orderId: { type: "string" } },
          required: ["orderId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "transferToHuman",
        description: "Transfer voice call to a human agent. Only works on phone/WebRTC.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "endConversation",
        description: "End the conversation when the customer says goodbye.",
        parameters: { type: "object", properties: {} },
      },
    },
  ],
});

// ---- Add all three channels ----
support.addChannel("phone", "+13186330963");
support.addChannel("webrtc");
support.addChannel("whatsapp", {
  phoneNumberId: process.env.WA_PHONE_NUMBER_ID,
  accessToken: process.env.WA_TOKEN,
  appSecret: process.env.WA_APP_SECRET,
});

// ---- Greet on voice channels (not WhatsApp — that's text) ----
support.on("call.started", (call) => {
  if (call.transport === "phone" || call.transport === "webrtc") {
    if (call.direction === "inbound") {
      call.say("Hi, this is Nova at Acme. How can I help?");
    }
  }
});

// ---- Tool handling (shared across all channels) ----
const handlers = {
  lookupOrder: async ({ orderId }) => orders[orderId] ?? { error: "not_found" },

  transferToHuman: async (_, call) => {
    if (call.transport === "phone" || call.transport === "webrtc") {
      call.say("Sure, let me get a human on the line.");
      call.forward("+15558675309");
      return { transferred: true };
    }
    return { transferred: false, note: "A human will respond within an hour." };
  },

  endConversation: async (_, call) => {
    if (call.transport === "phone" || call.transport === "webrtc") {
      call.say("Thanks for calling. Have a great day!");
      call.once("bot.finished", () => call.hangup());
    }
    return { ended: true };
  },
};

support.on("llm.tool_call", async (data, call) => {
  const results = await Promise.all(
    data.toolCalls.map(async (tc) => ({
      toolCallId: tc.id,
      result: await handlers[tc.name]?.(JSON.parse(tc.arguments), call)
        ?? { error: `unknown: ${tc.name}` },
    }))
  );
  call.toolResult(data.msgId, results);
});

// ---- Logging (universal) ----
support.on("call.ended", async (call, reason) => {
  console.log(
    `[${call.transport}] ${call.id} ended (${reason}) — ${call.duration}s, ${call.transcript.length} msgs`,
  );
  // Save to your DB...
});

// ---- WhatsApp-specific observability ----
support.on("whatsapp.message", (event) => {
  console.log(`💬 ${event.name}: ${event.text}`);
});

// ---- Express server for token endpoint (WebRTC) ----
const app = express();

app.get("/api/token", async (req, res) => {
  // In production: add your auth check here
  const token = await support.createToken("webrtc");
  res.json(token);
});

// ---- Live event stream for dashboard ----
app.get("/api/events", (req, res) => {
  support.stream(res);
});

app.listen(3000, () => {
  console.log("Support bot live on phone, WhatsApp, and WebRTC");
  console.log("Token endpoint: http://localhost:3000/api/token");
  console.log("Event stream:   http://localhost:3000/api/events");
});
```

## Why this works

The agent code never branches on transport. The LLM gets the same prompt and tools regardless of whether the user is calling, messaging, or in the browser. The only places the code checks `call.transport` are:

1. **Greeting** — voice channels need a greeting, WhatsApp doesn't (they message first)
2. **Tool effects** — `transferToHuman` and `endConversation` only make sense on voice

Everything else — tool definitions, the LLM, the response generation — is unified.

## Adding a fourth channel

Need to add SIP for a call center integration? One line:

```typescript
support.addChannel("phone", "sip:bot@trunk.acmetel.com");
```

Need to add chat for the web app's help panel? One line:

```typescript
support.addChannel("chat");
```

The agent doesn't care.

## Deploy

```bash
PINECALL_API_KEY=pk_... \
WA_PHONE_NUMBER_ID=123... \
WA_TOKEN=EAA... \
WA_APP_SECRET=abc... \
node support.js
```

Configure the WhatsApp webhook (in Meta's dashboard) to point to `https://voice.pinecall.io/whatsapp/webhook`. Done.

## What's next

- [Browser widget example](/docs/examples/browser-widget)
- [Multi-tenant guide](/docs/guides/multi-tenant) — host many bots like this
- [WhatsApp guide](/docs/guides/whatsapp) — full WhatsApp setup

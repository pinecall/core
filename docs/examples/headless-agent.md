---
title: "Example: Headless Agent"
description: "Complete runnable example — a phone support agent with zero web server."
---

# Example: Headless Agent

A complete, production-ready voice agent in a single file. No web server, no frontend, no infrastructure beyond a Node.js process. This pattern is ideal for intercoms, IoT devices, single-purpose phone bots, and WhatsApp-only deployments.

## What it does

`support.js` is a phone support agent for an e-commerce store. It answers calls, looks up orders by phone number, and handles returns.

## The complete file

```typescript
// support.js — run with `node support.js`
import { Pinecall, tool } from "@pinecall/sdk";
import { z } from "zod";
import { promises as fs } from "node:fs";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY });
await pc.connect();

const lookupOrder = tool({
  name: "lookupOrder",
  description: "Look up the customer's most recent order.",
  schema: z.object({
    phone: z.string().describe("Customer phone number"),
  }),
  execute: async ({ phone }) => {
    // your logic — query your database, etc.
    return { orderId: "ORD-1234", status: "shipped", eta: "tomorrow" };
  },
});

const agent = pc.agent("support", {
  voice: "elevenlabs/sarah",
  language: "en",
  llm: "openai/gpt-4.1-mini",
  prompt: `You are a support agent for an online store.
Help customers check order status and process returns.
Be friendly, brief, and professional.`,
  phoneNumbers: ["+13186330963"],
  tools: [lookupOrder],
});

// Greeting — spoken by the SDK, NOT the server
agent.on("call.started", (call) => {
  call.say("Hi! Thanks for calling. How can I help you today?");
});

// Log every call to disk
agent.on("call.ended", async (call, reason) => {
  await fs.appendFile("./calls.jsonl", JSON.stringify({
    id: call.id, from: call.from, duration: call.duration,
    reason, endedAt: new Date().toISOString(),
  }) + "\n");
  console.log(`[${call.id}] ${reason} • ${call.duration}s`);
});

console.log("Support agent is live. Ctrl+C to stop.");
```

## Run it

```bash
PINECALL_API_KEY=pk_... node support.js
```

That's it. No web server, no token endpoint, no frontend. The agent answers calls to `+13186330963` and logs every call to `calls.jsonl`. When the LLM calls `lookupOrder`, the SDK validates the args with Zod and runs the execute function automatically.

## Adding more tools

Just define more `tool()` objects and include them in the array:

```typescript
const processReturn = tool({
  name: "processReturn",
  description: "Start a return process for an order.",
  schema: z.object({
    orderId: z.string().describe("The order ID to return"),
    reason: z.string().describe("Reason for the return"),
  }),
  execute: async ({ orderId, reason }) => {
    // your logic — create a return ticket, etc.
    return { returnId: "RET-001", status: "initiated" };
  },
});

const agent = pc.agent("support", {
  // ...same config
  tools: [lookupOrder, processReturn],
});
```

## Adding WhatsApp

Same headless pattern — add a channel:

```typescript
agent.whatsapp({
  phoneNumberId: process.env.WA_PHONE_NUMBER_ID,
  accessToken: process.env.WA_TOKEN,
  appSecret: process.env.WA_APP_SECRET,
});
```

Now the agent answers both phone calls **and** WhatsApp messages. Same prompt, same tools, no extra code.

## Deploy options

- **PM2 / systemd** — long-running daemon on a server
- **Docker container** — one image, multiple instances
- **Fly.io / Railway / Render** — managed processes

The agent only needs outbound network access to `voice.pinecall.io`. No inbound ports, no public IPs.

## What's next

- [Multi-channel bot example](/examples/multi-channel-bot)
- [Chat bot example](/examples/chat-bot)
- [Browser widget example](/examples/browser-widget)
- [Deployment topologies](/concepts/deployment-topologies)

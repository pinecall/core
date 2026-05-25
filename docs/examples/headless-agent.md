---
title: "Example: Headless Agent"
description: "Complete runnable example — a doorbell concierge with zero web server."
---

# Example: Headless Agent

A complete, production-ready voice agent in a single file. No web server, no frontend, no infrastructure beyond a Node.js process. This pattern is ideal for intercoms, IoT devices, single-purpose phone bots, and WhatsApp-only deployments.

## What it does

`julia.js` is the doorbell concierge for a building. It answers calls in Spanish, identifies the visitor, and opens the door for deliveries.

## The complete file

```typescript
// julia.js — run with `node julia.js`
import { Pinecall } from "@pinecall/sdk";
import { promises as fs } from "node:fs";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY });
await pc.connect();

const julia = pc.deploy("julia", {
  voice: "elevenlabs:JBFqnCBsd6RMkjVDRZzb",
  language: "es",
  model: "gpt-4.1-mini",
  prompt: `Eres Julia, la conserje virtual del edificio Mar Azul.
Identifica visitantes. Si es un reparto, abre la puerta con openDoor.
Si vienen a visitar a alguien, pregunta a quién y qué unidad.
Sé breve, amable y profesional.`,
  channels: ["+13186330963"],
  tools: [
    {
      type: "function",
      function: {
        name: "openDoor",
        description: "Abrir la puerta de la calle.",
        parameters: { type: "object", properties: {} },
      },
    },
  ],
});

// Greeting — spoken by the SDK, NOT the server
julia.on("call.started", (call) => {
  call.say("Hola, soy Julia, la conserje del edificio. ¿En qué puedo ayudarte?");
});

// Tool handler
julia.on("llm.tool_call", async (data, call) => {
  const results = await Promise.all(
    data.toolCalls.map(async (tc) => ({
      toolCallId: tc.id,
      result: tc.name === "openDoor"
        ? { opened: true, at: new Date().toISOString() }
        : { error: `unknown: ${tc.name}` },
    }))
  );
  call.toolResult(data.msgId, results);
});

// Log every call to disk
julia.on("call.ended", async (call, reason) => {
  await fs.appendFile("./calls.jsonl", JSON.stringify({
    id: call.id, from: call.from, duration: call.duration,
    reason, endedAt: new Date().toISOString(),
  }) + "\n");
  console.log(`[${call.id}] ${reason} • ${call.duration}s`);
});

console.log("Julia is live. Ctrl+C to stop.");
```

## Run it

```bash
PINECALL_API_KEY=pk_... node julia.js
```

That's it. No web server, no token endpoint, no frontend. The agent answers calls to `+13186330963`, runs in Spanish, and logs every call to `calls.jsonl`.

## Adding more tools

Add tools the same way — define them in the `tools` array, handle them in `llm.tool_call`. For multiple tools, use an object map:

```typescript
const handlers = {
  openDoor: async () => ({ opened: true }),
  callResident: async ({ unit }) => {
    // your logic — call the resident's phone, etc.
    return { called: true, unit };
  },
};

julia.on("llm.tool_call", async (data, call) => {
  const results = await Promise.all(
    data.toolCalls.map(async (tc) => ({
      toolCallId: tc.id,
      result: await handlers[tc.name]?.(JSON.parse(tc.arguments))
        ?? { error: `unknown: ${tc.name}` },
    }))
  );
  call.toolResult(data.msgId, results);
});
```

## Adding WhatsApp

Same headless pattern — add a channel:

```typescript
julia.addChannel("whatsapp", {
  phoneNumberId: process.env.WA_PHONE_NUMBER_ID,
  accessToken: process.env.WA_TOKEN,
  appSecret: process.env.WA_APP_SECRET,
});
```

Now Julia answers both phone calls **and** WhatsApp messages. Same prompt, same tools, no extra code.

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

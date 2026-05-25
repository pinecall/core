---
title: "Example: Headless Agent"
description: "Complete runnable example — a doorbell concierge with zero web server."
---

# Example: Headless Agent

A complete, production-ready voice agent in a single file. No web server, no frontend, no infrastructure beyond a Node.js process. This pattern is ideal for intercoms, IoT devices, single-purpose phone bots, and WhatsApp-only deployments.

## What it does

`julia.js` is the doorbell concierge for a building. It answers calls to the intercom number, identifies the visitor, and either opens the door or notifies a resident.

- Picks up phone calls in Spanish
- Asks who's calling and who they're visiting
- Looks up the resident in the building directory
- Either opens the door (for delivery/expected visitor) or rings the resident's mobile
- Logs everything to disk

## The complete file

```typescript
// julia.js — run with `node julia.js`
import { Pinecall } from "@pinecall/sdk";
import { promises as fs } from "node:fs";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY });
await pc.connect();

// ---- Mock building directory (replace with your DB) ----
const residents = {
  "1A": { name: "Familia García", phone: "+34611111111" },
  "2B": { name: "Familia López", phone: "+34622222222" },
  "3C": { name: "María Fernández", phone: "+34633333333" },
};

async function openDoor() {
  console.log("🔓 Door opened");
  return { opened: true, at: new Date().toISOString() };
}

async function callResident(unit) {
  const resident = residents[unit];
  if (!resident) return { called: false, error: "unknown_unit" };
  console.log(`📞 Calling ${resident.name} (${unit}) at ${resident.phone}`);
  return { called: true, name: resident.name };
}

// ---- The agent ----
const julia = pc.deploy("julia", {
  voice: "elevenlabs:JBFqnCBsd6RMkjVDRZzb",
  language: "es",
  model: "gpt-4.1-mini",
  prompt: `Eres Julia, la conserje virtual del edificio Mar Azul.

Tu trabajo: identificar visitantes y decidir qué hacer.

- Si es una entrega (Amazon, Glovo, Just Eat), abre la puerta directamente.
- Si vienen a visitar a alguien, pregunta a quién y qué unidad. Usa lookupResident.
- Si la unidad existe, llama al residente con callResident.
- Si no existe, di que no encontraste a esa persona y ofrece tomar un mensaje.
- Sé breve, amable y profesional.`,
  channels: ["+13186330963"],
  tools: [
    {
      type: "function",
      function: {
        name: "lookupResident",
        description: "Comprobar si una unidad existe en el edificio.",
        parameters: {
          type: "object",
          properties: { unit: { type: "string", description: "p.ej. 1A, 2B, 3C" } },
          required: ["unit"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "callResident",
        description: "Llamar al teléfono móvil del residente de una unidad.",
        parameters: {
          type: "object",
          properties: { unit: { type: "string" } },
          required: ["unit"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "openDoor",
        description: "Abrir la puerta de la calle. Solo para repartos.",
        parameters: { type: "object", properties: {} },
      },
    },
  ],
});

// ---- Greeting ----
julia.on("call.started", (call) => {
  if (call.direction === "inbound") {
    call.say("Hola, soy Julia, la conserje del edificio. ¿En qué puedo ayudarte?");
  }
});

// ---- Tool handling ----
const handlers = {
  lookupResident: async ({ unit }) =>
    residents[unit] ? { found: true, name: residents[unit].name } : { found: false },
  callResident: async ({ unit }) => callResident(unit),
  openDoor: async () => openDoor(),
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

// ---- Logging ----
julia.on("call.ended", async (call, reason) => {
  const log = {
    id: call.id,
    from: call.from,
    duration: call.duration,
    reason,
    transcript: call.transcript,
    endedAt: new Date().toISOString(),
  };
  await fs.appendFile("./calls.jsonl", JSON.stringify(log) + "\n");
  console.log(`[${call.id}] ${reason} • ${call.duration}s`);
});

console.log("Julia is live. Ctrl+C to stop.");
```

## Run it

```bash
PINECALL_API_KEY=pk_... node julia.js
```

That's it. No web server, no token endpoint, no frontend. The agent answers calls to `+13186330963`, runs in Spanish, calls tools to interact with the building, and logs every call to `calls.jsonl`.

## Deploy options

- **systemd unit** — long-running daemon on a server
- **PM2 / forever** — process supervisor for VPS deployments
- **Docker container** — one image, multiple instances per region
- **Fly.io / Railway / Render** — managed long-running processes
- **Cloud Run with min-instances=1** — serverless with always-on

The agent only needs outbound network access to `voice.pinecall.io`. No inbound ports, no public IPs, no load balancers.

## Adding WhatsApp

The same headless pattern handles WhatsApp. Add a channel:

```typescript
julia.addChannel("whatsapp", {
  phoneNumberId: process.env.WA_PHONE_NUMBER_ID,
  accessToken: process.env.WA_TOKEN,
  appSecret: process.env.WA_APP_SECRET,
});
```

Now Julia answers both phone calls **and** WhatsApp messages from residents. Same prompt, same tools, no extra code.

## What's next

- [Multi-channel bot example](/docs/examples/multi-channel-bot)
- [Chat bot example](/docs/examples/chat-bot)
- [Browser widget example](/docs/examples/browser-widget)
- [Deployment topologies](/docs/concepts/deployment-topologies)

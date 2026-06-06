---
title: "Inbound Voice"
description: "Build a voice agent that answers phone calls."
---

# Inbound Voice

This guide walks through building a phone agent end-to-end: registering a phone number, greeting callers, handling tool calls, and ending the conversation gracefully.

## Prerequisites

- A Pinecall API key
- A phone number on your Pinecall account (purchase one or port one — see [REST API → fetchPhones](/reference/rest-api))
- Node.js ≥ 18

## The minimum viable phone agent

```typescript
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });
await pc.connect();

const receptionist = pc.deploy("receptionist", {
  prompt: "You are the receptionist for Acme Corp. Be brief and warm.",
  model: "gpt-4.1-mini",
  voice: "elevenlabs/sarah",
  language: "en",
  channels: ["+13186330963"],
});

receptionist.on("call.started", (call) => {
  if (call.direction === "inbound") {
    call.say("Thanks for calling Acme. How can I help?");
  }
});

receptionist.on("call.ended", (call, reason) => {
  console.log(`[${call.id}] ${reason} (${call.duration}s)`);
});
```

That's a working phone agent. The server handles audio transport, STT, the LLM, TTS, and turn detection.

## Greeting

There are two ways to greet inbound callers:

### Option 1: `greeting` in `deploy()` (declarative)

If you use `pc.deploy()`, the `greeting` field handles everything — no event handler needed:

```typescript
const agent = pc.deploy("receptionist", {
  voice: "elevenlabs/sarah",
  llm: "openai/gpt-4.1-mini",
  prompt: "You are a receptionist for Acme Corp.",
  channels: ["+13186330963"],

  // Static
  greeting: "Thanks for calling Acme. How can I help?",
});
```

The greeting is added to LLM history by default, so the model knows what was said. You can disable that:

```typescript
greeting: { text: "Welcome to Acme.", addToHistory: false }
```

Or make it dynamic per-call:

```typescript
greeting: async (call) => {
  const customer = await db.findByPhone(call.from);
  return customer ? `Hi ${customer.name}!` : "Hi! How can I help?";
}
```

### Option 2: `call.say()` in `call.started` (programmatic)

If you use `pc.agent()`, handle the greeting yourself:

```typescript
agent.on("call.started", (call) => {
  call.say("Hello! How can I help you today?");
});
```

Use this when you need logic beyond what `greeting` supports — multiple says, conditional behavior, loading data before speaking, etc.

> **Outbound calls** use a different mechanism: pass `greeting` in `agent.dial()`. The server speaks it as soon as the callee picks up. See [Outbound Calls](/guides/outbound-calls).

## Adding tools

Define tools with `tool()` and Zod schemas. The SDK auto-executes them when the LLM calls them:

```typescript
import { Pinecall, tool } from "@pinecall/sdk";
import { z } from "zod";

const lookupOrder = tool({
  name: "lookupOrder",
  description: "Look up an order by ID",
  schema: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => {
    const order = await db.orders.findOne(orderId);
    return order ?? { error: "not_found" };
  },
});

const transferToHuman = tool({
  name: "transferToHuman",
  description: "Escalate to a human specialist.",
  schema: z.object({}),
  execute: async (_, call) => {
    call.say("One moment, connecting you to a specialist.");
    call.forward("+15558675309");
    return { transferred: true };
  },
});

const endCall = tool({
  name: "endCall",
  description: "End the call when the customer says goodbye.",
  schema: z.object({}),
  execute: async (_, call) => {
    call.say("Have a great day. Goodbye!");
    call.once("bot.finished", () => call.hangup());
    return { ended: true };
  },
});

const agent = pc.deploy("receptionist", {
  prompt: "You are a receptionist. Look up orders when asked.",
  model: "gpt-4.1-mini",
  voice: "elevenlabs/sarah",
  language: "en",
  channels: ["+13186330963"],
  tools: [lookupOrder, transferToHuman, endCall],
});

agent.on("call.started", (call) => call.say("Thanks for calling. How can I help?"));
```

See [Tools and Functions](/guides/tools-and-functions) for the full pattern.

## Automatic call endings

- When the user hangs up — emits `call.ended` with reason `hangup`
- After `max_duration_seconds` (default: 10 minutes) — reason `max_duration`
- After `idle_timeout_seconds` of silence (default: 60s) — reason `idle_timeout`

See [Session Limits](/reference/session-limits) for tuning these.

## Listening for live transcripts

Use `bot.word` and `user.message` events to build a live transcript UI or log the conversation as it happens:

```typescript
agent.on("user.message", (event, call) => {
  console.log(`[${call.id}] User: ${event.text}`);
});

let currentBotMessage = "";
agent.on("bot.speaking", () => { currentBotMessage = ""; });
agent.on("bot.word", (event, call) => {
  currentBotMessage += event.word + " ";
  process.stdout.write(`\r[${call.id}] Bot: ${currentBotMessage}`);
});
agent.on("bot.finished", () => console.log());
```

## After the call ends

When `call.ended` fires, the `Call` object is fully populated:

```typescript
agent.on("call.ended", async (call, reason) => {
  await db.calls.create({
    id: call.id,
    from: call.from,
    to: call.to,
    duration: call.duration,
    reason,
    transcript: call.transcript,
    messages: call.messages, // full LLM history including tool calls
    startedAt: call.startedAt,
    endedAt: call.endedAt,
  });
});
```

## What's next

- [Outbound calls](/guides/outbound-calls) — make programmatic outbound calls
- [Tools and Functions](/guides/tools-and-functions) — let the agent take actions
- [Dev mode](/guides/dev-mode) — share one number between prod and any number of devs
- [`Call` API reference](/api/call) — every method

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
  voice: "elevenlabs:EXAVITQu4vr4xnSDxMaL",
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

## Greeting on `call.started`

Always greet on `call.started`. For inbound calls, `call.say()` is the right tool:

```typescript
agent.on("call.started", (call) => {
  if (call.direction === "inbound") {
    call.say("Hello! How can I help you today?");
  }
});
```

For outbound calls, set `greeting` in `agent.dial()` instead — the server speaks it as soon as the callee picks up. See [Outbound Calls](/guides/outbound-calls).

## Handling tool calls

If your agent has tools, handle them via the `llm.tool_call` event:

```typescript
const agent = pc.agent("receptionist", {
  voice: "elevenlabs:EXAVITQu4vr4xnSDxMaL",
  language: "en",
  llm: {
    provider: "openai",
    model: "gpt-4.1-mini",
    enabled: true,
    prompt: "You are a receptionist. Look up orders when asked.",
  },
  tools: [
    {
      type: "function",
      function: {
        name: "lookupOrder",
        description: "Look up an order by ID",
        parameters: {
          type: "object",
          properties: { orderId: { type: "string" } },
          required: ["orderId"],
        },
      },
    },
  ],
});

agent.on("llm.tool_call", async (data, call) => {
  const results = [];
  for (const tc of data.toolCalls) {
    const args = JSON.parse(tc.arguments);
    if (tc.name === "lookupOrder") {
      const order = await db.orders.findOne(args.orderId);
      results.push({ toolCallId: tc.id, result: order ?? { error: "not_found" } });
    }
  }
  call.toolResult(data.msgId, results);
});
```

See [Tools and Functions](/guides/tools-and-functions) for the full pattern.

## Personalizing the conversation per caller

Load CRM data on `call.started` and inject it via prompt variables:

```typescript
const agent = pc.agent("support", {
  voice: "elevenlabs:abc",
  language: "en",
  llm: {
    provider: "openai",
    model: "gpt-4.1-mini",
    enabled: true,
    prompt: `You are a support agent at {{company}}.
Customer: {{name}} ({{tier}} tier).
Account age: {{account_age}} years.`,
  },
});

agent.on("call.started", async (call) => {
  const customer = await crm.findByPhone(call.from);
  if (customer) {
    await call.setPromptVars({
      company: "Acme",
      name: customer.name,
      tier: customer.tier,
      account_age: String(customer.years),
    });
    call.say(`Hi ${customer.name}! How can I help today?`);
  } else {
    call.say("Hi! Thanks for calling Acme. Can I have your account number?");
  }
});
```

## Transferring the call

When the agent decides to escalate, forward to another number:

```typescript
agent.on("llm.tool_call", async (data, call) => {
  for (const tc of data.toolCalls) {
    if (tc.name === "transferToHuman") {
      call.say("One moment, connecting you to a specialist.");
      call.forward("+15558675309");
      return;
    }
  }
});
```

## Ending the call

The agent can hang up explicitly:

```typescript
agent.on("llm.tool_call", async (data, call) => {
  for (const tc of data.toolCalls) {
    if (tc.name === "endCall") {
      call.say("Have a great day. Goodbye!");
      // Wait for the goodbye to finish playing
      call.once("bot.finished", () => call.hangup());
      return;
    }
  }
});
```

Calls also end automatically:

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

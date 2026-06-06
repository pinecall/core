---
title: "Tools and Functions"
description: "Let your agent take actions: look up data, transfer calls, book appointments."
---

# Tools and Functions

Tools are how your agent moves beyond conversation into action: looking up an order, checking inventory, booking a slot, transferring to a human. In Pinecall, tools are **local functions in your process**, not webhooks.

## Defining tools

Use the `tool()` helper with a Zod schema. Tools are auto-executed by the SDK when the LLM calls them — no manual event handler needed.

```typescript
import { Pinecall, tool } from "@pinecall/sdk";
import { z } from "zod";

const lookupOrder = tool({
  name: "lookupOrder",
  description: "Look up an order by its ID.",
  schema: z.object({
    orderId: z.string().describe("The order ID, like ORD-12345"),
  }),
  execute: async ({ orderId }) => {
    return await db.orders.findOne(orderId);
  },
});

const scheduleCallback = tool({
  name: "scheduleCallback",
  description: "Schedule a callback for a specific date and time.",
  schema: z.object({
    datetime: z.string().describe("ISO 8601 datetime"),
    reason: z.string(),
  }),
  execute: async ({ datetime, reason }, call) => {
    return await scheduler.book({
      phone: call.from,
      datetime,
      reason,
    });
  },
});

const agent = pc.agent("support", {
  prompt: "You are a helpful support agent. Use tools to look up information.",
  llm: "openai/gpt-4.1-mini",
  voice: "elevenlabs/sarah",
  language: "en",
  tools: [lookupOrder, scheduleCallback],
});

agent.on("call.started", (call) => call.say("Hi, how can I help?"));
```

That's it. When the LLM decides to call `lookupOrder`, the SDK:

1. Parses the arguments through `z.object({ orderId: z.string() })`
2. Calls your `execute` function with the validated args + the `Call` object
3. Sends the result back to the LLM via `call.toolResult()`

## Tool call lifecycle

```
User: "Where's order ORD-12345?"
   │
   ▼
LLM: decides to call lookupOrder({ orderId: "ORD-12345" })
   │
   ▼
SDK: schema.parse(args) → validates
   │
   ▼
SDK: execute({ orderId: "ORD-12345" }, call) → your function runs
   │
   ▼
SDK: call.toolResult(msgId, [{ toolCallId, result }]) → auto-sent
   │
   ▼
LLM resumes with the tool result in context, produces a spoken response
   │
   ▼
"Your order shipped yesterday. Tracking number is..."
```

## The `call` parameter

Every `execute` function receives the `Call` object as its second argument. Use it to interact with the call mid-tool-execution:

```typescript
const transferToHuman = tool({
  name: "transferToHuman",
  description: "Escalate to a human agent.",
  schema: z.object({
    department: z.enum(["sales", "support", "billing"]),
  }),
  execute: async ({ department }, call) => {
    const numbers = {
      sales: "+15551110000",
      support: "+15551110001",
      billing: "+15551110002",
    };
    call.say("Of course, let me connect you to a specialist.");
    call.forward(numbers[department]);
    return { transferred: true };
  },
});
```

## Why local functions beat webhooks

Other platforms make tools webhook URLs. You define a tool, expose a public endpoint, the platform POSTs to it. The downsides pile up fast:

- **You expose a public endpoint** — attack surface, rate limiting, auth headaches
- **You can't reach internal services** — your DB, your Redis, your hardware
- **Latency** — every tool call is a network roundtrip across the public internet
- **Debuggability** — tool call goes out, response comes back, what happened in between?

Pinecall tools run in your process. That means:

- `await db.query(...)` works directly
- `await redis.get(...)` works directly
- `await hardware.openDoor()` works directly (if your process can reach it)
- Stack traces, breakpoints, and logs work normally
- No public surface to attack
- Sub-millisecond "call" overhead — it's a function call, not an HTTP request

## Common patterns

### Database lookups

```typescript
const findCustomer = tool({
  name: "findCustomer",
  description: "Find a customer by phone number or email.",
  schema: z.object({
    query: z.string().describe("Phone or email"),
  }),
  execute: async ({ query }) => {
    const customer = await db.customers.find({
      or: [{ phone: query }, { email: query }],
    });
    return customer ?? { error: "not_found" };
  },
});
```

### Transfer to human

```typescript
const transferToHuman = tool({
  name: "transferToHuman",
  description: "Escalate to a human agent when the customer is angry or has a complex issue.",
  schema: z.object({
    department: z.enum(["sales", "support", "billing"]),
  }),
  execute: async ({ department }, call) => {
    const numbers = { sales: "+15551110000", support: "+15551110001", billing: "+15551110002" };
    call.say("Of course, let me connect you to a specialist.");
    call.forward(numbers[department]);
    return { transferred: true };
  },
});
```

### Booking / scheduling

```typescript
const bookAppointment = tool({
  name: "bookAppointment",
  description: "Book an appointment in the doctor's calendar.",
  schema: z.object({
    datetime: z.string().describe("ISO 8601 datetime"),
    durationMinutes: z.number(),
    patientName: z.string(),
  }),
  execute: async ({ datetime, durationMinutes, patientName }) => {
    const slot = await calendar.book({
      start: new Date(datetime),
      duration: durationMinutes,
      patient: patientName,
    });
    return slot.success
      ? { booked: true, confirmationId: slot.id }
      : { booked: false, error: slot.conflictReason };
  },
});
```

### End the call

```typescript
const endCall = tool({
  name: "endCall",
  description: "End the call when the customer says goodbye.",
  schema: z.object({}),
  execute: async (_, call) => {
    call.say("Have a great day!");
    call.once("bot.finished", () => call.hangup());
    return { ended: true };
  },
});
```

## Returning errors

If a tool call fails, the SDK catches the error and returns `{ error: err.message }` to the LLM automatically. The LLM can then recover (apologize, retry, ask clarifying questions).

You can also return errors explicitly:

```typescript
const lookupOrder = tool({
  name: "lookupOrder",
  description: "Look up an order by ID.",
  schema: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => {
    const order = await db.orders.findOne(orderId);
    if (!order) return { error: "Order not found" };
    return order;
  },
});
```

## Listening to tool calls (optional)

The `llm.tool_call` event still fires for every tool call — useful for logging, metrics, or UI:

```typescript
agent.on("llm.tool_call", (data, call) => {
  console.log(`Tools called: ${data.toolCalls.map(t => t.name).join(", ")}`);
});
```

## Tools work across all channels

The same tools work for phone, WebRTC, chat, and WhatsApp. The `Call` object is your interface regardless of transport.

## What's next

- [Hot-reload](/concepts/hot-reload) — change the prompt or tools mid-call
- [Events reference](/reference/events) — all events including `llm.tool_call`
- [`Call` API reference](/api/call) — `forward`, `hangup`, etc.

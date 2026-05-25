---
title: "Tools and Functions"
description: "Let your agent take actions: look up data, transfer calls, book appointments."
---

# Tools and Functions

Tools are how your agent moves beyond conversation into action: looking up an order, checking inventory, booking a slot, transferring to a human. In Pinecall, tools are **local functions in your process**, not webhooks.

## Defining tools

Tool definitions use the OpenAI function-calling format. Declare them when creating the agent:

```typescript
const agent = pc.agent("support", {
  voice: "elevenlabs:abc",
  language: "en",
  llm: {
    provider: "openai",
    model: "gpt-4.1-mini",
    enabled: true,
    prompt: "You are a helpful support agent. Use tools to look up information.",
  },
  tools: [
    {
      type: "function",
      function: {
        name: "lookupOrder",
        description: "Look up an order by its ID.",
        parameters: {
          type: "object",
          properties: {
            orderId: { type: "string", description: "The order ID, like ORD-12345" },
          },
          required: ["orderId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "scheduleCallback",
        description: "Schedule a callback for a specific date and time.",
        parameters: {
          type: "object",
          properties: {
            datetime: { type: "string", description: "ISO 8601 datetime" },
            reason: { type: "string" },
          },
          required: ["datetime", "reason"],
        },
      },
    },
  ],
});
```

## Handling tool calls

The LLM decides when to call a tool and emits `llm.tool_call` events. Your handler executes the function and returns the result.

```typescript
agent.on("llm.tool_call", async (data, call) => {
  const results = [];

  for (const tc of data.toolCalls) {
    const args = JSON.parse(tc.arguments);

    try {
      let result;
      switch (tc.name) {
        case "lookupOrder":
          result = await db.orders.findOne(args.orderId);
          break;
        case "scheduleCallback":
          result = await scheduler.book({
            phone: call.from,
            datetime: args.datetime,
            reason: args.reason,
          });
          break;
        default:
          result = { error: `Unknown tool: ${tc.name}` };
      }
      results.push({ toolCallId: tc.id, result });
    } catch (err) {
      results.push({ toolCallId: tc.id, result: { error: err.message } });
    }
  }

  call.toolResult(data.msgId, results);
});
```

A single `llm.tool_call` event can contain multiple parallel tool calls. Always handle the array, not just `toolCalls[0]`.

## Tool call lifecycle

```
User: "Where's order ORD-12345?"
   │
   ▼
LLM: decides to call lookupOrder
   │
   ▼
agent.on("llm.tool_call") fires with { toolCalls: [{ name: "lookupOrder", arguments: '{"orderId":"ORD-12345"}', id: "tc_abc" }], msgId: "msg_def" }
   │
   ▼
Your handler: db.orders.findOne("ORD-12345") → { status: "shipped", trackingNumber: "..." }
   │
   ▼
call.toolResult("msg_def", [{ toolCallId: "tc_abc", result: { status: "shipped", ... } }])
   │
   ▼
LLM resumes with the tool result in context, produces a spoken response
   │
   ▼
"Your order shipped yesterday. Tracking number is..."
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
{
  name: "findCustomer",
  description: "Find a customer by phone number or email.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Phone or email" },
    },
    required: ["query"],
  },
}

case "findCustomer": {
  const customer = await db.customers.find({
    or: [{ phone: args.query }, { email: args.query }],
  });
  result = customer ?? { error: "not_found" };
  break;
}
```

### Transfer to human

```typescript
{
  name: "transferToHuman",
  description: "Escalate to a human agent. Use when the customer is angry or has a complex issue.",
  parameters: {
    type: "object",
    properties: {
      department: { type: "string", enum: ["sales", "support", "billing"] },
    },
    required: ["department"],
  },
}

case "transferToHuman": {
  const numbers = {
    sales: "+15551110000",
    support: "+15551110001",
    billing: "+15551110002",
  };
  call.say("Of course, let me connect you to a specialist.");
  call.forward(numbers[args.department]);
  result = { transferred: true };
  break;
}
```

### Booking / scheduling

```typescript
{
  name: "bookAppointment",
  description: "Book an appointment in the doctor's calendar.",
  parameters: {
    type: "object",
    properties: {
      datetime: { type: "string", description: "ISO 8601 datetime" },
      duration_minutes: { type: "number" },
      patient_name: { type: "string" },
    },
    required: ["datetime", "duration_minutes", "patient_name"],
  },
}

case "bookAppointment": {
  const slot = await calendar.book({
    start: new Date(args.datetime),
    duration: args.duration_minutes,
    patient: args.patient_name,
  });
  result = slot.success
    ? { booked: true, confirmationId: slot.id }
    : { booked: false, error: slot.conflictReason };
  break;
}
```

### End the call

```typescript
{
  name: "endCall",
  description: "End the call. Use when the customer says goodbye.",
  parameters: { type: "object", properties: {} },
}

case "endCall": {
  call.say("Have a great day!");
  call.once("bot.finished", () => call.hangup());
  result = { ended: true };
  break;
}
```

## Returning errors

If a tool call fails, return an `error` field in the result. The LLM will see it and can recover (apologize, retry, ask clarifying questions).

```typescript
try {
  result = await db.orders.findOne(args.orderId);
  if (!result) result = { error: "Order not found" };
} catch (err) {
  result = { error: `Lookup failed: ${err.message}` };
}
```

Don't throw — that breaks the conversation. Return the error so the LLM can handle it.

## Tools work across all channels

The same tool handlers work for phone, WebRTC, chat, and WhatsApp. The `Call` object is your interface regardless of transport.

```typescript
agent.on("llm.tool_call", async (data, call) => {
  // call.transport === "phone" | "webrtc" | "chat" | "whatsapp"
  // call.from is always populated
  // call.toolResult() always works
});
```

## What's next

- [Hot-reload](/concepts/hot-reload) — change the prompt or tools mid-call
- [Events reference](/reference/events) — all events including `llm.tool_call`
- [`Call` API reference](/api/call) — `toolResult`, `forward`, `hangup`, etc.

---
title: "Example: Chat Bot"
description: "Text chat agent using @pinecall/chat-core — same agent, text instead of voice."
---

# Example: Chat Bot

A text-based chat agent using `@pinecall/chat-core`. Same Pinecall agent, same prompt, same tools — but text over WebSocket instead of audio over WebRTC.

## What it does

A booking assistant for a spa. Users chat via a React widget, the agent responds with streamed text, and calls tools to check availability and create appointments.

## Backend — `server.js`

```typescript
import { Pinecall } from "@pinecall/sdk";
import express from "express";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });
await pc.connect();

const agent = pc.deploy("florencia", {
  prompt: `You are Florencia, the booking assistant for Blossom Beauty Spa.
Help customers book appointments. Be warm and concise.
Available services: Haircut ($30), Color ($80), Facial ($60), Massage ($90).`,
  model: "gpt-4.1-mini",
  language: "es",
  channels: ["chat", "webrtc"],
  allowedOrigins: ["http://localhost:*"],
  tools: [
    {
      type: "function",
      function: {
        name: "getAvailability",
        description: "Check available time slots for a service.",
        parameters: {
          type: "object",
          properties: {
            service: { type: "string" },
            date: { type: "string", description: "YYYY-MM-DD" },
          },
          required: ["service", "date"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "createBooking",
        description: "Book an appointment.",
        parameters: {
          type: "object",
          properties: {
            service: { type: "string" },
            date: { type: "string" },
            time: { type: "string" },
            name: { type: "string" },
          },
          required: ["service", "date", "time", "name"],
        },
      },
    },
  ],
});

// Tool handlers — simple object map, no switch/case
const handlers = {
  getAvailability: async ({ service, date }) => ({
    service, date,
    slots: ["10:00", "11:30", "14:00", "16:00"],
  }),
  createBooking: async ({ service, date, time, name }) => ({
    confirmed: true, service, date, time, name,
    id: `BK-${Date.now()}`,
  }),
};

agent.on("llm.tool_call", async (data, call) => {
  const results = await Promise.all(
    data.toolCalls.map(async (tc) => ({
      toolCallId: tc.id,
      result: await handlers[tc.name]?.(JSON.parse(tc.arguments))
        ?? { error: `unknown: ${tc.name}` },
    }))
  );
  call.toolResult(data.msgId, results);
});

// SSE events for a live dashboard
const app = express();
app.use(express.static("public"));
app.get("/events", (req, res) => agent.stream(res));
app.listen(3000, () => console.log("http://localhost:3000"));
```

## Frontend — React chat widget

```tsx
import { usePinecallChat } from "@pinecall/chat-core/react";

function Chat() {
  const { messages, send, connected, typing } = usePinecallChat({
    agent: "florencia",
  });

  if (!connected) return <p>Connecting...</p>;

  return (
    <div className="chat">
      <div className="messages">
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <strong>{m.role === "user" ? "You" : "Florencia"}:</strong>{" "}
            {m.text}
            {m.isStreaming && "▊"}
          </div>
        ))}
        {typing && <div className="msg bot typing">Florencia is typing…</div>}
      </div>

      <input
        placeholder="Type a message..."
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.currentTarget.value.trim()) {
            send(e.currentTarget.value);
            e.currentTarget.value = "";
          }
        }}
      />
    </div>
  );
}
```

The `usePinecallChat` hook handles:

- Token fetching (via `allowedOrigins`)
- WebSocket connection lifecycle
- Message state (streamed token-by-token)
- Typing indicator
- Auto-reconnect

## Same agent, voice + chat

Notice the `channels: ["chat", "webrtc"]` — this agent handles **both** text chat and voice calls. A customer can chat first, then switch to voice. Same prompt, same tools, same conversation context.

## What's next

- [`@pinecall/chat-core` reference](/docs/chat-core/overview) — full ChatSession API
- [Browser Widget example](/docs/examples/browser-widget) — the voice equivalent
- [SSE Event Streaming](/docs/guides/sse-streaming) — build a live dashboard

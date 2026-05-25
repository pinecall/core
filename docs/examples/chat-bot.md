---
title: "Example: Chat Bot"
description: "Text chat agent using @pinecall/chat-core — same agent, text instead of voice."
---

# Example: Chat Bot

A text-based chat agent using `@pinecall/chat-core`. Same Pinecall agent, same prompt, same tools — but text over WebSocket instead of audio over WebRTC.

## What it does

A booking assistant for a spa. Users chat via a React widget, the agent responds with streamed text, and calls a tool to check availability.

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
  channels: ["chat"],
  allowedOrigins: ["http://localhost:*"],
  tools: [
    {
      type: "function",
      function: {
        name: "getAvailability",
        description: "Check available time slots for a service and date.",
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
  ],
});

agent.on("llm.tool_call", async (data, call) => {
  const results = await Promise.all(
    data.toolCalls.map(async (tc) => ({
      toolCallId: tc.id,
      result: tc.name === "getAvailability"
        ? { slots: ["10:00", "11:30", "14:00", "16:00"] }
        : { error: `unknown: ${tc.name}` },
    }))
  );
  call.toolResult(data.msgId, results);
});

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

The `usePinecallChat` hook handles token fetching (via `allowedOrigins`), WebSocket lifecycle, streamed messages (token-by-token), typing indicator, and auto-reconnect.

## Same agent, voice + chat

Change `channels: ["chat"]` to `channels: ["chat", "webrtc"]` and the same agent handles **both** text and voice. Same prompt, same tools, same conversation context.

## What's next

- [`@pinecall/chat-core` reference](/chat-core/overview) — full ChatSession API
- [Browser Widget example](/examples/browser-widget) — the voice equivalent
- [SSE Event Streaming](/guides/sse-streaming) — build a live dashboard

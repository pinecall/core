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
import { Pinecall, tool } from "@pinecall/sdk";
import { z } from "zod";
import express from "express";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });
await pc.connect();

const getAvailability = tool({
  name: "getAvailability",
  description: "Check available time slots for a service and date.",
  schema: z.object({
    service: z.string(),
    date: z.string().describe("YYYY-MM-DD"),
  }),
  execute: async ({ service, date }) => ({
    slots: ["10:00", "11:30", "14:00", "16:00"],
  }),
});

const agent = pc.agent("florencia", {
  prompt: `You are Florencia, the booking assistant for Blossom Beauty Spa.
Help customers book appointments. Be warm and concise.
Available services: Haircut ($30), Color ($80), Facial ($60), Massage ($90).`,
  llm: "openai/gpt-4.1-mini",
  language: "es",
  channels: ["chat"],
  allowedOrigins: ["http://localhost:*"],
  tools: [getAvailability],
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

## Rendering tool results in the UI

Tools execute on the backend — the agent calls `getAvailability`, gets slots, and **responds with text** describing them. But you can also show rich UI alongside the chat.

Use `setContext` to sync frontend state into the agent's prompt, so it knows what the user is seeing:

```tsx
import { usePinecallChat } from "@pinecall/chat-core/react";
import { useState, useEffect } from "react";

function BookingChat() {
  const { messages, send, connected, typing, setContext } = usePinecallChat({
    agent: "florencia",
  });
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);

  // Sync selection to the agent's prompt
  useEffect(() => {
    if (selectedSlot) {
      setContext("user_selection", `User selected time slot: ${selectedSlot}`);
    }
    return () => setContext("user_selection", null);
  }, [selectedSlot, setContext]);

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

      {/* Quick-select buttons — inject user choice as text */}
      <div className="quick-actions">
        {["Haircut", "Facial", "Massage"].map((service) => (
          <button
            key={service}
            onClick={() => send(`I'd like to book a ${service}`)}
          >
            {service}
          </button>
        ))}
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

### Chat API reference

| API | What it does |
|-----|-------------|
| `messages` | Array of `{ id, role, text, isStreaming }` — full conversation |
| `send(text)` | Send a user message |
| `typing` | True while the bot is streaming |
| `setContext(key, value)` | Inject context into the LLM prompt (e.g. form state) |
| `connected` | True when WebSocket is connected |

### How `setContext` works in chat

Same as voice — the server appends your context as a `## UI Context` section in the system prompt. The agent can reference it naturally:

```
"The user selected the 10:00 AM slot, now ask for their name."
```

## Same agent, voice + chat

Change `channels: ["chat"]` to `channels: ["chat", "webrtc"]` and the same agent handles **both** text and voice. Same prompt, same tools, same conversation context.

## What's next

- [`@pinecall/chat-core` reference](/chat-core/overview) — full ChatSession API
- [Browser Widget example](/examples/browser-widget) — the voice equivalent with interactive tool UI
- [SSE Event Streaming](/guides/sse-streaming) — build a live dashboard


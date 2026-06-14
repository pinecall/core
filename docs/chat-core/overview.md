---
title: "@pinecall/chat-core"
description: "Text chat client for Pinecall voice agents. Framework-agnostic core + React hook."
---

# @pinecall/chat-core

Text chat client for Pinecall agents. The chat counterpart to `@pinecall/voice-core` — same agents, same prompts, same tools, but text-only over WebSocket instead of audio over WebRTC.

```bash
npm install @pinecall/chat-core
```

> **Browser-only.** Uses native `WebSocket` and `EventTarget` APIs. Works in any modern browser, bundler, or SSR-hydrated app.

## What it does

`chat-core` lets your browser talk to a Pinecall agent in plain text. It:

- Fetches a short-lived token from the voice server
- Opens a WebSocket to `/chat/ws`
- Sends user messages, receives streamed bot responses (token-by-token)
- Exposes the conversation as reactive state + events
- Supports the same `setContext` mechanism as `voice-widget` for syncing UI state

It does **not** include UI. For React you get a hook (`usePinecallChat`). For Vue, Svelte, or vanilla JS you use the `ChatSession` class directly.

## When to use it

| | Use |
|---|---|
| You want voice with UI rendering | [`@pinecall/voice-widget`](/voice-widget/overview) |
| You want voice with no UI assumptions | [`@pinecall/voice-core`](/voice-core/overview) |
| **You want text chat** | **`@pinecall/chat-core`** |
| You want to embed both voice + chat | Use both packages on the same agent |

The same agent (`pc.agent("florencia", ...)`) can have a `webrtc` channel **and** a `chat` channel — `chat-core` connects to the chat channel. Same prompt, same tools, same conversation logic.

## Quick start (vanilla)

```typescript
import { ChatSession } from "@pinecall/chat-core";

const chat = new ChatSession({ agent: "florencia" });

chat.addEventListener("message", (e) => {
  const m = e.detail.message;
  console.log(`${m.role}: ${m.text}`);
});

await chat.connect();
chat.send("Hola, quiero reservar un turno");
```

## Quick start (React)

```tsx
import { usePinecallChat } from "@pinecall/chat-core/react";

function Chat() {
  const { messages, send, connected, typing } = usePinecallChat({ agent: "florencia" });

  if (!connected) return <p>Connecting...</p>;

  return (
    <div>
      {messages.map((m) => (
        <p key={m.id}>
          <strong>{m.role}:</strong> {m.text}
          {m.isStreaming && "▊"}
        </p>
      ))}
      {typing && <p>Bot is typing…</p>}
      <input
        placeholder="Type a message..."
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            send(e.currentTarget.value);
            e.currentTarget.value = "";
          }
        }}
      />
    </div>
  );
}
```

React is an **optional** peer dependency — the React subpath (`@pinecall/chat-core/react`) is only loaded if you import it.

## How it fits with the rest

```
Browser                              Server
─────────                            ──────
@pinecall/chat-core      ───────►   voice.pinecall.io  ────► @pinecall/sdk
   ChatSession                                                    │
                                                              agent.on("user.message")
                                                              call.reply(...)
```

The agent's chat channel routes through the same LLM pipeline as voice — including tool calling. Anything you've built for the voice agent (tools, prompt, hot-reload, multi-tenant) works on the chat channel without changes.

## What's next

- [`ChatSession` API](/chat-core/chat-session) — full reference for both vanilla and React

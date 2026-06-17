---
title: "ChatSession API"
description: "Full reference for ChatSession (vanilla) and usePinecallChat (React)."
---

# `ChatSession` API

The `ChatSession` class is the framework-agnostic core. For React there's also the `usePinecallChat` hook which wraps the same class with `useSyncExternalStore`.

## `ChatSession` (vanilla)

### Constructor

```typescript
import { ChatSession } from "@pinecall/web/chat";

const chat = new ChatSession({ agent: "florencia" });
```

| Option | Type | Required | Description |
|---|---|---|---|
| `agent` | `string` | ✅ | Agent slug (e.g. `"florencia"`, `"dev-berna-florencia"`) |
| `server` | `string` | — | Voice server URL (default: `https://voice.pinecall.io`) |

### Methods

| Method | Description |
|---|---|
| `connect()` | Connect — fetches token, opens WebSocket |
| `disconnect()` | Close the WebSocket connection |
| `destroy()` | Disconnect + clear all subscribers. Do not reuse. |
| `send(text)` | Send a text message to the agent |
| `setContext(key, value)` | Inject / update / clear keyed context in the LLM prompt |
| `getState()` | Read-only snapshot of current state |
| `subscribe(cb)` | Subscribe to state changes (returns unsubscribe) |

### Events (`EventTarget`)

| Event | `detail` | When |
|---|---|---|
| `status` | `{ status }` | Connection status changed |
| `message` | `{ message }` | New or updated message |
| `error` | `{ error }` | Error occurred |
| `change` | `{ state }` | Any state mutation (most general) |
| `event` | raw payload | Every raw server event |

### State shape

```typescript
interface ChatSessionState {
  status: "idle" | "connecting" | "connected" | "error" | "destroyed";
  error: string | null;
  messages: ChatMessage[];
  typing: boolean;          // true while bot is streaming a response
  streamingText: string;    // partial text of the current bot response
  sessionId: string | null;
}

interface ChatMessage {
  id: number;
  role: "user" | "bot";
  text: string;
  messageId?: string;       // server-assigned ID (bot messages)
  isStreaming?: boolean;    // true while bot is still streaming
}
```

### Reactive subscribe pattern

Works with any reactive system — MobX, signals, Vue refs, Svelte stores:

```typescript
const unsubscribe = chat.subscribe(() => {
  const state = chat.getState();
  console.log("Messages:", state.messages.length);
  console.log("Typing:", state.typing);
});

// clean up
unsubscribe();
```

### Injecting dynamic context

Same pattern as `@pinecall/web`'s `setContext()` — inject live UI state into the LLM's system prompt:

```typescript
chat.setContext("cart", JSON.stringify({
  items: ["Corte de cabello", "Tinte"],
  total: 85.00,
}));

// clear a context key
chat.setContext("cart", null);
```

The agent's system prompt picks this up automatically:

```
## UI Context
### cart
{"items":["Corte de cabello","Tinte"],"total":85.00}
```

## `usePinecallChat` (React)

React-only hook exported from `@pinecall/web/chat/react`. Wraps `ChatSession` with `useSyncExternalStore` for efficient rendering. Session is created once on mount and destroyed on unmount.

### Quick usage

```tsx
import { usePinecallChat } from "@pinecall/web/chat/react";

function Chat() {
  const { messages, send, connected, typing, streamingText } = usePinecallChat({
    agent: "florencia",
  });

  if (!connected) return <p>Connecting...</p>;

  return (
    <div>
      {messages.map((m) => (
        <p key={m.id}>
          <strong>{m.role}:</strong> {m.text}
          {m.isStreaming && "▊"}
        </p>
      ))}
      {typing && <p>Bot is typing: {streamingText}▊</p>}
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

### Hook options

| Option | Type | Default | Description |
|---|---|---|---|
| `agent` | `string` | **required** | Agent ID |
| `server` | `string` | `"https://voice.pinecall.io"` | Voice server URL |
| `autoConnect` | `boolean` | `true` | Connect on mount automatically |

### Hook return

| Field | Type | Description |
|---|---|---|
| `messages` | `ChatMessage[]` | All messages in the conversation |
| `send` | `(text: string) => void` | Send a text message |
| `connected` | `boolean` | `true` when connected to the server |
| `typing` | `boolean` | `true` while the bot is streaming |
| `streamingText` | `string` | Partial text of the current bot response |
| `error` | `string \| null` | Current error, if any |
| `setContext` | `(key, value) => void` | Inject dynamic context into the LLM prompt |
| `connect` | `() => void` | Manually connect (if `autoConnect: false`) |
| `disconnect` | `() => void` | Manually disconnect |

## Protocol

What happens under the hood:

```
Browser                                  Voice Server
   │                                         │
   ├─ GET /chat/token?agent_id=X ──────────►│  (short-lived token)
   │◄─ { token: "cht_xxx" } ─────────────────┤
   │                                         │
   ├─ WS /chat/ws?token=cht_xxx ───────────►│  (open WebSocket)
   │◄─ { event: "chat.connected" } ──────────┤
   │                                         │
   ├─ { event: "message", text } ──────────►│  (user sends)
   │◄─ { event: "chat.token", token: "..." } │  (streaming bot tokens)
   │◄─ { event: "chat.token", token: "..." } │
   │◄─ { event: "chat.done", text: "..." } ──│  (stream complete)
   │                                         │
   ├─ { event: "set_context", key, value } ►│  (inject LLM context)
```

## Related packages

| Package | Description |
|---|---|
| [`@pinecall/sdk`](/api/pinecall) | Server-side SDK — agent, call, tools, channels |
| [`@pinecall/web/core`](/web/core/overview) | WebRTC voice session (framework-agnostic) |
| [`@pinecall/web`](/web/widget/overview) | React voice widget with animated orb |

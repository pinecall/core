---
title: "Example: Browser Widget"
description: "Express backend + React frontend with VoiceWidget. Click the orb, talk."
---

# Example: Browser Widget

An Express backend + React frontend. Users click the orb, talk to your agent — no phone number needed.

## Install

```bash
npm install @pinecall/sdk @pinecall/web express
```

## Backend — `server.js`

```typescript
import express from "express";
import { Pinecall } from "@pinecall/sdk";

const app = express();
const pc = new Pinecall();

const mara = pc.agent("mara", {
  prompt: `You are Mara, a friendly voice assistant.
Be brief — 1-2 sentences per response.`,
  llm: "openai/gpt-5-chat-latest",
  voice: "elevenlabs/sarah",
  stt: "deepgram/flux",
  language: "en",
  allowedOrigins: ["http://localhost:*"],
  greeting: "Hi! I'm Mara. How can I help?",
});

mara.on("call.ended", (call, reason) => {
  console.log(`Call ended: ${call.id} — ${reason} (${call.duration}s)`);
});

// Token endpoint — add your own auth in production
app.get("/api/token", async (req, res) => {
  const token = await mara.createToken("webrtc");
  res.json(token);
});

// SSE event stream
app.get("/events", (req, res) => mara.stream(res));

app.listen(3000, () => console.log("http://localhost:3000"));
```

## Frontend — React

```tsx
import { VoiceWidget } from "@pinecall/web";

function App() {
  return (
    <div>
      <h1>Talk to Mara</h1>
      <VoiceWidget
        agent="mara"
        tokenProvider={async () => {
          const res = await fetch("/api/token");
          return res.json();
        }}
      />
    </div>
  );
}
```

That's it. The `VoiceWidget` renders the orb, handles mic permissions, WebRTC connection, and audio streaming.

## With `allowedOrigins` (simpler)

For demos, skip the token endpoint entirely. The `allowedOrigins` config lets the widget auto-fetch tokens:

```tsx
// No tokenProvider needed — widget auto-fetches via allowedOrigins
<VoiceWidget agent="mara" />
```

This works because `allowedOrigins: ["http://localhost:*"]` in the backend allows token requests from matching browser origins. For production, use the `tokenProvider` pattern with real auth.

## Rendering tools in the UI

The `VoiceWidget` supports **interactive tool UI** — the agent calls tools on the backend, and the results appear as clickable components in the browser.

### Backend — add a tool

```typescript
import { tool } from "@pinecall/sdk";
import { z } from "zod";

const getSlots = tool({
  name: "getSlots",
  description: "Get available time slots for a date.",
  schema: z.object({ date: z.string() }),
  execute: async ({ date }) => ({
    slots: ["10:00", "11:30", "14:00", "16:00"],
  }),
});

const mara = pc.agent("mara", {
  // ...config from above...
  tools: [getSlots],
});
```

### Frontend — render the tool result

Pass `trackedTools` to tell the widget which results to capture. Use `useVoice()` inside a child component to render them:

```tsx
import { VoiceWidget, useVoice } from "@pinecall/web";

function SlotPicker() {
  const { toolCalls, sendText, dismissTool } = useVoice();

  const slots = toolCalls.find(tc => tc.name === "getSlots" && tc.result);
  if (!slots) return null;

  return (
    <div className="slot-picker">
      <h3>Pick a time</h3>
      {slots.result.slots.map((slot) => (
        <button
          key={slot}
          onClick={() => {
            sendText(`I'll take the ${slot} slot`);
            dismissTool(slots.toolCallId);
          }}
        >
          {slot}
        </button>
      ))}
    </div>
  );
}

function App() {
  return (
    <VoiceWidget
      agent="mara"
      trackedTools={["getSlots"]}
      tokenProvider={async () => {
        const res = await fetch("/api/token");
        return res.json();
      }}
    >
      <SlotPicker />
    </VoiceWidget>
  );
}
```

### API reference

| API | What it does |
|-----|-------------|
| `trackedTools={["getSlots"]}` | Captures results for these tool names |
| `useVoice()` | Hook — returns `toolCalls`, `sendText`, `dismissTool`, `setContext` |
| `toolCalls` | Array of `{ name, toolCallId, result }` — live tool state |
| `sendText(text)` | Injects text as if the user spoke it (click → voice) |
| `dismissTool(id)` | Removes a tool from state after interaction |
| `setContext(key, value)` | Injects context into the LLM prompt in real time |

### Context injection

Sync UI state back to the agent's prompt so it knows what the user sees:

```tsx
const { setContext } = useVoice();

useEffect(() => {
  setContext("form_state", `Name: ${name}, Email: ${email}`);
  return () => setContext("form_state", null);
}, [name, email]);
```

The server appends this as a `## UI Context` section in the system prompt.

> For a full working example with slot picker, contact form with auto-fill, and confirmation card, see the [`booking-tools` example](https://github.com/pinecall/sdk/tree/master/examples/booking-tools).

## Run it

```bash
PINECALL_API_KEY=pk_... node server.js
```

Open `http://localhost:3000`. Click the orb. Talk.

## Production checklist

- [ ] **Auth on `/api/token`** — add session/JWT check, never expose without auth
- [ ] **Rate limit** — cap tokens per user per hour
- [ ] **Remove `allowedOrigins`** — use `tokenProvider` with your auth instead
- [ ] **Mic permission UX** — explain why you need mic access before the click

## What's next

- [Security](/security) — production token auth
- [Tools API](/web/widget/tools-api) — full interactive tool UI reference
- [Headless agent example](/examples/headless-agent) — backend-only agents


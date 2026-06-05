---
title: "Human Takeover"
description: "Pause the AI agent so a human can intervene in real-time conversations."
---

# Human Takeover

The human-in-the-loop system lets a human operator take over a conversation from the AI agent. While paused, messages still flow to the SDK — the LLM just doesn't respond. The human sends messages through the SDK, and the AI resumes with full context when done.

## How it works

```
AI_ACTIVE ──(pause)──▶ HUMAN_ACTIVE ──(resume)──▶ AI_ACTIVE
```

When paused:
- Incoming messages are forwarded to the SDK (with `paused: true`)
- The LLM **does not generate responses** — no auto-reply
- Voice notes are still transcribed (so the human can read them)
- Human messages are added to LLM history for seamless context on resume

## Pause granularity

Three levels, all through the same API:

| Method | Scope | Use case |
|--------|-------|----------|
| `agent.pause(sessionId)` | One conversation | "I'll handle this customer" |
| `agent.pause({ contact })` | All sessions with a contact | "This person needs human attention" |
| `agent.pause()` | Entire agent | "Turn off the AI completely" |

Resume follows the same pattern. Global `agent.resume()` clears all levels.

## Full example: WhatsApp customer support

```typescript
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });
await pc.connect();

const support = pc.agent("support", {
  language: "en",
  llm: {
    provider: "openai",
    model: "gpt-4.1-mini",
    enabled: true,
    prompt: "You are a helpful support agent.",
  },
});

support.addChannel("whatsapp", {
  phoneNumberId: process.env.WA_PHONE_ID!,
  accessToken: process.env.WA_TOKEN!,
});

// Track active sessions for the dashboard
const sessions = new Map<string, { contact: string; name: string }>();

support.on("whatsapp.session_started", (event) => {
  sessions.set(event.sessionId as string, {
    contact: event.contactPhone as string,
    name: event.contactName as string,
  });
});

support.on("whatsapp.message", (event) => {
  const sessionId = event.sessionId as string;
  const paused = event.paused as boolean;

  if (paused) {
    // AI is paused — route to human dashboard
    console.log(`[PAUSED] ${event.name}: ${event.text}`);
    notifyHumanDashboard(sessionId, event);
    return;
  }

  // Normal: AI handles automatically
  console.log(`[AI] ${event.name}: ${event.text}`);
});

// ── Dashboard API (e.g. Express routes) ──

// Human takes over a session
app.post("/api/takeover/:sessionId", (req, res) => {
  support.pause(req.params.sessionId);
  res.json({ ok: true });
});

// Human sends a message
app.post("/api/send/:sessionId", (req, res) => {
  support.sendMessage({
    sessionId: req.params.sessionId,
    text: req.body.text,
  });
  res.json({ ok: true });
});

// Human hands back to AI
app.post("/api/handback/:sessionId", (req, res) => {
  support.resume(req.params.sessionId);
  res.json({ ok: true });
});
```

## Events

| Event | When | Data |
|-------|------|------|
| `session.paused` | After `agent.pause()` | `{ sessionId?, contact? }` |
| `session.resumed` | After `agent.resume()` | `{ sessionId?, contact? }` |
| `whatsapp.message` | Message received (always) | `{ paused: true }` when paused |
| `whatsapp.response` | Response sent | `{ source: "human" }` when human |

```typescript
support.on("session.paused", (event) => {
  console.log(`⏸ Paused: session=${event.sessionId}`);
});

support.on("session.resumed", (event) => {
  console.log(`▶ Resumed: session=${event.sessionId}`);
});
```

## Protocol messages

These are the wire messages exchanged between SDK and server. You don't need to use these directly — the SDK methods handle them.

### `session.pause` (SDK → Server)

```json
{
  "event": "session.pause",
  "agent_id": "support",
  "session_id": "wa-abc123"
}
```

Omit `session_id` and send `contact` for contact-level pause. Omit both for global.

### `session.resume` (SDK → Server)

```json
{
  "event": "session.resume",
  "agent_id": "support",
  "session_id": "wa-abc123"
}
```

### `session.send` (SDK → Server)

```json
{
  "event": "session.send",
  "agent_id": "support",
  "session_id": "wa-abc123",
  "text": "I'm a human agent. Let me help."
}
```

### Confirmations (Server → SDK)

```json
{ "event": "session.paused", "agent_id": "support", "session_id": "wa-abc123" }
{ "event": "session.resumed", "agent_id": "support", "session_id": "wa-abc123" }
{ "event": "session.sent", "agent_id": "support", "session_id": "wa-abc123" }
```

## Context preservation

Human messages are recorded in the LLM conversation history as `assistant` messages. When the AI resumes, it has full context of what the human said. The conversation flows naturally without the customer noticing the handover.

## Channel support

| Channel | Pause/Resume | Send as Human | Status |
|---------|-------------|---------------|--------|
| WhatsApp | ✅ | ✅ | Available now |
| Voice | ✅ (planned) | via `inject_text` | Roadmap |
| Chat | ✅ (planned) | ✅ (planned) | Roadmap |

The pause state data model already supports voice call IDs and chat session IDs — the routing just needs to be wired in `LLMHandler.on_user_message()`.

## What's next

- [WhatsApp guide](/guides/whatsapp) — set up the WhatsApp channel
- [Events reference](/reference/events) — all event data shapes
- [Agent API](/api/agent) — `pause()`, `resume()`, `sendMessage()` reference

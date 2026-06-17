---
title: "Examples"
description: "Runnable examples showing Pinecall SDK features in action."
---

# Examples

Each example is a self-contained project in `examples/` following the `agent/index.js` convention. Clone, configure, and run.

## Quick Start

```bash
cd examples/<example>
cp .env.example .env         # edit with your values
npm install
pinecall run agent/index.js   # or agent/index.ts
```

---

## Runnable Examples

### Simple Agent

**`examples/simple/`** — The minimal Pinecall setup. A voice agent with `JsonFileHistory` for automatic call persistence.

**What it shows:**
- `agent/index.js` convention — auto-connect, export agent
- `greeting` in config — no `call.started` handler needed
- `JsonFileHistory` for automatic call persistence
- Auto-restored history for returning callers

```typescript
// agent/index.js
const pc = new Pinecall();

export const agent = pc.agent("simple-agent", {
  voice: "elevenlabs/sarah",
  stt: "deepgram/flux",
  llm: "openai/gpt-5-chat-latest",
  phoneNumber: process.env.PHONE,
  greeting: "Hello! How can I help you today?",
  history: new JsonFileHistory("./data/calls.json"),
});
```

📖 Related: [Inbound Voice](/guides/inbound-voice) · [Conversation History](/guides/conversation-history)

---

### Reservations Agent

**`examples/reservations/`** — A restaurant reservation agent with tools. Demonstrates the `tool()` + Zod pattern with `agent/index.ts` and `agent/tools.ts`.

**What it shows:**
- `tool()` with Zod schemas for type-safe tool definitions
- Tools in a separate `agent/tools.ts` module
- Agent exports pattern — `export const agent = pc.agent(...)`
- `pinecall run agent/index.ts` for live development

```typescript
// agent/tools.ts
export const checkAvailability = tool({
  name: "checkAvailability",
  description: "Check table availability for a date and party size.",
  schema: z.object({
    date: z.string(),
    time: z.string(),
    partySize: z.number(),
  }),
  execute: async ({ date, time, partySize }) => ({ available: true, table: "garden terrace" }),
});
```

📖 Related: [Tool definitions](/api/agent#creation) · [CLI reference](/reference/cli#pinecall-run-file)

---

### Turn Detection

**`examples/turn-detection/`** — Debug turn detection events in real-time. Switch between Flux (native turns) and Nova-3 (SmartTurn + Silero) by changing `MODEL` in `.env`.

**What it shows:**
- `speech.started`, `user.speaking`, `user.message` event flow
- `turn.pause` (SmartTurn analyzing) vs `turn.end` (confirmed)
- `bot.speaking` / `bot.finished` / `bot.interrupted` (barge-in)
- Colored console output with timestamps

**Config via `.env`:**
```env
PHONE=+13049709763
MODEL=nova          # "flux" or "nova"
STT_LANG=es         # "en", "es", "ar", etc.
```

**Key difference to observe:**
| | Flux | Nova-3 |
|---|---|---|
| `turn.pause` | ❌ Never | ✅ SmartTurn emits while analyzing |
| Turn speed | ~200ms (native) | ~400-600ms (Silero → SmartTurn) |

📖 Related: [Turn Detection Guide](/concepts/turn-detection) · [STT Providers](/reference/stt-providers)

---

### Call Ringing

**`examples/ringing/`** — Accept or reject incoming calls programmatically. When `ringing: true`, calls emit `call.ringing` instead of auto-answering.

**What it shows:**
- `call.ringing` event with caller info
- `call.accept()` and `call.reject(reason)` flow
- Blacklist filtering (reject specific numbers)
- Timeout auto-accept (if SDK doesn't respond in time)

```typescript
agent.on("call.ringing", (call) => {
  if (BLACKLIST.includes(call.from)) {
    call.reject("busy");
  } else {
    call.accept();
  }
});
```

📖 Related: [Call Ringing Guide](/guides/call-ringing)

---

### Conversation History

**`examples/history/`** — Conversation persistence across calls. When the same contact calls again, the agent restores the previous conversation context.

**What it shows:**
- `JsonFileHistory` — save/load to a JSON file
- `history.findByContact()` — find prior conversations
- `call.setHistory()` — inject previous messages
- Custom `HistoryStore` interface for your own backend

📖 Related: [Conversation History Guide](/guides/conversation-history)

---

### WhatsApp Dashboard

**`examples/whatsapp-dashboard/`** — A WhatsApp agent with a human takeover dashboard. Express backend + React frontend with SSE live updates.

**What it shows:**
- `agent.addWhatsapp()` channel registration
- `whatsapp.sessionStarted` / `whatsapp.message` / `whatsapp.response` events
- `agent.pause()` / `agent.resume()` for human takeover
- `agent.sendMessage()` — human operator sends messages
- `agent.stream(res)` — SSE event stream for React dashboard
- Conversation history via `JsonFileHistory`

```typescript
const agent = pc.agent("support", {
  llm: "openai/gpt-5-chat-latest",
  prompt: "You are a helpful customer support agent on WhatsApp.",
  history: new JsonFileHistory("./data/conversations.json"),
});

agent.addWhatsapp({
  phoneNumberId: process.env.WA_PHONE_NUMBER_ID,
  accessToken: process.env.WA_ACCESS_TOKEN,
});
```

📖 Related: [WhatsApp Guide](/guides/whatsapp) · [Human Takeover](/guides/human-takeover) · [SSE Streaming](/guides/sse-streaming)

---

## Conceptual Examples (docs only)

These examples live in the docs as full code walkthroughs — no separate `examples/` folder.

| Example | What it covers |
|---|---|
| [Browser Widget](/examples/browser-widget) | WebRTC `@pinecall/web` integration |
| [Chat Bot](/examples/chat-bot) | Text-only LLM chat (no audio) |
| [Headless Agent](/examples/headless-agent) | Server-side agent without UI |
| [Multi-Channel Bot](/examples/multi-channel-bot) | Voice + WhatsApp + chat on one agent |
| [Turn Detection](/examples/turn-detection) | Flux vs SmartTurn event comparison |

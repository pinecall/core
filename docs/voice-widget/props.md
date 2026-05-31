---
title: "Props"
description: "Every prop the VoiceWidget accepts — including channels, chat, Call Me, token security, and localization."
---

# Props

Full reference for `<VoiceWidget />`.

## All props

| Prop | Type | Default | Description |
|---|---|---|---|
| `agent` | `string` | **required** | Agent ID to connect to |
| `server` | `string` | `"https://voice.pinecall.io"` | Pinecall API base URL (override for self-hosted) |
| `name` | `string` | `"Agent"` | Display name shown in status label and ContactHub header |
| `label` | `string` | `"Talk to {name}"` | Tooltip shown on hover when idle |
| `avatar` | `string` | — | Emoji or short text displayed in the ContactHub header (e.g. `"🌸"`) |
| `preset` | `VoiceWidgetPreset` | `"dark"` | Theme preset (`dark`, `midnight`, `aurora`, `sunset`, `light`) |
| `theme` | `Partial<VoiceWidgetTheme>` | — | Custom theme overrides, merged on top of `preset` |
| `config` | `Record<string, unknown>` | — | Session config overrides (voice, STT, language) |
| `metadata` | `Record<string, unknown>` | — | Metadata passed to the agent (available as `call.metadata`) |
| `languages` | `Record<string, LanguagePreset>` | — | Multi-language presets (see below) |
| `defaultLanguage` | `string` | first key | Initial language selection |
| `onLanguageChange` | `(lang, preset) => void` | — | Called when the user picks a language |
| `channels` | `AgentChannel[]` | — | Channel list — enables the ContactHub popover (see below) |
| `chat` | `ChatConfig` | — | Chat configuration for the embedded LLM chat view |
| `callMeEndpoint` | `string` | — | URL endpoint for "Call Me" outbound calls |
| `tokenProvider` | `() => Promise<{token, server}>` | — | Custom token provider for WebRTC (keeps API keys server-side) |
| `locale` | `"en" \| "es" \| "de" \| "pt"` | `"en"` | Locale for built-in UI strings |
| `labels` | `Partial<LocaleStrings>` | — | Override individual locale strings |
| `trackedTools` | `string[]` | — | Tool names to track in widget state for UI rendering |
| `tools` | `Record<string, ToolRenderer>` | — | Map of tool names → render functions for inline tool UI |
| `onIdleClick` | `() => void` | — | Intercept idle orb click (overrides ContactHub) |
| `onStatusChange` | `(status) => void` | — | Called when connection status changes |
| `className` | `string` | — | Extra CSS class on the root wrapper |

## `channels` — multi-channel ContactHub

When you provide ≥2 channels (or 1 channel + `callMeEndpoint`, or any WhatsApp channel), clicking the idle orb opens a **ContactHub popover** instead of connecting directly.

```tsx
<VoiceWidget
  agent="florencia"
  name="Florencia"
  avatar="🌸"
  locale="es"
  channels={[
    { type: "webrtc" },
    { type: "chat" },
    { type: "whatsapp", phone: "+51987654321" },
    { type: "phone", numbers: ["+13186330963"] },
  ]}
  callMeEndpoint="/api/call-me"
/>
```

### `AgentChannel` shape

| Field | Type | Description |
|---|---|---|
| `type` | `"webrtc" \| "chat" \| "whatsapp" \| "phone"` | Channel type |
| `phone` | `string` | WhatsApp phone number (for `type: "whatsapp"`) |
| `numbers` | `string[]` | Phone numbers (for `type: "phone"`) |

### What each channel does

| Channel | ContactHub behavior |
|---|---|
| `webrtc` | "Hablar por voz" — starts a WebRTC voice call |
| `chat` | "Chat por texto" — opens embedded LLM chat (requires `chat` prop) |
| `whatsapp` | "WhatsApp" — opens `wa.me/{phone}` in new tab |
| `phone` + `callMeEndpoint` | "Que me llamen" — shows phone input, agent calls the user |

## `chat` — embedded LLM chat

Enables the built-in text chat view inside the ContactHub. Requires `{ type: "chat" }` in `channels`.

```tsx
<VoiceWidget
  agent="florencia"
  channels={[{ type: "webrtc" }, { type: "chat" }]}
  chat={{
    greeting: "¡Hola! 💅 Soy **Florencia**. ¿En qué puedo ayudarte?",
    quickOptions: [
      { label: "💇 Servicios y precios", query: "¿Qué servicios ofrecen?" },
      { label: "📅 Reservar cita", query: "Quiero reservar una cita" },
      { label: "💅 Recomendame algo", query: "Recomendame un servicio" },
    ],
    tokenProvider: async () => {
      const res = await fetch("/api/chat-token");
      return res.json();
    },
  }}
/>
```

### `ChatConfig` shape

| Field | Type | Description |
|---|---|---|
| `greeting` | `string` | Initial greeting (supports markdown). Shown before first message. |
| `quickOptions` | `ChatQuickOption[]` | Quick-reply buttons shown initially |
| `tokenProvider` | `() => Promise<{token, server}>` | Token provider for chat WebSocket (falls back to widget-level if not set) |

### `ChatQuickOption` shape

| Field | Type | Description |
|---|---|---|
| `label` | `string` | Button text (e.g. `"💇 Servicios"`) |
| `query` | `string` | Message sent when clicked |

### Chat features

- **Streaming markdown** — responses stream character-by-character via `requestAnimationFrame`
- **Typing indicator** — animated dots while the agent is thinking
- **Fullscreen on mobile** — takes over the entire viewport (≤640px)
- **No iOS zoom** — input uses ≥16px font to prevent Safari auto-zoom
- **Dark theme** — matches the widget's theme variables

## `callMeEndpoint` — outbound calls

### Why Call Me?

Not every user wants to talk through their browser. Some are on a phone without headphones, on a noisy connection, or simply prefer a real phone call. "Call Me" lets the user enter their phone number and the **agent calls them** — same AI, same tools, same prompt, but over a regular phone call via Twilio.

The widget handles the UI (phone input, dialing animation, live transcript). You provide the backend endpoint that dials and streams events.

### How it works

```
User enters phone → widget POSTs { phone } to your endpoint
                          ↓
              Your backend calls agent.dial()
                          ↓
              call.streamSSE(res) streams events as SSE
                          ↓
              Widget renders a live transcript
```

### Widget setup

When `callMeEndpoint` is set AND `channels` includes `phone`, a "Call Me" option appears in the ContactHub:

```tsx
<VoiceWidget
  agent="florencia"
  name="Florencia"
  locale="es"
  channels={[
    { type: "webrtc" },
    { type: "chat" },
    { type: "phone", numbers: ["+13186330963"] },
  ]}
  callMeEndpoint="/api/call-me"
/>
```

### Backend: `call.streamSSE(res)`

The SDK provides `call.streamSSE(res)` — it handles SSE headers, word-by-word buffering, keepalive pings, and cleanup automatically. Your endpoint is just a few lines:

```javascript
const GREETING = "Hi! You asked me to call you. How can I help?";

app.use(express.json());

app.post("/api/call-me", async (req, res) => {
  const { phone } = req.body;

  // Validate (E.164 format)
  if (!phone || !/^\+\d{10,15}$/.test(phone)) {
    return res.status(400).json({ error: "Invalid phone number" });
  }

  // Dial and stream — that's it
  try {
    const call = await florencia.dial({ to: phone, greeting: GREETING });
    call.streamSSE(res, { greeting: GREETING });
  } catch (err) {
    res.status(500).json({ error: "Could not place the call" });
  }
});
```

> `from` is auto-resolved from the agent's phone channel. Pass it explicitly only if the agent has multiple phone numbers.

`call.streamSSE(res)` does the following automatically:

1. Sets SSE headers (`Content-Type: text/event-stream`, etc.)
2. Sends `call.started` with the call ID
3. Sends the greeting as the first `bot.confirmed` message
4. Streams `bot.word` events (progressive word-by-word agent speech)
5. Sends `bot.confirmed` when agent finishes a complete message
6. Streams `user.speaking` (interim) and `user.message` (final) for user speech
7. Streams `tool.call` for tool invocations
8. Sends `call.ended` with reason and duration, then closes the stream
9. Sends `:ping` keepalives every 25s to prevent proxy timeouts
10. Cleans up listeners when the client disconnects

### `agent.dial()` — outbound call API

`agent.dial()` places an outbound phone call via Twilio. The agent must have a phone channel configured:

```typescript
// Simplest — from is auto-resolved from the agent's phone channel
const call = await agent.dial({ to: "+51987654321", greeting: "Hello!" });

// Explicit from — required only when the agent has multiple phone numbers
const call = await agent.dial({
  to: "+51987654321",
  from: "+13186330963",
  greeting: "Hello!",
});
```

| Option | Type | Required | Description |
|---|---|---|---|
| `to` | `string` | ✅ | Destination phone number (E.164) |
| `from` | `string` | Auto | Caller ID — auto-resolved if agent has one phone channel |
| `greeting` | `string` | No | TTS greeting spoken when user picks up |
| `metadata` | `object` | No | Metadata passed to the call |
| `config` | `object` | No | Session config overrides |

> **Note:** For outbound calls, the server speaks the greeting via TTS automatically. This is different from inbound calls, where you use `call.say()` in the `call.started` handler.

### SSE event protocol

The widget expects these events from `streamSSE`:

| Event | Data | Description |
|---|---|---|
| `call.started` | `{ callId }` | Call connected |
| `bot.word` | `{ text, messageId }` | Agent speaking (progressive, accumulated) |
| `bot.confirmed` | `{ text, messageId }` | Final agent message (replaces words) |
| `user.speaking` | `{ text, messageId }` | User speaking (interim transcript) |
| `user.message` | `{ text, messageId }` | Final user message |
| `tool.call` | `{ name, args }` | Tool invocation |
| `call.ended` | `{ reason, duration }` | Call finished (stream closes) |

### Production considerations

- **Rate limiting** — cap outbound calls per IP or globally (e.g. 3 per 20 min)
- **Phone validation** — normalize numbers before dialing (handle local formats)
- **Auth** — protect your endpoint (session, JWT, etc.) so anyone can't trigger calls

## `tokenProvider` — token security

Browser connections (WebRTC and chat) require **short-lived tokens**. Your backend generates them using `@pinecall/sdk`, and the widget fetches them via the `tokenProvider` callback. This keeps your API key server-side.

### Backend setup

You need two things on your backend:

1. A Pinecall client connected to the voice server
2. An HTTP endpoint that generates tokens for the frontend

```typescript
// server.js
import express from "express";
import { Pinecall, tool } from "@pinecall/sdk";
import { z } from "zod";

const app = express();
const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY });

const florencia = pc.agent("florencia", {
  voice: "elevenlabs:5vkxOzoz40FrElmLP4P7",
  language: "es",
  stt: "deepgram-flux",
  llm: { engine: "openai", model: "gpt-4.1-mini", enabled: true, prompt: "..." },
});

florencia.addChannel("webrtc");
florencia.addChannel("chat");

florencia.on("call.started", (call) => call.say("¡Hola!"));

// ── Token endpoint ──────────────────────────────────────────
// Protect this with YOUR auth (session, JWT, OAuth, etc.)
app.get("/api/token", authMiddleware, async (req, res) => {
  const channel = (req.query.channel as string) || "webrtc";
  const token = await florencia.createToken(channel);
  res.json(token);
});

await pc.connect();
app.listen(3000);
```

### Two ways to generate tokens

| Method | When to use |
|---|---|
| `agent.createToken(channel)` | You have the `Agent` instance in the same process |
| `pc.createToken(channel, agentId)` | The agent runs in a separate process; you only have the `Pinecall` client |

```typescript
// Option A: from the agent instance
const token = await florencia.createToken("webrtc");

// Option B: from the Pinecall client (agent in another process)
const token = await pc.createToken("webrtc", "florencia");
```

Both return the same shape:

```json
{ "token": "tok_...", "server": "wss://voice.pinecall.io", "expires_in": 60 }
```

### Frontend: single-channel (WebRTC only)

```tsx
<VoiceWidget
  agent="florencia"
  tokenProvider={async () => {
    const res = await fetch("/api/token?channel=webrtc", {
      credentials: "include", // send your session cookie
    });
    if (!res.ok) throw new Error(`Token failed: ${res.status}`);
    return res.json();
  }}
/>
```

### Frontend: multi-channel (WebRTC + chat)

When using `channels` with both `webrtc` and `chat`, the widget needs tokens for each channel. Use `tokenProvider` for WebRTC and `chat.tokenProvider` for chat:

```tsx
<VoiceWidget
  agent="florencia"
  channels={[{ type: "webrtc" }, { type: "chat" }]}
  tokenProvider={async () => {
    const res = await fetch("/api/token?channel=webrtc", { credentials: "include" });
    return res.json();
  }}
  chat={{
    greeting: "¡Hola! ¿En qué puedo ayudarte?",
    tokenProvider: async () => {
      const res = await fetch("/api/token?channel=chat", { credentials: "include" });
      return res.json();
    },
  }}
/>
```

> If you omit `chat.tokenProvider`, the widget falls back to the top-level `tokenProvider` — which works if your backend endpoint accepts `?channel=chat`.

### Alternative: `allowedOrigins` (demos only)

For demos without a backend, skip the token endpoint. The agent auto-generates tokens for matching browser origins:

```typescript
// Backend
const agent = pc.agent("demo", {
  allowedOrigins: ["https://mysite.com", "http://localhost:*"],
});
```

```tsx
// Frontend — no tokenProvider needed
<VoiceWidget agent="demo" />
```

> **⚠️ Warning:** `allowedOrigins` is origin-header based. Real browsers can't spoof it, but scripts/curl can. For production with real users, always use `tokenProvider`.

### Token properties

| Property | Value | Effect |
|---|---|---|
| Single-use | Consumed on first connection | Can't be reused |
| Short-lived | 60 second TTL | Expires quickly |
| Scoped | Locked to agent + org | Can't be used elsewhere |

> **Never** store API keys in frontend code. See [Security](/security) for the full token model.

## `locale` and `labels` — localization

Built-in strings are available in `en`, `es`, `de`, and `pt`.

```tsx
<VoiceWidget
  agent="florencia"
  locale="es"
  labels={{
    "callMe.formNote": '<a href="tel:+13186330963">+1 (318) 633-0963</a>',
  }}
/>
```

### All locale string keys

| Key | Default (en) |
|---|---|
| `hub.title` | `"Contact {name}"` |
| `hub.subtitle` | `"Choose how you'd like to connect"` |
| `hub.voice` | `"Voice call"` |
| `hub.voiceDesc` | `"Talk in real time"` |
| `hub.chat` | `"Text chat"` |
| `hub.chatDesc` | `"Chat with {name}"` |
| `hub.whatsapp` | `"WhatsApp"` |
| `hub.whatsappDesc` | `"Message on WhatsApp"` |
| `hub.callMe` | `"Call me"` |
| `hub.callMeDesc` | `"We'll call your phone"` |
| `callMe.title` | `"We'll call you"` |
| `callMe.placeholder` | `"Your phone number"` |
| `callMe.submit` | `"Call me now"` |
| `callMe.formNote` | — |
| `callMe.calling` | `"Calling..."` |
| `callMe.ended` | `"Call ended"` |
| `callMe.error` | `"Error"` |
| `callMe.back` | `"Back"` |

## `config` — session overrides

Pass session-level overrides to the agent:

```tsx
<VoiceWidget
  agent="mara"
  config={{
    voice: "elevenlabs:EXAVITQu4vr4xnSDxMaL",
    stt: { provider: "deepgram-flux" },
    language: "es",
  }}
/>
```

## `metadata` — server-side context

Whatever you pass shows up as `call.metadata` in your agent:

```tsx
<VoiceWidget
  agent="mara"
  metadata={{
    userId: currentUser.id,
    plan: currentUser.plan,
  }}
/>
```

On the server:

```typescript
agent.on("call.started", (call) => {
  console.log("Call from user", call.metadata.userId);
});
```

## `languages` — multi-language selector

Enables a language pill bar that appears on hover and stays visible during calls.

```tsx
<VoiceWidget
  agent="mara"
  languages={{
    en: {
      label: "English",
      flag: "🇬🇧",
      voice: "elevenlabs:EXAVITQu4vr4xnSDxMaL",
      stt: "deepgram-flux",
      language: "en",
    },
    es: {
      label: "Español",
      flag: "🇪🇸",
      voice: "elevenlabs:h2cd3gvcqTp3m65Dysk7",
      stt: "deepgram-flux",
      language: "es",
    },
  }}
  defaultLanguage="en"
/>
```

### `LanguagePreset` shape

| Field | Type | Description |
|---|---|---|
| `label` | `string` | Display name (e.g. `"Español"`) |
| `flag` | `string` | Flag emoji (e.g. `"🇪🇸"`) |
| `voice` | `string` | Voice ID in `provider:id` format |
| `stt` | `string \| object` | STT shortcut (`"deepgram-flux"`) or full config |
| `language` | `string` | Language code for STT (`"es"`, `"en"`, etc.) |

### Behavior

- **Pre-call**: Pill bar appears on hover. Selecting a language updates the session config.
- **Mid-call**: Pills stay visible. Selecting a language sends a `configure` message via DataChannel — voice, STT, and language hot-swap without disconnecting.

## `tools` — inline tool renderers

Map tool names to React render functions. When a server-side tool completes, the result renders inline:

```tsx
<VoiceWidget
  agent="booking-demo"
  tools={{
    getAvailableSlots: (result, { respond, dismiss }) => (
      <div className="slots">
        {result.slots.map((slot: string) => (
          <button key={slot} onClick={() => { respond(`I'd like ${slot}`); dismiss(); }}>
            {slot}
          </button>
        ))}
      </div>
    ),
  }}
/>
```

See [Tools API](/voice-widget/tools-api) for the full pattern.

## `onStatusChange` — observability

```tsx
<VoiceWidget
  agent="mara"
  onStatusChange={(status) => {
    if (status === "connected") analytics.track("call_started");
    if (status === "idle") analytics.track("call_ended");
  }}
/>
```

## What's next

- [Theming](/voice-widget/theming) — all CSS variables and preset values
- [Tools API](/voice-widget/tools-api) — interactive UI from tool calls
- [`useVoiceSession` hook](/voice-widget/use-voice-session-hook) — bypass the orb, build custom UI

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

When set AND the agent has `phone` channels, a "Call Me" option appears in the ContactHub.

```tsx
<VoiceWidget
  agent="florencia"
  channels={[
    { type: "webrtc" },
    { type: "phone", numbers: ["+13186330963"] },
  ]}
  callMeEndpoint="/api/call-me"
/>
```

Your endpoint receives a POST with `{ phone }` and should return an SSE stream:

```javascript
// Server-side (e.g. Express route)
app.post("/api/call-me", async (req, res) => {
  const { phone } = req.body;

  // Trigger outbound call
  const call = await agent.dial({ to: phone, from: "+13186330963" });

  // Stream transcript to the browser as SSE
  res.setHeader("Content-Type", "text/event-stream");
  call.on("transcript", (text) => {
    res.write(`event: transcript\ndata: ${JSON.stringify({ text })}\n\n`);
  });
  call.on("call.ended", () => {
    res.write(`event: end\ndata: {}\n\n`);
    res.end();
  });
});
```

The widget shows a live transcript of the call as it happens.

## `tokenProvider` — token security

Keeps your API key server-side. The widget calls your backend to get a short-lived token instead of hitting the Pinecall API directly.

```tsx
<VoiceWidget
  agent="florencia"
  tokenProvider={async () => {
    const res = await fetch("/api/token", { credentials: "include" });
    if (!res.ok) throw new Error(`Token failed: ${res.status}`);
    return res.json();
  }}
/>
```

Your backend generates the token:

```typescript
app.get("/api/token", authMiddleware, async (req, res) => {
  const token = await agent.createToken("webrtc");
  res.json(token);
});
```

> **Never** store API keys in frontend code. Use `tokenProvider` for production.

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

---
title: "@pinecall/voice-widget"
description: "Drop-in React voice widget with animated orb UI, multi-channel ContactHub, embedded chat, themes, and multi-language support."
---

# @pinecall/voice-widget

A complete React voice widget for Pinecall agents. Animated orb, live transcript, multi-channel ContactHub (voice, chat, WhatsApp, Call Me), theme presets, and an interactive tools API for rendering UI in response to LLM tool calls.

```bash
npm install @pinecall/voice-widget react react-dom
```

> Built on top of [`@pinecall/voice-core`](/voice-core/overview). React ≥18 is a peer dependency.

## Quick start

```tsx
import { VoiceWidget } from "@pinecall/voice-widget";

export default function App() {
  return <VoiceWidget agent="mara" name="Mara" />;
}
```

That's it. The widget renders a floating orb in the bottom-right corner. Click to start a voice call, click again to end it. The orb animates through phases (idle → connecting → listening → speaking → thinking) and shows a live transcript bubble above.

## Multi-channel ContactHub

When you configure multiple channels, the orb opens a **ContactHub popover** instead of connecting directly. Users choose how to reach you:

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
  chat={{
    greeting: "¡Hola! Soy Florencia. ¿En qué puedo ayudarte?",
    quickOptions: [
      { label: "💇 Servicios", query: "¿Qué servicios ofrecen?" },
      { label: "📅 Reservar", query: "Quiero reservar una cita" },
    ],
    tokenProvider: async () => {
      const res = await fetch("/api/chat-token");
      return res.json();
    },
  }}
  tokenProvider={async () => {
    const res = await fetch("/api/token");
    return res.json();
  }}
/>
```

### Channel types

| Channel | What happens on click |
|---|---|
| `webrtc` | Starts a real-time voice call via WebRTC |
| `chat` | Opens embedded LLM text chat with streaming responses |
| `whatsapp` | Opens `wa.me` link to the agent's WhatsApp number |
| `phone` + `callMeEndpoint` | Shows a "Call Me" form — agent calls the user's phone |

### Embedded chat

The built-in chat view provides:

- **WebSocket connection** to the Pinecall chat server
- **Streaming markdown** rendered with `marked` + `requestAnimationFrame`
- **Quick-reply buttons** for guided conversations
- **Typing indicators** while the agent thinks
- **Fullscreen on mobile** — 100% viewport height, no background scroll

### Call Me flow

When `callMeEndpoint` is set and phone channels exist, users can enter their phone number and receive a call from the agent. Your backend dials with `agent.dial()` and streams the call to the browser with `call.streamSSE(res)`:

```javascript
app.post("/api/call-me", async (req, res) => {
  const call = await agent.dial({ to: req.body.phone, from: "+1...", greeting: "Hi!" });
  call.streamSSE(res, { greeting: "Hi!" });
});
```

The widget renders a live transcript of the phone call — agent speech word-by-word, user transcription, and call end state.

## What you get out of the box

- **Animated orb** with breathing rings, pulse states, and per-phase colors
- **ContactHub popover** with voice, chat, WhatsApp, and Call Me channels
- **Embedded LLM chat** with markdown streaming and quick-reply buttons
- **Live transcript** rendered as chat bubbles next to the orb
- **5 theme presets** (`dark`, `midnight`, `aurora`, `sunset`, `light`) — plus full CSS variable overrides
- **Multi-language pill selector** with hot-swap mid-call
- **Token security** via `tokenProvider` — API keys never leave your server
- **Localization** — built-in strings for `en`, `es`, `de`, `pt`
- **Mobile optimized** — fullscreen chat, no iOS zoom on input focus
- **Idle warning state** when the user goes silent too long
- **Interactive Tools API** for rendering UI in response to LLM tool calls
- **`useVoiceSession()` hook** for building completely custom UIs

## When to use what

| You want to... | Use |
|---|---|
| Drop a voice button on your site | `<VoiceWidget />` |
| Voice + chat + WhatsApp in one widget | `<VoiceWidget channels={[...]} />` |
| Build a fully custom UI in React | `useVoiceSession()` hook |
| Build a fully custom UI in Vue/Svelte/vanilla | [`@pinecall/voice-core`](/voice-core/overview) directly |
| Render interactive UI from agent tool calls | `<VoiceWidget>` + `tools` prop or `useVoice()` + `trackedTools` |

## What's next

- [Props reference](/voice-widget/props) — every prop with type and default
- [Theming](/voice-widget/theming) — presets, CSS variables, custom themes
- [`useVoiceSession` hook](/voice-widget/use-voice-session-hook) — for custom UIs
- [Tools API](/voice-widget/tools-api) — render interactive components from tool calls

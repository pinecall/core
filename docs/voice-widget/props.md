---
title: "Props"
description: "Every prop the VoiceWidget accepts — including token security, tools, theming, and multi-language."
---

# Props

Full reference for `<VoiceWidget />`.

## All props

| Prop | Type | Default | Description |
|---|---|---|---|
| `agent` | `string` | **required** | Agent ID to connect to |
| `server` | `string` | `"https://voice.pinecall.io"` | Pinecall API base URL (override for self-hosted) |
| `name` | `string` | `"Agent"` | Display name shown in status label |
| `label` | `string` | `"Talk to {name}"` | Tooltip shown on hover when idle |
| `preset` | `VoiceWidgetPreset` | `"dark"` | Theme preset (`dark`, `midnight`, `aurora`, `sunset`, `light`) |
| `theme` | `Partial<VoiceWidgetTheme>` | — | Custom theme overrides, merged on top of `preset` |
| `config` | `Record<string, unknown>` | — | Session config overrides (voice, STT, language) |
| `metadata` | `Record<string, unknown>` | — | Metadata passed to the agent (available as `call.metadata`) |
| `languages` | `Record<string, LanguagePreset>` | — | Multi-language presets (see below) |
| `defaultLanguage` | `string` | first key | Initial language selection |
| `onLanguageChange` | `(lang, preset) => void` | — | Called when the user picks a language |
| `tokenProvider` | `() => Promise<{token, server}>` | — | Custom token provider for WebRTC (keeps API keys server-side) |
| `trackedTools` | `string[]` | — | Tool names to track in widget state for UI rendering |
| `tools` | `Record<string, ToolRenderer>` | — | Map of tool names → render functions for inline tool UI |
| `onStatusChange` | `(status) => void` | — | Called when connection status changes |
| `className` | `string` | — | Extra CSS class on the root wrapper |

## `tokenProvider` — token security

Browser connections require **short-lived tokens**. Your backend generates them using `@pinecall/sdk`, and the widget fetches them via the `tokenProvider` callback. This keeps your API key server-side.

### Backend setup

```typescript
// server.js
import express from "express";
import { Pinecall } from "@pinecall/sdk";

const app = express();
const pc = new Pinecall();

const florencia = pc.agent("florencia", {
  voice: "elevenlabs/sarah",
  language: "es",
  stt: "deepgram/flux-en",
  llm: "openai/gpt-5-chat-latest",
  prompt: "...",
  greeting: "¡Hola!",
});

// Token endpoint — add your own auth in production
app.get("/api/token", authMiddleware, async (req, res) => {
  const token = await florencia.createToken("webrtc");
  res.json(token);
});

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

### Frontend

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

### `allowedOrigins` + `tokenProvider` — recommended combo

Use **both** for the best experience:

- `allowedOrigins` lets the widget auto-fetch tokens during **local development** (where your backend might not be running)
- `tokenProvider` provides **production security** — tokens go through your backend with your auth

```typescript
// Backend — agent config
const florencia = pc.agent("florencia", {
  // Dev fallback — widget can auto-fetch tokens from matching origins
  allowedOrigins: ["https://mysite.com", "http://localhost:*"],
  // ...
});
```

```tsx
// Frontend — tokenProvider for production
<VoiceWidget
  agent="florencia"
  tokenProvider={async () => {
    const res = await fetch("/api/token");
    if (!res.ok) throw new Error(`Token failed: ${res.status}`);
    return res.json();
  }}
/>
```

When `tokenProvider` is set, the widget uses it. When it's not set (or fails), `voice-core` falls back to fetching directly from the server using `allowedOrigins`.

> **Security note:** `allowedOrigins` alone is origin-header based — real browsers can't spoof it, but scripts/curl can. Always pair it with `tokenProvider` in production.

### How the token is used

The token is consumed **once** during the WebRTC handshake. Here's the full flow:

```
1. Widget calls tokenProvider()
   → returns { token: "tok_...", server: "wss://voice.pinecall.io" }

2. Widget fetches ICE config
   → GET {server}/webrtc/ice-servers → STUN/TURN servers

3. Browser requests mic access
   → navigator.mediaDevices.getUserMedia()

4. Widget creates a WebRTC offer
   → new RTCPeerConnection → addTrack(mic) → createOffer()

5. Widget sends the offer + token to the server
   → POST {server}/webrtc/offer
     { sdp: "...", type: "offer", token: "tok_...", config, metadata }
                                   ▲
                                   └── token goes here, consumed on use

6. Server validates the token, creates a session, returns the SDP answer
   → { sdp: "...", type: "answer" }

7. WebRTC connection established — audio flows peer-to-peer
   → token is discarded, all communication is via PeerConnection
```

After step 5, the token is gone. It can't be reused, replayed, or shared. The WebRTC connection is secured by the PeerConnection itself.

### Token properties

| Property | Value | Effect |
|---|---|---|
| Single-use | Consumed on first connection | Can't be reused |
| Short-lived | 60 second TTL | Expires quickly |
| Scoped | Locked to agent + org | Can't be used elsewhere |

> **Never** store API keys in frontend code. See [Security](/security) for the full token model.

## `config` — session overrides

Pass session-level overrides to the agent:

```tsx
<VoiceWidget
  agent="mara"
  config={{
    voice: "elevenlabs/sarah",
    stt: "deepgram/flux-en",
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
      voice: "elevenlabs/sarah",
      stt: "deepgram/flux-en",
      language: "en",
    },
    es: {
      label: "Español",
      flag: "🇪🇸",
      voice: "elevenlabs/george",
      stt: "deepgram/flux-en",
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
| `stt` | `string \| object` | STT shortcut (`"deepgram/flux-en"`) or full config |
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

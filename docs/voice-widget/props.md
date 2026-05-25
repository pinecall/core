---
title: "Props"
description: "Every prop the VoiceWidget accepts — including multi-language and metadata."
---

# Props

Full reference for `<VoiceWidget />`.

## All props

| Prop | Type | Default | Description |
|---|---|---|---|
| `agent` | `string` | **required** | Agent ID to connect to |
| `server` | `string` | `"https://voice.pinecall.io"` | Pinecall API base URL (override for self-hosted) |
| `name` | `string` | `"Agent"` | Display name shown in status label during calls |
| `label` | `string` | `"Talk to {name}"` | Tooltip shown on hover when idle |
| `preset` | `VoiceWidgetPreset` | `"dark"` | Theme preset (`dark`, `midnight`, `aurora`, `sunset`, `light`) |
| `theme` | `Partial<VoiceWidgetTheme>` | — | Custom theme overrides, merged on top of `preset` |
| `config` | `Record<string, unknown>` | — | Session config overrides (voice, STT, language, greeting) |
| `metadata` | `Record<string, unknown>` | — | Metadata passed to the agent (available as `call.metadata`) |
| `languages` | `Record<string, LanguagePreset>` | — | Multi-language presets (see below) |
| `defaultLanguage` | `string` | first key | Initial language selection |
| `onLanguageChange` | `(lang, preset) => void` | — | Called when the user picks a language |
| `trackedTools` | `string[]` | — | Tool names to track in widget state for UI rendering (see [Tools API](/voice-widget/tools-api)) |
| `className` | `string` | — | Extra CSS class on the root wrapper |
| `onStatusChange` | `(status) => void` | — | Called when connection status changes |

## `config` — session overrides

Pass session-level overrides to the agent. Same shortcut syntax as `@pinecall/sdk`:

```tsx
<VoiceWidget
  agent="mara"
  config={{
    voice: "elevenlabs:EXAVITQu4vr4xnSDxMaL",
    stt: { provider: "deepgram", model: "nova-3", language: "es" },
    language: "es",
    greeting: "¡Hola! ¿En qué puedo ayudarte?",
  }}
/>
```

See [STT Providers](/reference/stt-providers) and [TTS Providers](/reference/tts-providers) for the full shortcut formats.

## `metadata` — server-side context

Whatever you pass shows up as `call.metadata` in your agent. Use it to attach user IDs, session IDs, A/B test variants, anything you want the server to know about this specific call.

```tsx
<VoiceWidget
  agent="mara"
  metadata={{
    userId: currentUser.id,
    plan: currentUser.plan,
    experimentVariant: "B",
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

Enables a language pill bar that appears on hover and stays visible during calls. Each language preset configures the voice, STT, turn detection, and greeting for that language.

```tsx
import { VoiceWidget } from "@pinecall/voice-widget";
import type { LanguagePreset } from "@pinecall/voice-widget";

const LANGUAGES: Record<string, LanguagePreset> = {
  en: {
    label: "English",
    flag: "🇬🇧",
    voice: "elevenlabs:EXAVITQu4vr4xnSDxMaL",
    stt: "deepgram-flux",
    language: "en",
    greeting: "Hello! How can I help you?",
  },
  es: {
    label: "Español",
    flag: "🇪🇸",
    voice: "elevenlabs:h2cd3gvcqTp3m65Dysk7",
    stt: { provider: "deepgram", model: "nova-3", language: "es" },
    language: "es",
    greeting: "¡Hola! ¿En qué puedo ayudarte?",
  },
  ar: {
    label: "العربية",
    flag: "🇸🇦",
    voice: "elevenlabs:jAAHNNqlbAX9iWjJPEtE",
    stt: { provider: "deepgram", model: "nova-3", language: "ar" },
    language: "ar",
    turnDetection: "smart_turn",
    greeting: "مرحباً، كيف يمكنني مساعدتك؟",
  },
};

<VoiceWidget
  agent="mara"
  name="Mara"
  languages={LANGUAGES}
  defaultLanguage="en"
  onLanguageChange={(lang, preset) => console.log(`Switched to ${lang}`)}
/>;
```

### `LanguagePreset` shape

| Field | Type | Description |
|---|---|---|
| `label` | `string` | Display name (e.g. `"Español"`) |
| `flag` | `string` | Flag emoji (e.g. `"🇪🇸"`) |
| `voice` | `string` | Voice ID in `provider:id` format |
| `stt` | `string \| object` | STT shortcut (`"deepgram-flux"`) or full config |
| `language` | `string` | Language code for STT (`"es"`, `"ar"`, etc.) |
| `turnDetection` | `string \| object` | Turn detection mode (`"smart_turn"`, `"native"`) or full config |
| `greeting` | `string` | Custom greeting spoken when the call starts |

### Behavior

- **Pre-call**: Pill bar appears on hover. Selecting a language updates the session config for the next `connect()`.
- **Mid-call**: Pills stay visible. Selecting a language sends a `configure` message via DataChannel — voice, STT, and turn detection hot-swap without disconnecting.
- **Greeting**: Only applies at call start (sent in the offer body). Mid-call language changes don't re-trigger the greeting.

## `onStatusChange` — observability

```tsx
<VoiceWidget
  agent="mara"
  onStatusChange={(status) => {
    if (status === "connected") analytics.track("call_started");
    if (status === "idle") analytics.track("call_ended");
    if (status === "error") analytics.track("call_error");
  }}
/>
```

## `trackedTools` — interactive tool UI

Tells the widget which tool calls to expose in widget state for UI rendering. Untracked tools are handled silently by the server-side agent.

```tsx
<VoiceWidget
  agent="booking-demo"
  trackedTools={["getAvailableSlots", "showContactForm"]}
>
  <ToolPanel />
</VoiceWidget>
```

See [Tools API](/voice-widget/tools-api) for the full pattern.

## What's next

- [Theming](/voice-widget/theming) — all CSS variables and preset values
- [Tools API](/voice-widget/tools-api) — interactive UI from tool calls
- [`useVoiceSession` hook](/voice-widget/use-voice-session-hook) — bypass the orb, build custom UI

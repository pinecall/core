---
title: "@pinecall/voice-widget"
description: "Drop-in React voice widget with animated orb UI, live transcript, themes, and multi-language support."
---

# @pinecall/voice-widget

A React voice widget for Pinecall agents. Animated orb, live transcript, theme presets, multi-language selector, and an interactive tools API for rendering UI in response to LLM tool calls.

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

## What you get out of the box

- **Animated orb** with breathing rings, pulse states, and per-phase colors
- **Live transcript** rendered as chat bubbles next to the orb
- **5 theme presets** (`dark`, `midnight`, `aurora`, `sunset`, `light`) — plus full CSS variable overrides
- **Multi-language pill selector** with hot-swap mid-call
- **Token security** via `tokenProvider` — API keys never leave your server
- **Idle warning state** when the user goes silent too long
- **Interactive Tools API** for rendering UI in response to LLM tool calls
- **`useVoiceSession()` hook** for building completely custom UIs

## Standalone components

The package also exports standalone components for building custom multi-channel experiences:

| Export | Purpose |
|---|---|
| `ContactHub` | Multi-channel contact menu (voice, chat, WhatsApp, Call Me) |
| `ChatView` | Embedded LLM text chat with streaming markdown |
| `useVoiceSession()` | Headless hook — build your own UI from scratch |
| `useAgentInfo()` | Fetch agent channel info for auto-discovery |

These are **not** wired into `<VoiceWidget>` — you compose them yourself in your app's UI.

## When to use what

| You want to... | Use |
|---|---|
| Drop a voice button on your site | `<VoiceWidget />` |
| Build a fully custom UI in React | `useVoiceSession()` hook |
| Build a fully custom UI in Vue/Svelte/vanilla | [`@pinecall/voice-core`](/voice-core/overview) directly |
| Render interactive UI from agent tool calls | `<VoiceWidget>` + `tools` prop or `useVoice()` + `trackedTools` |
| Add multi-channel contact menu | Import `ContactHub` and compose it in your layout |

## What's next

- [Props reference](/voice-widget/props) — every prop with type and default
- [Theming](/voice-widget/theming) — presets, CSS variables, custom themes
- [`useVoiceSession` hook](/voice-widget/use-voice-session-hook) — for custom UIs
- [Tools API](/voice-widget/tools-api) — render interactive components from tool calls

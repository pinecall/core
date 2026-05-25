---
title: "@pinecall/voice-widget"
description: "Drop-in React voice widget with animated orb UI, themes, and multi-language support."
---

# @pinecall/voice-widget

A complete React voice widget for Pinecall agents. Animated orb, live transcript, multi-language pills, theme presets, and an interactive tools API for rendering UI in response to LLM tool calls.

```bash
npm install @pinecall/voice-widget react react-dom
```

> Built on top of [`@pinecall/voice-core`](/docs/voice-core/overview). React ≥18 is a peer dependency.

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
- **Multi-language pill selector** with hot-swap mid-call (voice, STT, language change without reconnecting)
- **Idle warning state** when the user goes silent too long
- **Interactive Tools API** for rendering UI in response to LLM tool calls (forms, pickers, confirmations)
- **`useVoiceSession()` hook** for building completely custom UIs without giving up the session management

## When to use what

| You want to... | Use |
|---|---|
| Drop a voice button on your site | `<VoiceWidget />` |
| Build a fully custom UI in React | `useVoiceSession()` hook |
| Build a fully custom UI in Vue/Svelte/vanilla | [`@pinecall/voice-core`](/docs/voice-core/overview) directly |
| Render interactive UI from agent tool calls | `<VoiceWidget>` + `useVoice()` context + `trackedTools` |

## What's next

- [Props reference](/docs/voice-widget/props) — every prop with type and default
- [Theming](/docs/voice-widget/theming) — presets, CSS variables, custom themes
- [`useVoiceSession` hook](/docs/voice-widget/use-voice-session-hook) — for custom UIs
- [Tools API](/docs/voice-widget/tools-api) — render interactive components from tool calls

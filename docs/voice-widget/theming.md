---
title: "Theming"
description: "Theme presets, CSS variables, and full customization of the orb and transcript UI."
---

# Theming

Every visual aspect of the widget is controlled by CSS custom properties. You can pick a built-in preset, override individual values, or skip the props entirely and override variables with CSS.

## Five built-in presets

| Preset | Orb | Rings | Panels | Best for |
|---|---|---|---|---|
| `"dark"` | Pearl white | Warm red | Dark purple glass | Dark-themed sites (default) |
| `"midnight"` | Deep sapphire | Ice blue | Navy glass | Corporate / professional |
| `"aurora"` | Emerald / teal | Green | Forest dark | Nature / wellness brands |
| `"sunset"` | Warm coral | Golden amber | Warm dark | Hospitality / warm brands |
| `"light"` | Clean white | Soft blue | White glass | Light-themed sites |

```tsx
<VoiceWidget preset="midnight" agent="mara" />
<VoiceWidget preset="aurora" agent="mara" />
<VoiceWidget preset="sunset" agent="mara" />
<VoiceWidget preset="light" agent="mara" />
<VoiceWidget preset="dark" agent="mara" />     // default
```

Access preset values programmatically:

```tsx
import { PRESETS } from "@pinecall/voice-widget";
console.log(PRESETS.midnight); // full theme object
```

## Custom themes via the `theme` prop

Pass overrides — they merge on top of the chosen `preset`:

```tsx
<VoiceWidget
  agent="mara"
  preset="midnight"
  theme={{
    orbFrom: "200, 150, 255",
    orbMid: "140, 80, 220",
    orbTo: "80, 30, 160",
    colorAccent: "124, 58, 237",
    ringColor: "216, 65, 44",
    panelBg: "rgba(16, 14, 20, .92)",
    bubbleUserColor: "#e0d4f7",
  }}
/>
```

## All theme variables

| Field | CSS variable | Type | Default (dark) | Controls |
|---|---|---|---|---|
| `orbFrom` | `--vw-orb-from` | RGB triplet | `255, 255, 255` | Idle orb gradient center |
| `orbMid` | `--vw-orb-mid` | RGB triplet | `240, 238, 231` | Idle orb gradient midtone |
| `orbTo` | `--vw-orb-to` | RGB triplet | `184, 181, 168` | Idle orb gradient edge |
| `colorConnecting` | `--vw-color-connecting` | RGB triplet | `245, 158, 11` | Connecting state orb |
| `colorActive` | `--vw-color-active` | RGB triplet | `76, 175, 80` | Connected / listening orb |
| `colorUserSpeaking` | `--vw-color-user-speaking` | RGB triplet | `52, 211, 153` | User speaking orb |
| `colorSpeaking` | `--vw-color-speaking` | RGB triplet | `248, 113, 113` | Agent speaking orb |
| `colorThinking` | `--vw-color-thinking` | RGB triplet | `139, 92, 246` | Thinking / processing orb |
| `colorWarning` | `--vw-color-warning` | RGB triplet | `255, 160, 0` | Idle warning blink |
| `colorAccent` | `--vw-color-accent` | RGB triplet | `124, 58, 237` | User bubble accent |
| `ringColor` | `--vw-ring-color` | RGB triplet | `216, 65, 44` | Idle ring glow |
| `panelBg` | `--vw-panel-bg` | CSS color | `rgba(16,14,20,.92)` | Transcript panel bg |
| `panelBorder` | `--vw-panel-border` | CSS color | `rgba(255,255,255,.08)` | Transcript panel border |
| `bubbleBotBg` | `--vw-bubble-bot-bg` | CSS color | `rgba(18,16,22,.9)` | Bot bubble background |
| `bubbleBotColor` | `--vw-bubble-bot-color` | CSS color | `#e8e4f0` | Bot bubble text |
| `bubbleUserColor` | `--vw-bubble-user-color` | CSS color | `#e0d4f7` | User bubble text |
| `labelBg` | `--vw-label-bg` | CSS color | `#181818` | Label tooltip background |
| `labelColor` | `--vw-label-color` | CSS color | `#fff` | Label tooltip text |

> **RGB triplet vs CSS color.** Variables that need alpha variants are stored as `"R, G, B"` strings (the widget uses `rgba(var(--vw-color-x), 0.3)` etc.). Plain CSS color values are used for backgrounds and text where alpha is baked into the value.

## CSS-only override (no JS)

Skip the `theme` prop entirely — override the CSS variables directly:

```css
.vw-wrap {
  --vw-orb-from: 200, 150, 255;
  --vw-ring-color: 100, 80, 200;
  --vw-panel-bg: rgba(20, 10, 40, .95);
}
```

This is handy when you want the theme to follow a parent context (e.g. dark/light mode toggle in your app's own CSS).

## Orb visual states

The orb gets a different look per phase:

| State | Visual | CSS class | When |
|---|---|---|---|
| Idle | Pearl gradient, breathing rings | (default) | Not connected |
| Connecting | Amber pulse | `.connecting` | Establishing WebRTC |
| Active | Soft green glow | `.active` | Connected, listening |
| User speaking | Emerald glow | `.user-speaking` | User is talking |
| Agent speaking | Rose pulse | `.speaking` | Bot TTS playing |
| Thinking | Violet pulse | `.thinking` | Waiting for LLM response |
| **Idle warning** | **Orange blink** | `.idle-warning` | User silent — call will timeout soon |

The idle warning state is driven by the server's `session.idleWarning` event and clears when the user speaks or the call ends.

## Building on top of presets

Start from a preset and modify selectively:

```tsx
import { PRESETS } from "@pinecall/voice-widget";
import type { VoiceWidgetTheme } from "@pinecall/voice-widget";

const brandTheme: Partial<VoiceWidgetTheme> = {
  ...PRESETS.midnight,
  colorAccent: "255, 87, 34",      // brand orange
  ringColor: "255, 87, 34",
  bubbleUserColor: "#ffccbc",
};

<VoiceWidget agent="mara" preset="midnight" theme={brandTheme} />;
```

## What's next

- [Props reference](/voice-widget/props) — everything else the widget accepts
- [`useVoiceSession` hook](/voice-widget/use-voice-session-hook) — for fully custom UIs that bypass the orb entirely

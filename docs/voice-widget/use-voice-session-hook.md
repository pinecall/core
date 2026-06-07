---
title: "useVoiceSession hook"
description: "Build a fully custom voice UI without giving up the widget's session management."
---

# `useVoiceSession` hook

If the orb UI doesn't fit your design, use the `useVoiceSession()` hook directly. It gives you the same reactive state and actions, with no orb, no transcript bubbles, no styling — you bring the UI.

## When to use this vs `<VoiceWidget />`

| Use `<VoiceWidget />` | Use `useVoiceSession()` |
|---|---|
| You want a floating orb in the corner | You want voice as part of your app's existing UI |
| You need theming via presets | You're styling everything yourself anyway |
| You want the Tools API context (`useVoice()`) | You're building a transcript-first interface |

The hook wraps `VoiceSession` from `@pinecall/voice-core` with `useSyncExternalStore` for efficient React rendering. The session is created once on mount and destroyed on unmount.

## Quick start

```tsx
import { useVoiceSession } from "@pinecall/voice-widget";

function CustomVoice() {
  const {
    status, error, isMuted, phase,
    userSpeaking, agentSpeaking, duration,
    messages, idleWarning,
    connect, disconnect, toggleMute, setMuted,
  } = useVoiceSession({ agent: "mara" });

  return (
    <div>
      <p>Status: {status} · Phase: {phase} · {duration}s</p>

      {status === "idle" && <button onClick={connect}>Start call</button>}
      {status === "connected" && (
        <>
          <button onClick={disconnect}>End call</button>
          <button onClick={toggleMute}>{isMuted ? "Unmute" : "Mute"}</button>
        </>
      )}

      <div>
        {messages.map((m) => (
          <div key={m.id} className={m.role}>
            <strong>{m.role}:</strong> {m.text}
            {m.isInterim && " (typing...)"}
            {m.speaking && " 🔊"}
            {m.interrupted && " ⚡ interrupted"}
          </div>
        ))}
      </div>
    </div>
  );
}
```

## Return shape

The hook returns the full session state **plus** action methods:

| Field | Type | What it is |
|---|---|---|
| `status` | `SessionStatus` | `"idle" \| "connecting" \| "connected" \| "error"` |
| `error` | `string \| null` | Error message when `status === "error"` |
| `isMuted` | `boolean` | Mic state |
| `phase` | `CallPhase` | `"idle" \| "listening" \| "speaking" \| "pause" \| "thinking"` |
| `userSpeaking` | `boolean` | User is physically talking (VAD-level) |
| `agentSpeaking` | `boolean` | TTS is currently playing |
| `duration` | `number` | Seconds since connected, updates every second |
| `messages` | `TranscriptMessage[]` | Full transcript — see [State and Phases](/voice-core/state-and-phases) |
| `idleWarning` | `number \| null` | Seconds until idle timeout (null = no warning) |
| `connect` | `() => Promise<void>` | Start the call |
| `disconnect` | `() => void` | End the call |
| `toggleMute` | `() => void` | Toggle mic |
| `setMuted` | `(muted: boolean) => void` | Explicit mute control |

## Accessing raw events

For tool calls or other low-level events the state machine doesn't expose, drop down to `@pinecall/voice-core` directly and listen to the `event` listener:

```tsx
import { useState, useEffect } from "react";
import { VoiceSession } from "@pinecall/voice-core";

function AdvancedVoice() {
  const [session] = useState(() => new VoiceSession({ agent: "mara" }));

  useEffect(() => {
    const onEvent = (e: CustomEvent) => {
      const { event, tool_calls } = e.detail;

      if (event === "llm.toolCall" && tool_calls) {
        for (const tc of tool_calls) {
          console.log(`Tool call: ${tc.name}`, tc.arguments);
        }
      }
    };

    session.addEventListener("event", onEvent);
    return () => {
      session.removeEventListener("event", onEvent);
      session.destroy();
    };
  }, [session]);

  // ... render UI using session.getState()
}
```

If you specifically want to render interactive UI for tool calls, stick with `<VoiceWidget>` and use the [Tools API](/voice-widget/tools-api) — it handles the correlation between calls and results for you.

## `useVoice()` vs `useVoiceSession()`

There are two hooks in this package and the names are easy to confuse:

| Hook | Purpose | Where to use |
|---|---|---|
| `useVoiceSession()` | Creates its own session | Anywhere — standalone |
| `useVoice()` | Reads from `<VoiceWidget>` context | Inside `<VoiceWidget>` children only |

Use `useVoiceSession()` for fully custom UIs that replace the widget entirely. Use `useVoice()` when you're building tool renderers as children of `<VoiceWidget>` — see [Tools API](/voice-widget/tools-api).

## What's next

- [Props reference](/voice-widget/props) — if you want the orb after all
- [Tools API](/voice-widget/tools-api) — interactive UI for tool calls
- [`@pinecall/voice-core`](/voice-core/overview) — for non-React frameworks

---
title: "VoiceSession"
description: "The core class: constructor, methods, and framework integration patterns."
---

# VoiceSession

The main class exported by `@pinecall/web/core`. Manages the WebRTC peer connection, mic stream, DataChannel events, and a reactive state object.

## Constructor

```typescript
new VoiceSession(options)
```

| Option | Type | Required | Description |
|---|---|---|---|
| `agent` | `string` | ✅ | Agent ID to connect to |
| `server` | `string` | — | API base URL (default: `https://voice.pinecall.io`) |
| `config` | `Record<string, unknown>` | — | Session config overrides (voice, STT, language, greeting) |
| `metadata` | `Record<string, unknown>` | — | Metadata passed to the agent (visible as `call.metadata` server-side) |

The constructor does **not** open a connection. Call `connect()` when you want the call to start.

```typescript
const session = new VoiceSession({
  agent: "mara",
  config: {
    voice: "elevenlabs/sarah",
    stt: { provider: "deepgram", model: "nova-3", language: "es" },
    language: "es",
    greeting: "¡Hola! ¿En qué puedo ayudarte?",
  },
});
```

The `config` object uses Pinecall's shortcut syntax — same format the server SDK accepts. See [STT Providers](/reference/stt-providers) and [TTS Providers](/reference/tts-providers).

## Methods

### `connect()`

Opens the WebRTC connection. Returns a `Promise<void>` that resolves when the connection is established.

```typescript
await session.connect();
```

Internally it:

1. Fetches a short-lived token from `GET /webrtc/token?agent_id=<agent>`
2. Fetches ICE servers from `GET /webrtc/ice-servers` (falls back to Google STUN)
3. Requests microphone access via `getUserMedia`
4. Creates `RTCPeerConnection`, adds the mic track, opens a DataChannel
5. Generates an SDP offer, gathers ICE candidates
6. Sends the offer to `POST /webrtc/offer` with the token
7. Applies the remote SDP answer → connection established

State transitions: `idle` → `connecting` → `connected` (or `error`).

### `disconnect()`

Closes the connection, stops the mic, clears timers. State returns to `idle`. The `messages` array is preserved.

```typescript
session.disconnect();
```

### `toggleMute()` / `setMuted(muted)`

Mute or unmute the mic. Both disable the local audio track **and** send `{ action: "mute" | "unmute" }` over the DataChannel so the server stops processing audio too.

```typescript
session.toggleMute();
session.setMuted(true);
```

### `getState()`

Returns the current state snapshot. The returned object is **stable by identity** — it only changes when state mutates, which makes it safe for React's `useSyncExternalStore`.

```typescript
const { status, phase, messages, isMuted, duration } = session.getState();
```

See [State and Phases](/web/core/state-and-phases) for the full shape.

### `subscribe(listener)`

Subscribes to all state changes. Returns an unsubscribe function. Designed to plug directly into reactive frameworks.

```typescript
const unsubscribe = session.subscribe(() => {
  console.log(session.getState());
});

// later
unsubscribe();
```

### `destroy()`

Disconnects, clears all subscribers, and marks the instance unusable. Call this on component unmount.

```typescript
session.destroy();
```

### `configure(config)`

Sends a mid-call configuration update over the DataChannel. The server hot-swaps providers without disconnecting. Use this for live language/voice/STT switching during an active call.

```typescript
session.configure({
  voice: "elevenlabs/george",
  stt: { provider: "deepgram", model: "nova-3", language: "es" },
  language: "es",
});
```

> Only works on a connected session. For pre-connect config updates use `updateOptions()`.

### `updateOptions(patch)`

Updates options **before** the next `connect()` call. No effect on an already-connected session.

```typescript
session.updateOptions({
  config: {
    voice: "elevenlabs/valentina",
    language: "es",
    greeting: "¡Hola!",
  },
});

await session.connect(); // uses the new config
```

## Events (EventTarget)

`VoiceSession` extends `EventTarget`. Listen with `addEventListener`:

| Event | `detail` | When |
|---|---|---|
| `status` | `{ status }` | Connection status changed |
| `phase` | `{ phase }` | Call phase changed (listening, speaking, thinking, etc.) |
| `message` | `{ message }` | New transcript message added or existing one updated |
| `error` | `{ error }` | An error occurred |
| `change` | `{ state }` | Any state mutation (most general) |
| `event` | raw payload | Every raw DataChannel event from the server |

```typescript
session.addEventListener("message", (e) => {
  const msg = e.detail.message;
  if (msg.role === "user" && !msg.isInterim) console.log("User:", msg.text);
});

session.addEventListener("event", (e) => {
  // raw — see DataChannel protocol page for the full catalog
  if (e.detail.event === "llm.toolCall") {
    console.log("Tool calls:", e.detail.tool_calls);
  }
});
```

The `event` listener is the power-user escape hatch. Every JSON message from the server's DataChannel is forwarded as-is. Use it for things the state machine doesn't expose: tool calls, audio metrics, custom events.

## Framework patterns

### Vanilla JS

```typescript
import { VoiceSession } from "@pinecall/web/core";

const session = new VoiceSession({ agent: "florencia" });
const btn = document.getElementById("call-btn");
const transcript = document.getElementById("transcript");

btn.onclick = async () => {
  if (session.getState().status === "connected") {
    session.disconnect();
    btn.textContent = "Start Call";
  } else {
    await session.connect();
    btn.textContent = "End Call";
  }
};

session.addEventListener("message", (e) => {
  const msg = e.detail.message;
  const div = document.createElement("div");
  div.className = msg.role;
  div.textContent = `${msg.role}: ${msg.text}`;
  transcript.appendChild(div);
});

session.addEventListener("phase", (e) => {
  document.body.dataset.phase = e.detail.phase;
});
```

### React (`useSyncExternalStore`)

```tsx
import { useSyncExternalStore, useCallback, useState, useEffect } from "react";
import { VoiceSession } from "@pinecall/web/core";

function useVoiceSession(agent: string) {
  const [session] = useState(() => new VoiceSession({ agent }));

  const state = useSyncExternalStore(
    useCallback((cb) => session.subscribe(cb), [session]),
    () => session.getState(),
  );

  useEffect(() => () => session.destroy(), [session]);

  return { ...state, session };
}
```

> If you're using React and want a ready-made widget instead of building UI, use [`@pinecall/web`](/web/widget/overview) — it wraps this pattern and ships an animated orb UI.

### Vue 3

```typescript
import { ref, onUnmounted } from "vue";
import { VoiceSession } from "@pinecall/web/core";

export function useVoiceSession(agent: string) {
  const session = new VoiceSession({ agent });
  const state = ref(session.getState());

  session.subscribe(() => {
    state.value = session.getState();
  });

  onUnmounted(() => session.destroy());

  return { state, session };
}
```

### Svelte

```typescript
import { readable } from "svelte/store";
import { VoiceSession } from "@pinecall/web/core";

export function createVoiceSession(agent: string) {
  const session = new VoiceSession({ agent });

  const state = readable(session.getState(), (set) => {
    return session.subscribe(() => set(session.getState()));
  });

  return { state, session };
}
```

## TypeScript types

All types are exported from the package:

```typescript
import type {
  VoiceSessionOptions,
  VoiceSessionState,
  SessionStatus,      // "idle" | "connecting" | "connected" | "error"
  CallPhase,          // "idle" | "listening" | "speaking" | "pause" | "thinking"
  TranscriptMessage,
} from "@pinecall/web/core";
```

## What's next

- [State and phases](/web/core/state-and-phases) — the reactive state model in detail
- [DataChannel protocol](/web/core/datachannel-protocol) — every event the server emits
- [`@pinecall/web`](/web/widget/overview) — the React widget built on top

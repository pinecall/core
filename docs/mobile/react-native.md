---
title: "@pinecall/react-native"
description: "Native AI voice calls for React Native — CallKit + native WebRTC, the same headless CallClient API as @pinecall/ionic."
---

# @pinecall/react-native

Native AI voice calls for React Native. Same architecture as [`@pinecall/ionic`](/mobile/ionic-overview): CallKit plus **WebRTC.framework** natively, with audio started exactly when CallKit activates the session — the piece a JS/webview WebRTC stack cannot do during a `CXCall`.

```
tap "call" ──▶ CallKit rings / dials (native UI)
       answer ──▶ native WebRTC audio ⇄ voice.pinecall.io ⇄ your agent
                  DataChannel events ──▶ live transcript in YOUR components
```

Repository: [github.com/pinecall/react-native](https://github.com/pinecall/react-native).

## Install

```bash
npm install @pinecall/react-native
cd ios && pod install
```

Add to `ios/<App>/Info.plist`:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Microphone access is needed to talk to the agent.</string>
<key>UIBackgroundModes</key>
<array>
  <string>audio</string>
  <string>voip</string>
</array>
```

> CallKit does **not** work on the iOS simulator — test on a real device.

## Backend: mint call tokens

Identical to the Ionic plugin — your backend runs the agent and exposes a token endpoint; the app never sees your Pinecall API key.

```js
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall(); // PINECALL_API_KEY from env
const agent = pc.agent("assistant", {
  prompt: "You are a friendly voice assistant.",
  llm: "openai/gpt-5.4-nano",
  voice: "elevenlabs/sarah",
  stt: "deepgram/flux",
  greeting: "Hey there! How can I help you today?",
});

app.get("/api/token", async (_req, res) => {
  const t = await agent.createToken("webrtc"); // 60s, single-use
  res.json({ token: t.token, server: t.server, expires_in: t.expiresIn });
});
```

## Use

Both the store and the hook come from the package root — there is no `/react` subpath here.

```tsx
import { CallClient, useCallClient } from "@pinecall/react-native";

const client = new CallClient(); // one shared instance

function App() {
  const call = useCallClient(client);

  if (call.status === "idle") {
    return (
      <Button
        title="📞 Call the agent"
        onPress={() =>
          call.startCall({
            agentId: "assistant",
            callerName: "Assistant",
            handle: "AI voice agent",
            tokenUrl: "https://your-backend.com/api/token",
            // direction: "incoming"  // agent rings YOU instead
          })
        }
      />
    );
  }

  // Your UI, your components — the transcript is plain data:
  return (
    <View>
      <Text>{call.status} · {call.phase} · {call.duration}s</Text>
      {call.messages.map((m) => (
        <Text key={m.id}>{m.role === "bot" ? "🤖" : "🗣"} {m.text}</Text>
      ))}
      <Button title="🔊" onPress={call.toggleSpeaker} />
      <Button title="🎙" onPress={call.toggleMute} />
      <Button title="End" onPress={call.endCall} />
    </View>
  );
}
```

> During the native ring (`direction: 'incoming'`), CallKit owns the screen — render your in-call UI when `status` is `connecting` or `connected`.

### Direction

- **`'outgoing'`** (default) — the user dials the agent: native outgoing-call UI, connects immediately.
- **`'incoming'`** — the agent calls the user: native ring, connects on answer. It rings only while the app is running; a killed or backgrounded ring needs PushKit and a paid Apple Developer account — see the [PushKit reference implementation](/mobile/background-calls-pushkit).

## API

### `CallClient` — headless core

| Member | Description |
|---|---|
| `startCall(opts)` | `{ agentId, callerName, handle?, tokenUrl, direction? }` |
| `endCall()` | Hang up (syncs the native call UI). |
| `toggleMute()` | Mic on/off. |
| `toggleSpeaker()` | Loudspeaker ↔ earpiece (earpiece is the default). |
| `getState()` / `subscribe(cb)` | Reactive store: `{ status, phase, agentId, isMuted, isSpeaker, duration, messages, error }` |
| `destroy()` | Remove native listeners. |

`messages: TranscriptMessage[]` — `{ id, role: 'user' | 'bot', text, isInterim? }`, updated live word-by-word while the agent speaks.

### `useCallClient(client?)`

React hook returning the state plus the actions. Pass a shared `CallClient` so non-React code (push handlers) can start calls on the same instance.

### `PinecallCall`

The raw native module is also exported, for advanced integrations.

## Platform support

| Target | Call UI | Audio | Status |
|---|---|---|---|
| iOS device | CallKit (native) | WebRTC.framework (native) | ✅ verified end-to-end |
| iOS simulator | — | — | ⛔ CallKit unsupported by the simulator |
| Android device (API 26+) | your UI + self-managed Telecom | native WebRTC | ⚠️ implemented, compiles, **not yet run on a device** |

There is **no web fallback** in this package — that is the one thing `@pinecall/ionic` has and this one does not. If you need the same code to run in a browser, use [`@pinecall/web`](/web/widget/overview) there.

### Android notes

Android's [self-managed `ConnectionService`](https://developer.android.com/reference/android/telecom/ConnectionService) is the CallKit equivalent — native audio routing, focus, Bluetooth and Do-Not-Disturb integration. The difference from iOS: **your app draws the in-call UI**, so the same `CallScreen` you render from `CallClient` state *is* the call screen. WebRTC runs via `io.github.webrtc-sdk:android` (the same 125.x family as iOS). The package's manifest — permissions plus the `ConnectionService` — auto-merges into your app; add a runtime request for `RECORD_AUDIO` and `MANAGE_OWN_CALLS`. Requires API 26+. Ringing a backgrounded or killed app still needs FCM (roadmap).

## Example app

The repo ships `example/`: an agent list, native outgoing and incoming calls, a custom in-call screen with live transcript, and a dev token backend (`example/server`).

```bash
cd example/server && cp .env.example .env   # add PINECALL_API_KEY
npm install && npm start                     # agent + token server on :8787

# point example/src/config.ts SERVER_BASE at your Mac's LAN IP, then:
cd example && yarn ios --device   # real device — CallKit needs it
```

## Roadmap

- Background / killed-app ringing — PushKit (iOS, paid Apple account) plus FCM high-priority push (Android) with a full-screen-intent notification
- Mid-call `configure()` (hot-swap voice/language), sealed token metadata
- Reconnection / ICE restarts, Bluetooth route picker

## What's next

- [`@pinecall/ionic` overview](/mobile/ionic-overview) — the sibling package, with a web fallback
- [Background & killed-app calls](/mobile/background-calls-pushkit)

---
title: "@pinecall/ionic"
description: "Native WhatsApp-style AI voice calls for Ionic / Capacitor apps — CallKit UI, native WebRTC audio, headless call store."
---

# @pinecall/ionic

Native AI voice calls for Ionic / Capacitor apps. Your user gets a **real phone call** — native CallKit ring, the iOS in-call screen, lock-screen controls, earpiece/speaker routing — and on the other end is a Pinecall agent.

```bash
npm install @pinecall/ionic
npx cap sync ios
```

The core is **headless**: the live transcript is plain data, and you render it with whatever components you like.

```
tap "call" ──▶ CallKit rings (native UI)
       answer ──▶ native WebRTC audio ⇄ voice.pinecall.io ⇄ your agent
                  DataChannel events ──▶ live transcript in YOUR components
```

## Why a native plugin instead of the web widget

WebView WebRTC ([`@pinecall/web`](/web/widget/overview)) works fine in a browser — but during a CallKit call **iOS hands the audio session to the `CXCall`**, and a `WKWebView`'s audio can never join it: the mic captures silence and remote audio is muted.

This plugin runs WebRTC **natively** (WebRTC.framework) and starts its audio units exactly when CallKit activates the session (`provider(didActivate:)` → `RTCAudioSession`). That is the same architecture WhatsApp uses.

On the web and on the iOS **simulator** — where CallKit does not work — the same API transparently falls back to `@pinecall/web`. One codebase, every target.

## iOS permissions

Add to `ios/App/App/Info.plist`:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Microphone access is needed to talk to the agent.</string>
<key>UIBackgroundModes</key>
<array>
  <string>audio</string>
  <string>voip</string>
</array>
```

## Backend: mint call tokens

The plugin never sees your Pinecall API key. Your backend runs the agent and exposes a token endpoint:

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

The app only ever holds a short-lived, single-use WebRTC token — same security model as the [browser widget](/guides/webrtc-browser).

## Use — React

```tsx
import { CallClient } from "@pinecall/ionic";
import { useCallClient } from "@pinecall/ionic/react";

const client = new CallClient(); // one shared instance

function CallScreen() {
  const call = useCallClient(client);

  if (call.status === "idle") {
    return (
      <button
        onClick={() =>
          call.startCall({
            agentId: "assistant",
            callerName: "Assistant",
            handle: "AI voice agent",
            tokenUrl: "https://your-backend.com/api/token",
          })
        }
      >
        📞 Call the agent
      </button>
    );
  }

  // Your UI, your components — the transcript is plain data:
  return (
    <div>
      <p>{call.status} · {call.phase} · {call.duration}s</p>
      {call.messages.map((m) => (
        <p key={m.id}>{m.role === "bot" ? "🤖" : "🗣"} {m.text}</p>
      ))}
      <button onClick={call.toggleSpeaker}>🔊</button>
      <button onClick={call.toggleMute}>🎙</button>
      <button onClick={call.endCall}>End</button>
    </div>
  );
}
```

> During the native ring, **CallKit owns the screen**. Render your in-call UI when `status` is `connecting` or `connected`.

### Any other framework

`CallClient` is a plain subscribable store — no React required:

```ts
const client = new CallClient();
client.subscribe(() => render(client.getState()));
```

## Direction: you call the agent, or the agent calls you

```ts
call.startCall({ agentId, callerName, tokenUrl });                        // you dial
call.startCall({ agentId, callerName, tokenUrl, direction: 'incoming' }); // agent rings you
```

- **`'outgoing'`** (default) — shows the native outgoing-call UI and connects immediately.
- **`'incoming'`** — presents a native ring and connects on answer. Use it to simulate the agent calling the user.

On web and on the simulator both directions connect directly.

> **Heads up:** `'incoming'` only rings while the app is running. Ringing a **backgrounded or killed** app (the way WhatsApp does) needs PushKit, which requires a paid Apple Developer account — see [Background & killed-app calls](/mobile/background-calls-pushkit).

## API

### `CallClient` — headless core

| Member | Description |
|---|---|
| `startCall(opts)` | Start a call. `opts: { agentId, callerName, handle?, tokenUrl, direction?, config? }`. |
| `endCall()` | Hang up (also syncs the native call UI). |
| `toggleMute()` | Mic on/off — the native mute button works too. |
| `toggleSpeaker()` | Loudspeaker ↔ earpiece. Native only; earpiece is the default, like WhatsApp. |
| `getState()` / `subscribe(cb)` | Reactive store. |

`getState()` returns:

```ts
{ status, phase, agentId, isMuted, isSpeaker, duration, messages, error }
```

- `status`: `'idle' | 'ringing' | 'connecting' | 'connected' | 'error'`
- `phase`: `'idle' | 'listening' | 'thinking' | 'speaking'`
- `messages`: `TranscriptMessage[]` — `{ id, role: 'user' | 'bot', text, isInterim?, messageId? }`, updated live word-by-word while the agent speaks.

`StartCallOptions.config` carries session overrides (voice, stt, language…) for the **web strategy only** — it is ignored on native.

### `useCallClient(client?)` — `@pinecall/ionic/react`

React hook returning the state plus `startCall`, `endCall`, `toggleMute`, `toggleSpeaker`, and the `client` itself. Pass a shared `CallClient` so non-React code (push handlers, SSE listeners) can start calls on the same instance; omit it to create one local to the component tree.

### `PinecallCall` — raw plugin

The low-level Capacitor plugin, for advanced integrations: `isNativeCallSupported()`, `startCall()`, `endCall()`, `setMuted()`, `setSpeaker()`, plus `state` and `serverEvent` listeners.

## Platform support

| Target | Call UI | Audio | Status |
|---|---|---|---|
| iOS device | CallKit (native) | WebRTC.framework (native) | ✅ verified end-to-end |
| iOS simulator | in-app (yours) | webview WebRTC | ✅ (CallKit unsupported by the simulator) |
| Web | in-app (yours) | webview WebRTC | ✅ |
| Android device (API 26+) | your UI + self-managed Telecom | native WebRTC | ⚠️ implemented, compiles, **not yet run on a device** |
| Android emulator | in-app (yours) | webview WebRTC | ✅ (falls back like the simulator) |

### Android notes

Android uses a self-managed [`ConnectionService`](https://developer.android.com/reference/android/telecom/ConnectionService) — the CallKit equivalent, giving the call native audio routing, focus, Bluetooth and Do-Not-Disturb integration — while **your app draws the in-call UI**. WebRTC runs natively via `io.github.webrtc-sdk:android`.

Run `npx cap add android` then `npx cap sync`; the plugin's permissions and its `ConnectionService` auto-merge into your manifest. Request `RECORD_AUDIO` and `MANAGE_OWN_CALLS` at runtime. Requires API 26+; emulators fall back to the webview path.

## Example app

The repo ships `examples/app`: an agent address book, native calls, a custom in-call overlay with live transcript, and a dev backend (`server/`) with the token endpoint plus an SSE "the agent calls you" trigger.

```bash
cd examples/app/server && cp .env.example .env  # add PINECALL_API_KEY
npm install && npm start                        # agent + token server on :8787

cd .. && npm install
VITE_SERVER_BASE=http://<your-mac-LAN-ip>:8787 npm run build
npx cap run ios   # real device — CallKit doesn't work on the simulator
```

## Roadmap

- **Background / killed-app ringing** — PushKit on iOS (paid Apple Developer account) plus FCM high-priority push on Android with a full-screen-intent notification. iOS reference implementation → [Background & killed-app calls](/mobile/background-calls-pushkit)
- Mid-call `configure()` (hot-swap voice/language) and sealed token metadata
- Reconnection / ICE restarts, Bluetooth route picker, CallKit icon
- Android device verification — the plugin compiles and is complete, but has not yet run on physical hardware

## What's next

- [Background & killed-app calls](/mobile/background-calls-pushkit) — PushKit / VoIP push reference implementation
- [`@pinecall/react-native`](/mobile/react-native) — the same architecture for React Native
- [WebRTC in the browser](/guides/webrtc-browser) — the token endpoint the plugin calls

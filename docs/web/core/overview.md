---
title: "@pinecall/web/core"
description: "Framework-agnostic WebRTC voice session client. Zero dependencies."
---

# @pinecall/web/core

The browser-side counterpart to `@pinecall/sdk`. A framework-agnostic WebRTC client that handles the audio transport, mic access, and DataChannel events. Works with React, Vue, Svelte, vanilla JS, or any framework.

```bash
npm install @pinecall/web
```

> Zero runtime dependencies. Browser-only (requires `RTCPeerConnection` and `getUserMedia`).

## What it does

`@pinecall/web/core` is what the browser uses to talk to a Pinecall agent over WebRTC. It:

- Fetches a short-lived token from your backend (or the voice server, in convenience mode)
- Requests microphone access via `getUserMedia`
- Opens a peer connection to `voice.pinecall.io`
- Exposes the conversation as a reactive state object + an event stream

It does **not** render UI. For a drop-in React widget with an animated orb, use [`@pinecall/web`](/web/widget/overview) (which is built on top of `@pinecall/web/core`).

## Quick start

```typescript
import { VoiceSession } from "@pinecall/web/core";

const session = new VoiceSession({ agent: "mara" });

session.addEventListener("message", (e) => {
  console.log(`${e.detail.message.role}: ${e.detail.message.text}`);
});

await session.connect();

// later
session.disconnect();
```

That's it. The session manages the connection lifecycle, mic, and transcript. You get a stream of structured events you can wire into any UI.

## How it fits with the other packages

![Web package architecture](/assets/diagrams/web-package-arch.png)

- **You write**: agent logic in Node.js with `@pinecall/sdk`
- **You drop in**: `@pinecall/web/core` (or `@pinecall/web`) in the browser
- **The voice server**: handles the audio pipeline (STT, LLM, TTS, VAD) and forwards events both ways

## Two interfaces: state + events

`@pinecall/web/core` exposes the session two ways. Use whichever fits your framework:

| Style | API | Best for |
|---|---|---|
| **Reactive state** | `session.subscribe(cb)` + `session.getState()` | React's `useSyncExternalStore`, Vue's `ref`, Svelte stores |
| **Event listeners** | `session.addEventListener("message" \| "phase" \| "event" \| ...)` | Vanilla JS, imperative code, observability |

You can mix them in the same app — they share the same underlying state machine.

## What's next

- [`VoiceSession` class](/web/core/voice-session) — constructor, methods, options
- [State, phases, and transcripts](/web/core/state-and-phases) — the reactive state model
- [DataChannel protocol](/web/core/datachannel-protocol) — every event the server emits
- [`@pinecall/web`](/web/widget/overview) — the React widget built on `@pinecall/web/core`

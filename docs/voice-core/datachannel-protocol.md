---
title: "DataChannel Protocol"
description: "The raw WebRTC DataChannel protocol — every server event and every client command."
---

# DataChannel Protocol

`VoiceSession` opens an ordered DataChannel named `"events"` over WebRTC. The protocol is plain JSON in both directions. This page documents every message the server sends and every command the client can send.

> Most apps don't need to use the protocol directly — the state machine handles it. Use this when you need to read events the state doesn't expose (tool calls, audio metrics) or when you're sending custom client commands.

## Accessing raw events

Subscribe to the `"event"` listener — every server message is forwarded as-is:

```typescript
session.addEventListener("event", (e) => {
  const raw = e.detail; // the parsed JSON from the server
  console.log(raw.event, raw);
});
```

## Server → Client events

### Speech detection (STT)

| Event | Fields | Description |
|---|---|---|
| `speech.started` | — | User started physically speaking (VAD detected voice) |
| `speech.ended` | — | User stopped speaking (VAD silence) |
| `user.speaking` | `text` | STT partial/interim result — text may change |
| `user.message` | `text` | STT final result — text is locked, turn is over |

### Turn detection

| Event | Fields | Description |
|---|---|---|
| `turn.pause` | — | Brief silence detected — user might still be talking |
| `turn.end` | — | Silence confirmed — user's turn is over, LLM starts |
| `turn.resumed` | — | User started speaking again during the pause |

### Bot speech (TTS)

| Event | Fields | Description |
|---|---|---|
| `bot.speaking` | `message_id`, `text` | TTS generation started. `text` has the full intended response. The widget intentionally starts empty and builds word-by-word. |
| `bot.word` | `message_id`, `word`, `word_index` | A single word was spoken by TTS. Arrives in real-time as audio plays. |
| `bot.finished` | `message_id`, `text` | TTS completed normally. `text` is the polished final response. |
| `bot.interrupted` | `message_id` | User barged in — TTS was cut short. |

### Audio metrics

When enabled via session config (`analysis.send_audio_metrics`):

| Event | Fields | Description |
|---|---|---|
| `audio.metrics` | `source`, `energy_db`, `rms`, `peak`, `is_speech`, `vad_prob` | Server-side audio analysis. `source` is `"user"` or `"bot"`. Sent every ~100ms. |

Use it to build live waveform meters, energy bars, or VAD visualizations.

### LLM / tool events

These events are **not** processed by the state machine but are forwarded through the `"event"` listener. They come from the Pinecall server's LLM handler:

| Event | Fields | Description |
|---|---|---|
| `llm.thinking` | — | LLM started generating a response |
| `llm.tool_call` | `tool_calls[]`, `msg_id`, `call_id` | LLM requested tool/function calls. Each item has `id`, `name`, `arguments` (JSON string). |
| `llm.tool_result` | `call_id`, `msg_id`, `results[]` | Tool execution results sent back to LLM. Each item has `tool_call_id`, `result`. |
| `llm.response` | `text`, `finish_reason` | LLM finished generating (text may be empty for tool-only turns) |
| `llm.error` | `error` | LLM error occurred |

### Session limits

| Event | Fields | Description |
|---|---|---|
| `session.idle_warning` | `remaining_seconds` | User hasn't spoken — call will timeout in `remaining_seconds`. Drives the `idleWarning` state field. |
| `session.timeout` | `reason` | Session timed out (`"idle_timeout"` or `"max_duration"`). The client auto-disconnects. |

## Client → Server commands

The client sends these through the DataChannel:

| Message | Format | Description |
|---|---|---|
| Ping | `"ping"` (string) | Keepalive, sent every 1s by the SDK |
| Mute | `{ "action": "mute" }` | Stop processing user audio server-side |
| Unmute | `{ "action": "unmute" }` | Resume processing user audio |
| Configure | `{ "action": "configure", ...config }` | Hot-swap voice, STT, language, or turn detection mid-call |
| Inject Text | `{ "action": "inject_text", "text": "..." }` | Send text as if the user spoke it (for tool UI interactions) |
| Set Context | `{ "action": "set_context", "key": "...", "value": "..." }` | Inject/update keyed context in the LLM prompt |

Most of these have helper methods on `VoiceSession` (`toggleMute`, `configure`). The lower-level commands (`inject_text`, `set_context`) are used by `@pinecall/voice-widget` to power the [Tools API](/docs/voice-widget/tools-api) and dynamic context injection.

## Worked examples

### Monitoring tool calls

```typescript
session.addEventListener("event", (e) => {
  const { event, tool_calls, results } = e.detail;

  if (event === "llm.tool_call" && tool_calls) {
    for (const tc of tool_calls) {
      console.log(`Agent calling ${tc.name}(${tc.arguments})`);
    }
  }
  if (event === "llm.tool_result") {
    console.log("Tool results:", results);
  }
});
```

### Custom audio meter from `audio.metrics`

```typescript
const meter = document.getElementById("meter");

session.addEventListener("event", (e) => {
  if (e.detail.event === "audio.metrics" && e.detail.source === "user") {
    meter.style.width = `${e.detail.rms * 100}%`;
  }
});
```

### Injecting text from a button click

If you have UI components that the user can click to "say" something:

```typescript
// User clicks "Yes, that's right" instead of saying it
document.getElementById("yes-btn").onclick = () => {
  session.send(JSON.stringify({ action: "inject_text", text: "Yes, that's right" }));
};
```

The `@pinecall/voice-widget` exposes this as the `sendText()` helper — see [Tools API](/docs/voice-widget/tools-api).

## WebRTC connection flow

For completeness, here's what happens when you call `connect()`:

```
Browser                              Voice Server
   │                                       │
   ├─ GET /webrtc/token?agent_id=mara ────►│
   │◄─ { token, expiresIn } ───────────────┤
   │                                       │
   ├─ GET /webrtc/ice-servers ────────────►│
   │◄─ [{ urls: "stun:...", ... }] ────────┤
   │                                       │
   ├─ getUserMedia({ audio: true }) ───────│  (browser-local)
   ├─ new RTCPeerConnection(iceServers) ──│
   ├─ pc.addTrack(micTrack) ──────────────│
   ├─ pc.createDataChannel("events") ─────│
   ├─ pc.createOffer() ───────────────────│
   ├─ pc.setLocalDescription(offer) ──────│
   │                                       │
   ├─ POST /webrtc/offer { sdp, token } ──►│
   │◄─ { sdp: answer } ────────────────────┤
   │                                       │
   ├─ pc.setRemoteDescription(answer) ────│
   │  (ICE candidates exchanged)           │
   │                                       │
   │◄═══════ media + datachannel ═════════►│
```

## What's next

- [`VoiceSession`](/docs/voice-core/voice-session) — the high-level API
- [State and phases](/docs/voice-core/state-and-phases) — how raw events map to state
- [Tools API](/docs/voice-widget/tools-api) — building UI that responds to `llm.tool_call`

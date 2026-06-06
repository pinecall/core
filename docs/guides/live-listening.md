---
title: "Live Listening"
description: "Listen to active calls in real-time from a browser or custom client."
---

# Live Listening

Monitor active calls in real-time. Pinecall mixes both sides of the conversation (user + bot) into a single audio stream accessible via WebSocket.

## Enable media

Add `media` to your agent config to enable live listening, recording, or both:

```typescript
const agent = pc.agent("support", {
  prompt: "You are a support agent.",
  voice: "elevenlabs/sarah",
  model: "gpt-4.1-mini",
  media: {
    live: true,       // enables real-time WebSocket stream
    recording: true,  // keeps full call recording in memory
  },
});
```

When a call starts, you can build a live listening URL from the call ID:

```typescript
agent.on("call.started", (call) => {
  const url = `https://voice.pinecall.io/live/${call.id}/player?token=${API_KEY}`;
  console.log(`Listen live: ${url}`);
});
```

## Built-in player

Pinecall provides a hosted player page. Open the URL in any browser:

```
https://voice.pinecall.io/live/{callId}/player?token=pk_xxx
```

The page connects via WebSocket and plays the mixed audio through an AudioWorklet with minimal latency. No dependencies or setup needed.

## Authentication

All live listening endpoints require a valid Pinecall API key passed as a `token` query parameter. The key must belong to the same organization as the active session.

| Endpoint | Auth |
|---|---|
| `GET /live/{id}/player?token=pk_xxx` | API key in query param |
| `WS /live/{id}/ws?token=pk_xxx` | API key in query param |

Without a valid token the server returns `401`.

## Build a custom player

If you need a custom UI or integration, connect directly to the WebSocket endpoint.

### WebSocket protocol

**Connect:**

```
wss://voice.pinecall.io/live/{callId}/ws?token=pk_xxx
```

**First message** — JSON metadata:

```json
{
  "type": "metadata",
  "sampleRate": 8000,
  "channels": 1,
  "bitDepth": 16,
  "sessionId": "CA..."
}
```

**Subsequent messages** — binary frames containing raw PCM audio:
- Format: 16-bit signed little-endian (Int16LE), mono
- Sample rate: `8000` for Twilio calls, `16000` for WebRTC calls
- Chunk size: ~800 bytes per frame (50ms at 8kHz)

**End of call** — the server sends an empty binary frame (`0 bytes`) and closes the connection.

**Keepalive** — during silence the server sends a 2-byte zero frame every 5 seconds.

### Browser example (AudioWorklet)

This is a minimal browser implementation. It connects to the WebSocket, converts PCM Int16 to Float32, and plays through an AudioWorklet:

```javascript
// 1. Create the AudioWorklet processor
const PROCESSOR = `
class Player extends AudioWorkletProcessor {
  constructor() {
    super();
    this._q = [];
    this.port.onmessage = (e) => this._q.push(e.data.samples);
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    let i = 0;
    while (i < out.length && this._q.length) {
      const chunk = this._q[0];
      const take = Math.min(chunk.length, out.length - i);
      out.set(chunk.subarray(0, take), i);
      i += take;
      if (take === chunk.length) this._q.shift();
      else this._q[0] = chunk.subarray(take);
    }
    for (; i < out.length; i++) out[i] = 0;
    return true;
  }
}
registerProcessor('player', Player);
`;

// 2. Set up AudioContext + Worklet
async function listen(callId, token) {
  const ctx = new AudioContext({ sampleRate: 8000 });
  const blob = new Blob([PROCESSOR], { type: 'application/javascript' });
  await ctx.audioWorklet.addModule(URL.createObjectURL(blob));
  const node = new AudioWorkletNode(ctx, 'player');
  node.connect(ctx.destination);

  // 3. Connect WebSocket
  const ws = new WebSocket(
    `wss://voice.pinecall.io/live/${callId}/ws?token=${token}`
  );
  ws.binaryType = 'arraybuffer';

  ws.onmessage = (e) => {
    if (typeof e.data === 'string') return; // metadata frame

    const pcm = new Int16Array(e.data);
    if (pcm.length < 2) return; // keepalive

    // Convert Int16 → Float32
    const f32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;

    node.port.postMessage({ samples: f32 });
  };

  ws.onclose = () => ctx.close();

  return { stop: () => { ws.close(); ctx.close(); } };
}
```

### Node.js example

Stream live audio to a file or pipe it to another process:

```typescript
import WebSocket from "ws";
import { createWriteStream } from "fs";

const ws = new WebSocket(
  `wss://voice.pinecall.io/live/${callId}/ws?token=${apiKey}`
);
const out = createWriteStream("call.pcm");

ws.on("message", (data, isBinary) => {
  if (!isBinary) return; // skip metadata
  if (data.length < 4) return; // skip keepalive
  out.write(data);
});

ws.on("close", () => {
  out.end();
  // Convert to WAV: ffmpeg -f s16le -ar 8000 -ac 1 -i call.pcm call.wav
});
```

## Media config reference

| Field | Type | Default | Description |
|---|---|---|---|
| `live` | `boolean` | `false` | Enable real-time WebSocket streaming |
| `recording` | `boolean` | `false` | Keep full mixed audio in memory |
| `maxDurationSeconds` | `number` | `1800` | Max recording length (30 min) |

## How it works

The server maintains two audio buffers — one for user (mic) audio and one for bot (TTS) audio. A background task runs every 50ms, mixing both buffers into a single PCM stream. When bot audio arrives later in the call (e.g., after a greeting delay), the mixer automatically inserts silence to keep the timelines aligned.

On barge-in (user interrupts bot), the bot's remaining audio is discarded and the mixer pads with silence to maintain alignment.

Live listeners subscribe to the mixed output and receive chunks as they're produced. Recording captures the full mixed buffer for export after the call ends.

## What's next

- [Inbound Voice](/guides/inbound-voice) — build a phone agent
- [Tools and Functions](/guides/tools-and-functions) — let the agent take actions
- [Events Reference](/reference/events) — all SDK events

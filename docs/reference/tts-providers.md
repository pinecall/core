---
title: "TTS Providers"
description: "Text-to-speech providers, voices, and tuning parameters."
---

# TTS Providers

Pinecall supports multiple TTS providers. Voices accept either a string shortcut (`provider:voice_id`) or a full config object.

## Quick reference

```typescript
{ voice: "elevenlabs:JBFqnCBsd6RMkjVDRZzb" }
{ voice: "cartesia:a0e99841-438c-4a64-b679-ae501e7d6091" }
{ voice: "polly:Joanna" }
```

## Discovering voices

Use the [`fetchVoices`](/docs/reference/rest-api) REST helper to list voices on your account:

```typescript
import { fetchVoices } from "@pinecall/sdk";

const voices = await fetchVoices({ provider: "elevenlabs", language: "es" });
voices.forEach((v) => console.log(`${v.name} → ${v.provider}:${v.id}`));
```

## ElevenLabs

```typescript
voice: {
  provider: "elevenlabs",
  voice_id: "JBFqnCBsd6RMkjVDRZzb",
  model: "eleven_flash_v2_5",
  speed: 1.0,
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
}
```

Shortcut: `"elevenlabs:JBFqnCBsd6RMkjVDRZzb"`

**Tuning notes:**

- `model: "eleven_flash_v2_5"` — fastest, best for real-time
- `stability` higher = more consistent, less expressive
- `similarity_boost` higher = closer to the cloned voice
- `style` 0–1, only on `eleven_multilingual_v2`

## Cartesia

```typescript
voice: {
  provider: "cartesia",
  voice_id: "a0e99841-438c-4a64-b679-ae501e7d6091",
  model: "sonic",
  speed: 1.0,
  volume: 1.0,
  emotion: null,
  language: "en",
}
```

Shortcut: `"cartesia:a0e99841-438c-4a64-b679-ae501e7d6091"`

**Tuning notes:**

- `model: "sonic"` — fastest Cartesia model, designed for streaming
- `emotion` accepts named emotion presets (check Cartesia docs for the current list)

## AWS Polly

```typescript
voice: {
  provider: "polly",
  voice_id: "Joanna",
  engine: "neural",
  language: "en-US",
}
```

Shortcut: `"polly:Joanna"`

**Tuning notes:**

- `engine: "neural"` is required for natural-sounding output. The older `standard` engine is robotic.
- Polly is the cheapest option but the least natural — fine for IVR-style flows, not for engaging conversation.

## Which to choose

| Provider | Best for | Trade-off |
|---|---|---|
| **ElevenLabs** | Most natural-sounding output | Higher cost per character |
| **Cartesia** | Real-time streaming, low latency | Smaller voice library |
| **Polly** | Cheap IVR, simple flows | Less natural |

For most agents, start with ElevenLabs (`eleven_flash_v2_5`) or Cartesia (`sonic`). Use Polly only for high-volume, low-engagement flows.

## Hot-reloading voices

Voice can change at any time:

```typescript
// Agent-wide
agent.configure({ voice: "cartesia:newVoice" });

// One call only
call.configure({ voice: "elevenlabs:differentVoice" });

// Per-channel override
agent.addChannel("phone", "+34911234567", {
  voice: "elevenlabs:spanishVoiceId",
});
```

## What's next

- [STT Providers](/docs/reference/stt-providers)
- [REST API → fetchVoices](/docs/reference/rest-api)
- [`Agent.configure`](/docs/api/agent)

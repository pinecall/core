---
title: "TTS Providers"
description: "Text-to-speech providers, voices, and tuning parameters."
---

# TTS Providers

Pinecall supports multiple TTS providers. Use the `provider/friendly-id` format (always lowercase) to specify a voice:

## Voice format

```typescript
// Recommended: friendly alias (always lowercase)
{ voice: "elevenlabs/sarah" }
{ voice: "cartesia/yumiko" }
{ voice: "polly/lucia" }

// Full config object (for tuning parameters)
{ voice: { provider: "elevenlabs", voice_id: "...", speed: 1.1 } }
```

> The legacy `provider:rawId` format (e.g. `"elevenlabs:EXAVITQu4vr4xnSDxMaL"`) still works but is not recommended.

## Discovering voices

Use the CLI to browse voices. Without flags, you get a catalog overview:

```bash
# Overview — shows providers, voice counts, languages
pinecall voices

# List voices for a provider + language
pinecall voices --provider=elevenlabs --language=es

# Preview a voice (plays audio in your terminal)
pinecall voices play elevenlabs/sarah
```

Every voice gets a friendly alias auto-generated from its name — use it directly in your config:

```typescript
{ voice: "elevenlabs/sarah" }    // → Sarah - Mature, Reassuring
{ voice: "elevenlabs/agustin" }  // → Agustin - Conversational & Relaxed
```

Or use the [`fetchVoices`](/reference/rest-api) REST helper:

```typescript
import { fetchVoices } from "@pinecall/sdk";

const voices = await fetchVoices({ provider: "elevenlabs", language: "es" });
voices.forEach((v) => console.log(`${v.name} → ${v.provider}/${v.alias ?? v.id}`));
```

## ElevenLabs

```typescript
voice: {
  provider: "elevenlabs",
  voice_id: "JBFqnCBsd6RMkjVDRZzb",
  speed: 1.0,
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
}
```

Shortcut: `"elevenlabs/sarah"`

The server defaults to `eleven_flash_v2_5` (the fastest model, optimized for real-time streaming). Override it with the optional `model` field (e.g. `model: "eleven_turbo_v2_5"`).

**Tuning notes:**

- `stability` higher = more consistent, less expressive
- `similarity_boost` higher = closer to the cloned voice
- `style` 0–1, adds expressiveness (slight latency cost)

## Cartesia

```typescript
voice: {
  provider: "cartesia",
  voice_id: "a0e99841-438c-4a64-b679-ae501e7d6091",
  model: "sonic-3",
  speed: 1.0,
  volume: 1.0,
  emotion: null,
  language: "en",
}
```

Shortcut: `"cartesia/yumiko"`

**Tuning notes:**

- `model: "sonic-3"` — fastest Cartesia model, designed for streaming
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

Shortcut: `"polly/joanna"`

**Tuning notes:**

- `engine: "neural"` is required for natural-sounding output. The older `standard` engine is robotic.
- Polly is the cheapest option but the least natural — fine for IVR-style flows, not for engaging conversation.

## Which to choose

| Provider | Best for | Trade-off |
|---|---|---|
| **ElevenLabs** | Most natural-sounding output | Higher cost per character |
| **Cartesia** | Real-time streaming, low latency | Smaller voice library |
| **Polly** | Cheap IVR, simple flows | Less natural |

For most agents, start with ElevenLabs (`eleven_flash_v2_5`) or Cartesia (`sonic-3`). Use Polly only for high-volume, low-engagement flows.

## Hot-reloading voices

Voice can change at any time:

```typescript
// Agent-wide
agent.update({ voice: "cartesia/blake" });

// One call only
call.update({ voice: "elevenlabs/daniel" });

// Per-channel override
agent.addPhoneNumber("+34911234567", {
  voice: "elevenlabs/valentina",
});
```

## What's next

- [STT Providers](/reference/stt-providers)
- [REST API → fetchVoices](/reference/rest-api)
- [`Agent.configure`](/api/agent)

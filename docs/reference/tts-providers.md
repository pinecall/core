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

## Managed vs bring-your-own-key (BYOK)

Data-driven from the rate table — see [Managed vs BYOK](/reference/managed-vs-byok)
for the full list and the live `GET /api/rates/models` query.

| TTS provider | Managed (no key needed) | Notes |
|---|---|---|
| `elevenlabs` | ✅ Yes | Default, recommended |
| `cartesia` (sonic-3.5) | ✅ Yes | |
| `polly` (AWS) | ✅ Yes | |
| `rime` | ❌ BYOK only | Add a Rime key under Provider Keys |
| `soniox` | ❌ BYOK only | One Soniox key = TTS **and** STT |
| `xai` (Grok) | ❌ BYOK only | Same xAI key as Grok LLM |

> **BYOK enforcement:** configuring `rime` without a saved Rime key rejects agent
> registration with `PROVIDER_KEY_REQUIRED`. With your own key, that usage is billed
> by the provider directly — **not** deducted from your Pinecall credits.

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

### Model selection (auto for non-English)

The server picks the ElevenLabs model from your `language`:

| Language | Default model | Why |
|---|---|---|
| `en` (or unset) | `eleven_flash_v2_5` | Fastest, optimized for real-time streaming |
| Any non-English (`es`, `fr`, `de`, …) | `eleven_multilingual_v2` | Flash/Turbo don't normalize text, so Spanish & other languages mispronounce numbers, dates, currency and abbreviations. The multilingual model reads them naturally. |

> `eleven_multilingual_v2` is billed at a higher rate than flash (it's a higher-quality model). If you'd rather keep the faster/cheaper flash model for a non-English agent, use the `flash` shortcut or pin the model explicitly (both below).

#### `flash: true` — keep flash on a non-English agent

The multilingual model trades a little **latency** for much better pronunciation.
If your non-English agent should prioritize **lowest latency / lowest cost** over
pronunciation quality, set the top-level `flash` flag — it opts out of the
multilingual auto-default and keeps `eleven_flash_v2_5`:

```typescript
const agent = pc.agent("sofia", {
  prompt: "Sos Sofía, asistente de la clínica.",
  llm: "openai/gpt-5-chat-latest",
  voice: "elevenlabs/agus",
  stt: "deepgram/flux",
  language: "es",
  flash: true,        // ← stay on eleven_flash_v2_5 despite language: "es"
});
```

`flash` is a sibling of `language` (not inside `voice`), so it reads cleanly with
the rest of the shortcuts. Semantics:

| Config | Resulting ElevenLabs model |
|---|---|
| `language: "es"` | `eleven_multilingual_v2` (auto) |
| `language: "es"`, `flash: true` | `eleven_flash_v2_5` |
| `language: "en"` (with or without `flash`) | `eleven_flash_v2_5` |
| `voice: { model: "..." }` (any `flash`/`language`) | the pinned model — explicit always wins |

Notes:

- **ElevenLabs only.** `flash` has no effect on Cartesia or Polly.
- **No-op for English** — English already defaults to flash.
- **An explicit `voice: { model }` always wins** over `flash`. Use `flash: true`
  for the common "I want the cheap fast model" case; use the `model` field when
  you need a specific model id.
- Works per-channel too: `phoneNumbers: [{ number, language: "es", flash: true }]`.

**Override the model** with the optional `model` field — it always wins over both the auto-default and `flash`:

```typescript
voice: {
  provider: "elevenlabs",
  voice_id: "JBFqnCBsd6RMkjVDRZzb",
  model: "eleven_multilingual_v2",  // or "eleven_flash_v2_5" / "eleven_turbo_v2_5"
}
```

The model is part of the voice config, so it hot-reloads with it — `agent.update({ voice })` and a same-provider `call.update({ voice })` keep the model/language already in effect unless you pass a new one.

**Tuning notes:**

- `stability` higher = more consistent, less expressive
- `similarity_boost` higher = closer to the cloned voice
- `style` 0–1, adds expressiveness (slight latency cost)

## Cartesia

```typescript
voice: {
  provider: "cartesia",
  voice_id: "a0e99841-438c-4a64-b679-ae501e7d6091",
  model: "sonic-3.5",   // latest; also "sonic-3" / "sonic-latest"
  speed: 1.0,
  volume: 1.0,
  emotion: null,
  language: "en",
}
```

Shortcut: `"cartesia/yumiko"`

**Tuning notes:**

- `model: "sonic-3.5"` — latest/fastest Cartesia model (sub-90ms, 42 languages), designed for streaming. `sonic-3` and `sonic-latest` also available.
- `emotion` accepts named emotion presets (check Cartesia docs for the current list)

## AWS Polly

```typescript
voice: {
  provider: "polly",
  voice_id: "Joanna",
  engine: "neural",        // "neural" | "standard"
  language: "en-US",
  rate: "medium",          // "slow" | "medium" | "fast" | "+10%" / "-10%"
  volume: "medium",        // "soft" | "medium" | "loud" | "+6dB" / "-6dB"
  pitch: "+5%",            // standard engine only
}
```

Shortcut: `"polly/joanna"`

**Tuning notes:**

- `engine: "neural"` is required for natural-sounding output. The older `standard` engine is robotic.
- `rate` / `volume` accept named levels or relative values; `pitch` only applies to the `standard` engine.
- Polly is the cheapest option but the least natural — fine for IVR-style flows, not for engaging conversation.

## Rime (BYOK)

Ultra-natural, expressive English. Requires your own Rime key.

```typescript
voice: {
  provider: "rime",
  voice_id: "cove",      // Rime speaker id
  model: "mistv2",        // or "arcana" (most expressive)
  speed: 1.0,
}
```

Shortcut: `"rime/cove"`

## Soniox (BYOK)

Real-time TTS in 60+ languages. One Soniox key serves **both** Soniox TTS and STT.
Requires your own Soniox key.

```typescript
voice: {
  provider: "soniox",
  voice_id: "Adrian",   // Soniox voice name
  model: "tts-rt-v1",
  language: "en",
}
```

Shortcut: `"soniox/Adrian"`

## xAI Grok (BYOK)

Expressive Grok voices: **ara, eve, leo, rex, sal**. Uses the **same xAI key** as
Grok LLM (`XAI_API_KEY`). Requires your own key.

```typescript
voice: {
  provider: "xai",
  voice_id: "eve",   // ara | eve | leo | rex | sal
  speed: 1.0,
}
```

Shortcut: `"xai/eve"`

## Which to choose

| Provider | Best for | Trade-off |
|---|---|---|
| **ElevenLabs** | Most natural-sounding output | Higher cost per character |
| **Cartesia** | Real-time streaming, low latency | Smaller voice library |
| **Polly** | Cheap IVR, simple flows | Less natural |
| **Rime** | Ultra-natural expressive English | BYOK only; English-focused |
| **Soniox** | Multilingual (60+), single-vendor with Soniox STT | BYOK only |
| **xAI Grok** | Expressive Grok voices (ara/eve/leo/rex/sal) | BYOK only |

For most agents, start with ElevenLabs (`eleven_flash_v2_5`) or Cartesia (`sonic-3.5`). Use Polly only for high-volume, low-engagement flows.

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

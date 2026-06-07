---
title: "STT Providers"
description: "Speech-to-text providers, models, and tuning parameters."
---

# STT Providers

Pinecall supports multiple STT providers. Use the `provider/model` format or a full config object.

## Quick reference

```typescript
// Deepgram Flux (recommended for real-time voice)
{ stt: "deepgram/flux" }             // auto-selects en/multi based on language
{ stt: "deepgram/flux-en" }          // force English-only model
{ stt: "deepgram/flux-multi" }       // force multilingual model

// Deepgram Nova
{ stt: "deepgram/nova-3" }
{ stt: "deepgram/nova-2" }

// Gladia
{ stt: "gladia/solaria" }

// AWS Transcribe
{ stt: "transcribe" }
```

## Naming convention

Configuration objects that pass through to providers keep **snake_case** to mirror what the receiving side expects (`endpointing_ms`, `interim_results`, etc.). This avoids an unnecessary translation layer and lets you copy-paste from provider docs directly.

## Deepgram Flux (recommended)

Best for real-time voice agents. Turn detection and VAD are **auto-derived** — no configuration needed.

```typescript
stt: "deepgram/flux"
```

Or with tuning:

```typescript
stt: {
  provider: "deepgram-flux",
  keyterms: ["pinecall"],      // boost recognition for specific terms
  eot_threshold: 0.5,          // end-of-turn sensitivity (0-1)
  eager_eot_threshold: 0.7,    // eager turn threshold
  eot_timeout_ms: 2000,
}
```

> **Auto-derived:** Flux → native turn detection + native VAD. No need to specify `turnDetection`.

> **Language auto-select:** `"deepgram/flux"` picks `flux-general-en` when `language: "en"` and `flux-general-multi` otherwise. Use `"deepgram/flux-en"` or `"deepgram/flux-multi"` to force a specific model.

## Deepgram Nova

Classic STT. Turn detection and VAD auto-derived (smart_turn + silero).

```typescript
stt: "deepgram/nova-3"
```

Or with tuning:

```typescript
stt: {
  provider: "deepgram",
  model: "nova-3",
  language: "en",
  interim_results: true,
  smart_format: true,
  punctuate: true,
  profanity_filter: false,
  endpointing_ms: 300,
  utterance_end_ms: 1000,
  keywords: ["pinecall"],
}
```

## Gladia

```typescript
stt: "gladia/solaria"
```

Or with tuning:

```typescript
stt: {
  provider: "gladia",
  model: "solaria-1",
  language: "en",
  endpointing: 300,
  speech_threshold: 0.8,
  code_switching: false,
  audio_enhancer: true,
}
```

## AWS Transcribe

```typescript
stt: {
  provider: "transcribe",
  language: "en-US",
}
```

## Which to choose

| Provider | Best for | Trade-off |
|---|---|---|
| `deepgram/flux` | Real-time voice agents | Lowest latency; English, Spanish, French, German, Portuguese, and ~15 more |
| `deepgram/nova-3` | Arabic, Hindi, Thai, CJK, and 60+ languages | Slightly higher latency; smart_turn + silero VAD |
| `gladia/solaria` | Code-switching, multilingual | Higher latency than Deepgram |
| `transcribe` | AWS-native deployments | AWS pricing model |

For most agents, start with `deepgram/flux`. Use `deepgram/nova-3` for languages Flux doesn't cover (Arabic, Hindi, Thai, Chinese, Japanese, Korean, etc.).

## Language coverage

**Deepgram Flux** supports ~20 languages including: English, Spanish, French, German, Portuguese, Italian, Dutch, Russian, Ukrainian, Turkish, Polish, Swedish, Norwegian, Danish, Finnish, Indonesian, Malay, Korean, Japanese, Chinese (Mandarin).

**Deepgram Nova-3** supports 60+ languages including everything Flux covers plus: Arabic, Hindi, Urdu, Bengali, Thai, Vietnamese, Hebrew, Farsi, Swahili, Tamil, Telugu, and many more.

> **Rule of thumb:** If your language works with Flux, use Flux — it's faster and has native turn detection. If not, use Nova-3.

### Multi-language agents with `phoneNumbers`

When you have different phone numbers per language/region, set per-number STT overrides. The server auto-derives turn detection and VAD from the STT provider:

| STT Provider | Turn Detection | VAD |
|---|---|---|
| `deepgram/flux` | Native (built-in) | Native (built-in) |
| `deepgram/nova-3` | Smart turn | Silero |
| `gladia/solaria` | Smart turn | Silero |

```typescript
const agent = pc.agent("global-support", {
  prompt: "You are a multilingual support agent.",
  llm: "openai/gpt-4.1-mini",
  phoneNumbers: [
    // English — Flux (fastest, native turn detection)
    { number: "+14155551234", language: "en", voice: "elevenlabs/sarah", stt: "deepgram/flux" },
    // Spanish — Flux multilingual
    { number: "+34612345678", language: "es", voice: "elevenlabs/valentina", stt: "deepgram/flux" },
    // Arabic — Nova-3 (Flux doesn't support Arabic)
    { number: "+972501234567", language: "ar", voice: "elevenlabs/ahmad", stt: "deepgram/nova-3" },
  ],
});
```

No need to configure turn detection or VAD manually — the server auto-derives them from the STT provider.

## Hot-reloading STT

You can swap STT providers at runtime:

```typescript
// Agent-wide (all future calls)
agent.update({ stt: "gladia/solaria" });

// One call only
call.update({ stt: "deepgram/nova-3" });
```

## What's next

- [Turn Detection](/concepts/turn-detection) — how Flux native vs SmartTurn + Silero work
- [TTS Providers](/reference/tts-providers)
- [LLM Providers](/reference/llm-providers)
- [`Agent.configure`](/api/agent)

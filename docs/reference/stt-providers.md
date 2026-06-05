---
title: "STT Providers"
description: "Speech-to-text providers, models, and tuning parameters."
---

# STT Providers

Pinecall supports multiple STT providers. You can use a short string shortcut or a full config object.

## Quick reference

```typescript
// Shortcuts — "provider/model" format (recommended)
{ stt: "deepgram/flux-en" }       // Flux English
{ stt: "deepgram/flux-multi" }    // Flux multilingual (10 languages)
{ stt: "deepgram/nova-3" }        // Nova-3
{ stt: "gladia/solaria" }         // Gladia Solaria
{ stt: "transcribe" }             // AWS Transcribe

// Bare provider (uses default model)
{ stt: "deepgram-flux" }          // same as "deepgram/flux-en"
{ stt: "deepgram" }               // same as "deepgram/nova-3"
{ stt: "gladia" }                 // same as "gladia/solaria"
```

## Naming convention

Configuration objects that pass through to providers keep **snake_case** to mirror what the receiving side expects (`endpointing_ms`, `interim_results`, etc.). This avoids an unnecessary translation layer and lets you copy-paste from provider docs directly.

## Deepgram Flux (recommended)

Best for real-time voice agents. Turn detection and VAD are **auto-derived** — no configuration needed.

```typescript
stt: {
  provider: "deepgram-flux",
  keyterms: ["pinecall"],      // boost recognition for specific terms
  eot_threshold: 0.5,          // end-of-turn sensitivity (0-1)
  eager_eot_threshold: 0.7,    // eager turn threshold
  eot_timeout_ms: 2000,
}
```

Shortcut: `"deepgram/flux-en"` or `"deepgram/flux-multi"` or `"deepgram-flux"`

> **Auto-derived:** Flux → native turn detection + native VAD. No need to specify `turnDetection`.

## Deepgram Nova

Classic STT. Turn detection and VAD auto-derived (smart_turn + silero).

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

Shortcut: `"deepgram/nova-3"` or `"deepgram"`

## Gladia

```typescript
stt: {
  provider: "gladia",
  model: "accurate",
  language: "en",
  endpointing: 300,
  speech_threshold: 0.8,
  code_switching: false,
  audio_enhancer: true,
}
```

Shortcut: `"gladia/solaria"` or `"gladia"`

## AWS Transcribe

```typescript
stt: {
  provider: "transcribe",
  language: "en-US",
}
```

Shortcut: `"transcribe"`

## Which to choose

| Provider | Best for | Trade-off |
|---|---|---|
| `deepgram-flux` | Real-time voice agents | Lowest latency, fewer languages |
| `deepgram` (nova-3) | Wide language support | Slightly higher latency than Flux |
| `gladia` | Code-switching, multilingual | Higher latency than Deepgram |
| `transcribe` | AWS-native deployments | AWS pricing model |

For most agents, start with `deepgram-flux`. Switch only if you need a language Flux doesn't support, or if you have specific accuracy requirements.

## Hot-reloading STT

You can swap STT providers at runtime:

```typescript
// Agent-wide (all future calls)
agent.configure({ stt: "gladia" });

// One call only
call.configure({ stt: "deepgram" });
```

## What's next

- [TTS Providers](/reference/tts-providers)
- [LLM Providers](/reference/llm-providers)
- [`Agent.configure`](/api/agent)

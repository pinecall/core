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

// ── Bring-your-own-key only (add your key under Provider Keys first) ──
{ stt: "cartesia/ink-whisper" }      // Cartesia Ink-Whisper
{ stt: "elevenlabs/scribe" }         // ElevenLabs Scribe v2 (realtime)
{ stt: "assemblyai/universal" }      // AssemblyAI Universal-3
{ stt: "soniox/realtime" }           // Soniox real-time (BYOK)
```

## Managed vs bring-your-own-key (BYOK)

Some providers work out of the box on Pinecall's managed keys; the newer ones
require **your own API key** (saved under **Provider Keys** in the dashboard). This
split is data-driven from the rate table — see [Managed vs BYOK](/reference/managed-vs-byok)
for the full list and the live `GET /api/rates/models` query.

| STT provider | Managed (no key needed) | Notes |
|---|---|---|
| `deepgram` (flux/nova) | ✅ Yes | Default, recommended |
| `gladia` | ✅ Yes | |
| `transcribe` (AWS) | ✅ Yes | |
| `cartesia` (ink-whisper) | ✅ Yes | Same key as Cartesia TTS — Pinecall hosts it |
| `elevenlabs` (scribe) | ✅ Yes | Same key as ElevenLabs TTS — Pinecall hosts it |
| `assemblyai` (universal) | ❌ BYOK only | Add an AssemblyAI key |
| `soniox` (realtime) | ❌ BYOK only | One Soniox key = STT **and** TTS |

> **BYOK enforcement:** if you configure a BYOK-only STT provider and your org has
> not saved a key for it, **agent registration is rejected** with
> `PROVIDER_KEY_REQUIRED` — Pinecall never falls back to its own key for these.
> When you bring your own key, that usage is billed by the provider directly and is
> **not** deducted from your Pinecall credits.

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

## Cartesia Ink-Whisper

Pairs naturally with Cartesia (Sonic) TTS for a single-vendor voice stack.
**Managed** — the same Cartesia key serves TTS and STT, and Pinecall hosts it (or
bring your own Cartesia key to bill it directly).

```typescript
stt: "cartesia/ink-whisper"
// or
stt: { provider: "cartesia", model: "ink-whisper", language: "en" }
```

## ElevenLabs Scribe

Realtime `scribe_v2_realtime`. **Managed** — uses the same ElevenLabs key as
ElevenLabs TTS, which Pinecall hosts (or bring your own ElevenLabs key).

```typescript
stt: "elevenlabs/scribe"
// or with tuning
stt: {
  provider: "elevenlabs",
  model: "scribe_v2_realtime",
  language: "en",
  commit_strategy: "vad",   // "vad" (server segments turns) | "manual"
}
```

## AssemblyAI (BYOK)

Universal-3 streaming (`u3-rt-pro`) — strong accuracy + diarization. **BYOK only** —
Pinecall hosts no AssemblyAI key, so add your own under Provider Keys.

```typescript
stt: "assemblyai/universal"
// or with tuning
stt: {
  provider: "assemblyai",
  model: "u3-rt-pro",
  language: "en",
  format_turns: true,   // punctuated/cased final transcripts
}
```

## Soniox (BYOK)

Real-time multilingual STT (60+ languages). One Soniox key serves **both** Soniox
STT and TTS. Requires your own Soniox key.

```typescript
stt: "soniox/realtime"
// or
stt: { provider: "soniox", model: "stt-rt-v5", language: "en" }
```

## Which to choose

| Provider | Best for | Trade-off |
|---|---|---|
| `deepgram/flux` | Real-time voice agents | Lowest latency; English, Spanish, French, German, Portuguese, and ~15 more |
| `deepgram/nova-3` | Arabic, Hindi, Thai, CJK, and 60+ languages | Slightly higher latency; smart_turn + silero VAD |
| `gladia/solaria` | Code-switching, multilingual | Higher latency than Deepgram |
| `transcribe` | AWS-native deployments | AWS pricing model |
| `cartesia/ink-whisper` | Single-vendor with Cartesia TTS | Managed (shared key) |
| `elevenlabs/scribe` | Single-vendor with ElevenLabs TTS | Managed (shared key) |
| `assemblyai/universal` | Accuracy + diarization | BYOK only |
| `soniox/realtime` | Multilingual (60+), single-vendor with Soniox TTS | BYOK only |

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
  llm: "openai/gpt-5-chat-latest",
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

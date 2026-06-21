---
title: "Managed vs Bring-Your-Own-Key"
description: "Which STT/TTS/LLM models Pinecall serves with its own keys, and which require yours."
---

# Managed vs Bring-Your-Own-Key (BYOK)

Every STT, TTS and LLM model on Pinecall is one of two kinds:

- **Managed** — Pinecall serves it with **its own provider key**. You don't add
  anything; usage is deducted from your Pinecall **credits**.
- **BYOK (bring your own key)** — Pinecall does **not** host a key for it. You must
  save your **own** API key under **Provider Keys**. That usage is billed by the
  provider **directly** and is **not** deducted from your Pinecall credits.

> This split is **data-driven** — it comes from the Pinecall **rate table** in the
> database (each rate has a `managed` flag), not from a hardcoded list. The tables
> below are the current state; query the API (below) for the authoritative, live list.

## What Pinecall provides managed (no key needed)

| Service | Managed providers |
|---|---|
| **STT** | `deepgram` (flux, nova-3), `gladia`, `transcribe` (AWS) |
| **TTS** | `elevenlabs`, `cartesia` (sonic), `polly` (AWS) |
| **LLM** | `openai`, `anthropic`, `google` (gemini), `mistral` |

## What requires your own key (BYOK)

| Service | BYOK-only providers |
|---|---|
| **STT** | `cartesia` (ink-whisper), `elevenlabs` (scribe), `assemblyai` |
| **TTS** | `rime` |
| **LLM** | `xai` (grok), `groq`, `cerebras`, `deepseek`, `openrouter` |

> Note a provider can be **managed for one service and BYOK for another** — e.g.
> Cartesia **TTS** (sonic) is managed, but Cartesia **STT** (ink-whisper) is BYOK.
> ElevenLabs **TTS** is managed, ElevenLabs **STT** (scribe) is BYOK.

## Check it from the API (authoritative, live)

The rate table is the source of truth. Query it any time:

```bash
curl https://playground.pinecall.io/api/rates/models
```

```jsonc
{
  "models": [
    { "service": "stt", "provider": "deepgram",   "model": "nova-3",      "managed": true  },
    { "service": "stt", "provider": "assemblyai",  "model": "universal",   "managed": false },
    { "service": "llm", "provider": "xai",         "model": "grok-4",      "managed": false },
    { "service": "tts", "provider": "rime",        "model": "mistv2",      "managed": false }
    // ...
  ],
  "managedProviders": {
    "stt": ["deepgram", "gladia", "transcribe"],
    "tts": ["cartesia", "elevenlabs", "polly"],
    "llm": ["anthropic", "google", "mistral", "openai"]
  }
}
```

`managed: true` → usable with no key. `managed: false` → add your own key.

## BYOK enforcement

If you configure a BYOK-only provider and your org has **not** saved a key for it,
**agent registration is rejected** with code `PROVIDER_KEY_REQUIRED`:

```
LLM provider 'xai' requires your own API key. Pinecall does not provide a managed
key for 'xai' — add your key under Provider Keys in the dashboard, then reconnect.
```

Pinecall never silently falls back to its own key for a BYOK provider.

## Add your own key

- **Dashboard** → **Provider Keys** → pick the provider, paste the key.
- **API**: `PUT /api/credentials` with `{ "provider": "xai", "apiKey": "..." }`.

One key can cover multiple services where a provider shares it — e.g. an
**ElevenLabs** key enables both ElevenLabs TTS and ElevenLabs Scribe STT; a
**Cartesia** key enables Sonic TTS and Ink-Whisper STT.

## What's next

- [STT Providers](/reference/stt-providers)
- [TTS Providers](/reference/tts-providers)
- [LLM Providers](/reference/llm-providers)

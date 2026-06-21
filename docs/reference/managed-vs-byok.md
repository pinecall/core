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
| **STT** | `deepgram` (flux, nova-3), `gladia`, `transcribe` (AWS), `cartesia` (ink-whisper), `elevenlabs` (scribe) |
| **TTS** | `elevenlabs`, `cartesia` (sonic), `polly` (AWS) |
| **LLM** | `openai`, `anthropic`, `google` (gemini), `mistral` |

> **One key, both services:** an ElevenLabs (or Cartesia) key serves *both* that
> vendor's TTS and STT. Pinecall already holds those keys for the managed TTS, so
> their STT (ElevenLabs **Scribe**, Cartesia **Ink-Whisper**) is **also managed** —
> no key needed.

## What requires your own key (BYOK)

| Service | BYOK-only providers |
|---|---|
| **STT** | `assemblyai`, `soniox`, `xai` (Grok) |
| **TTS** | `rime`, `soniox`, `xai` (Grok voices) |
| **LLM** | `xai` (grok), `groq`, `cerebras`, `deepseek`, `openrouter` |

> One key covers multiple services: a **Soniox** key = STT + TTS; an **xAI** key =
> Grok **LLM + TTS + STT**.

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
    "stt": ["cartesia", "deepgram", "elevenlabs", "gladia", "transcribe"],
    "tts": ["cartesia", "elevenlabs", "polly"],
    "llm": ["anthropic", "google", "mistral", "openai"]
  }
}
```

`managed: true` → usable with no key. `managed: false` → add your own key.

## Check a user's access to a model (SDK / API)

Before configuring an agent, check whether the org can actually use a model —
it combines all three gates (model exists · allowed on the org's plan · managed
or BYOK-key-present):

```ts
import { fetchModelAccess, hasModelAccess, fetchModelCatalog } from "@pinecall/sdk";

const a = await fetchModelAccess({ service: "tts", model: "eleven_multilingual_v2" });
// { allowed, reason, provider, managed, planAllowed, hasKey, requiresKey }

if (!(await hasModelAccess({ service: "llm", model: "grok-4" }))) {
  // reason: "byok_key_required" → tell the user to add their xAI key
}

const all = await fetchModelCatalog();   // access for every priced model
```

Reads `PINECALL_API_KEY` (override with `apiKey`). Raw endpoint:

```bash
curl "https://playground.pinecall.io/api/models/access?service=tts&model=eleven_multilingual_v2" \
  -H "Authorization: Bearer pk_…"
```

`reason` is one of `ok` · `unknown_model` · `plan_restricted` · `byok_key_required`.

## BYOK enforcement

If you configure a BYOK-only provider and your org has **not** saved a key for it,
**agent registration is rejected** with code `PROVIDER_KEY_REQUIRED`:

```
LLM provider 'xai' requires your own API key. Pinecall does not provide a managed
key for 'xai' — add your key under Provider Keys in the dashboard, then reconnect.
```

Pinecall never silently falls back to its own key for a BYOK provider.

## Plan limits & model allow-list

Two more gates are enforced at agent registration, both rejecting with
`MODEL_NOT_ALLOWED`:

1. **Must be a priced model in the DB.** Any STT/TTS/LLM model you declare must exist
   in the rate table (be a known, priced model) — unknown models are rejected.
2. **Must be allowed on your plan.** Plans can restrict which models a tier may use.
   For example, the **free tier can use ElevenLabs flash + multilingual, but not the
   pricier models** (and Cartesia/Polly in full). Paid plans allow everything priced.

Use the access check above (`fetchModelAccess` / `GET /api/models/access`) to see the
verdict and `reason` (`plan_restricted`, `unknown_model`, …) before connecting.

## Add your own key

- **Dashboard** → **Provider Keys** → pick the provider, paste the key.
- **API**: `PUT /api/credentials` with `{ "provider": "xai", "apiKey": "..." }`.

One key can cover multiple services where a provider shares it — e.g. an
**ElevenLabs** key enables both ElevenLabs TTS and ElevenLabs Scribe STT; a
**Cartesia** key enables Sonic TTS and Ink-Whisper STT.

## Operators: flip a provider managed ↔ BYOK

The managed/BYOK status of any provider is a single DB flag (`rate.managed`) and is
the source of truth — flipping it takes effect **immediately** (next session / page
load), no deploy or re-seed:

```bash
# Pinecall provides it (no token needed) — requires <PROVIDER>_API_KEY on the box:
npx tsx scripts/set-managed.ts assemblyai true

# Force bring-your-own-key (the user must add their token):
npx tsx scripts/set-managed.ts assemblyai false

# Per service (e.g. only Cartesia STT):
npx tsx scripts/set-managed.ts cartesia false stt
```

Enabling managed only works if Pinecall actually holds that provider's key in the
prod `.env` (`shipway env` to check); otherwise leave it BYOK.

## What's next

- [STT Providers](/reference/stt-providers)
- [TTS Providers](/reference/tts-providers)
- [LLM Providers](/reference/llm-providers)

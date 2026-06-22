---
title: "Turn Detection"
description: "How Pinecall detects when the user finishes speaking and manages conversation turns."
---

# Turn Detection

Turn detection is the core of a natural voice conversation — knowing **when the user has finished speaking** so the agent can respond, without cutting them off or waiting too long.

Pinecall supports two turn detection strategies, automatically selected based on your STT provider:

| STT Provider | Turn Detection | VAD | How it works |
|---|---|---|---|
| `deepgram/flux` | **Native** | **Native** | Flux has built-in turn detection — it analyzes the audio stream and emits `EagerEndOfTurn` / `EndOfTurn` signals directly. Zero extra latency. |
| `deepgram/nova-3` | **Smart Turn** | **Silero** | External ML-based turn detection. Silero VAD detects speech start/stop, then SmartTurn analyzes context to decide if the user is done. |
| `gladia/solaria` | **Smart Turn** | **Silero** | Same as Nova-3 — Silero VAD + SmartTurn. |
| `transcribe` | **Smart Turn** | **Silero** | Same as Nova-3 — Silero VAD + SmartTurn. |

> **You never configure this manually.** The server auto-derives the turn detection strategy from the STT provider. Just set `stt` and the rest follows.

> **Not to be confused with `detectTurnEnd`.** `detectTurnEnd` is a *separate*, real option on `agent.dial()` and `agent.bridge()` — it does **not** configure the turn-detection strategy. It controls **when your greeting is delivered**: by default (`false`) the greeting is spoken immediately on pickup (good for humans); set it to `true` to wait for the **other side** (a bot/IVR/answering machine that greets first) to finish its own greeting before speaking yours. When `true`, the other party's end-of-turn is also relayed to your code as a `turn.end` event, so code that drives the call manually (e.g. a test/judge agent) knows when to speak. Default `false` for `dial`, `true` for `bridge`. See [Outbound Calls → `detectTurnEnd`](/guides/outbound-calls#detectturnend--wait-for-the-other-sides-greeting-before-speaking).

## How Flux native turn detection works

Flux processes the audio stream and detects turns at the STT level — no separate VAD or turn analysis needed. It emits two signals:

```
User speaks → Flux transcribes in real-time
         ↓
   EagerEndOfTurn (high confidence the user paused)
         ↓
   SDK receives eager.turn → shows live text in UI
         ↓
   EndOfTurn (confirmed: user is done)
         ↓
   SDK receives turn.end → LLM generates response → TTS speaks
```

**Key Flux parameters** (tuneable via full STT config):

| Parameter | Default | Description |
|---|---|---|
| `eot_threshold` | `0.7` | End-of-turn confidence. Higher = more patient before confirming END. |
| `eager_eot_threshold` | `0.5` | Eager turn threshold. Lower = more aggressive early detection. |
| `eot_timeout_ms` | `1000` | Max silence before forcing END regardless of threshold. |

```typescript
// Default — Flux auto-tunes everything
stt: "deepgram/flux"

// Tune for slower, more patient turn detection
stt: {
  provider: "deepgram-flux",
  eot_threshold: 0.8,        // more patient
  eot_timeout_ms: 2000,      // wait longer in silence
}
```

## How Smart Turn + Silero VAD works

For non-Flux providers (Nova-3, Gladia, Transcribe), the server uses a two-stage pipeline:

### Stage 1: Silero VAD (Voice Activity Detection)

Silero is a local ML model that runs on every audio frame (32ms chunks). It detects **when the user starts and stops speaking** — nothing more.

```
Audio frame → Silero model → confidence score (0.0 – 1.0)
                                    ↓
                            Above threshold? → SPEAKING
                            Below threshold? → SILENCE detected
                                    ↓
                            After 350ms silence → trigger Stage 2
```

Silero parameters (auto-configured, no user tuning needed):

| Parameter | Default | What it does |
|---|---|---|
| `threshold` | `0.5` | Voice confidence cutoff |
| `min_speech_ms` | `250` | Minimum speech duration to count as real speech |
| `min_silence_ms` | `350` | Silence duration before triggering turn analysis |
| `speech_end_delay_ms` | `300` | Delay before emitting `speech.ended` |

### Stage 2: SmartTurn (Turn Analysis)

When Silero detects silence, SmartTurn analyzes the accumulated transcript to decide: **is the user done, or just pausing?**

```
Silero detects 350ms silence
         ↓
SmartTurn analyzes transcript context
         ↓
  ┌──────┴──────┐
  │             │
turn.end     turn.pause
(user done)  (user pausing — keep listening)
```

SmartTurn uses a small ML model to understand conversational patterns. For example:

- "What time does the" → `turn.pause` (incomplete sentence)
- "I need to book an appointment" → `turn.end` (complete thought)
- "Yeah" → `turn.end` (acknowledgment)
- "So I was thinking about maybe" → `turn.pause` (trailing off)

SmartTurn parameters:

| Parameter | Default | What it does |
|---|---|---|
| `smart_turn_threshold` | `0.7` | Higher = more patient (needs higher confidence to end) |
| `max_silence_seconds` | `2.0` | Force turn.end after this much silence regardless |

## The turn state machine

Both strategies feed into the same turn controller state machine:

![Turn detection state machine](/assets/diagrams/turn-state-machine.png)

## Barge-in (interruption)

When the user speaks while the bot is talking, the turn controller handles **barge-in**:

![Barge-in decision tree](/assets/diagrams/bargein-decision.png)

**Barge-in parameters** (configurable via `interruption`):

```typescript
const agent = pc.agent("support", {
  llm: "openai/gpt-5-chat-latest",
  stt: "deepgram/flux",
  // Barge-in config (optional — defaults are good for most cases)
  interruption: {
    energy_threshold_db: -40, // dB threshold (higher = stricter)
    min_duration_ms: 300,     // min speech duration before interrupting
  },
});
```

| Config | Default | Behavior |
|---|---|---|
| `-50 dB, 200ms` | — | Very sensitive — reacts to soft speech quickly |
| `-40 dB, 300ms` | ✅ Default | Balanced — filters noise, responds to clear speech |
| `-35 dB, 400ms` | — | Strict — requires louder, longer speech to interrupt |
| `false` | — | Disabled — bot never gets interrupted |

```typescript
// Disable barge-in entirely
interruption: false
```

## SDK events

These events fire on the `Agent` and `Call` objects:

| Event | When | Data |
|---|---|---|
| `speech.started` | VAD detects voice | `{ turnId, confidence }` |
| `user.speaking` | Interim transcript available | `{ text, confidence }` |
| `user.message` | Final transcript confirmed | `{ text, messageId, turnId }` |
| `turn.end` | User finished speaking | `{ turnId, probability }` |
| `turn.pause` | User might continue (SmartTurn only) | `{ turnId, probability }` |
| `bot.speaking` | Bot starts TTS playback | `{ messageId, text }` |
| `bot.finished` | Bot finishes speaking | `{ messageId, durationMs }` |
| `bot.interrupted` | User interrupted the bot | `{ messageId, playedMs, reason }` |

### Typical event flow

```
speech.started        → user starts talking
user.speaking         → "I need to..." (interim)
user.speaking         → "I need to book an..." (interim, updated)
user.message          → "I need to book an appointment" (final)
turn.end              → user is done
bot.speaking          → "Sure! When would you like to come in?"
bot.finished          → bot done speaking
speech.started        → user starts again...
```

## Multi-language: mixing Flux and Nova-3

When you have phone numbers in different languages, some may use Flux (native turn detection) and others Nova-3 (SmartTurn + Silero). Just set the `stt` provider — **the server auto-configures everything else**:

```typescript
const agent = pc.agent("global-support", {
  prompt: "You are a multilingual support agent.",
  llm: "openai/gpt-5-chat-latest",
  phoneNumbers: [
    // English — Flux (native turn detection, lowest latency)
    { number: "+14155551234", language: "en", voice: "elevenlabs/sarah", stt: "deepgram/flux" },
    // Spanish — Flux multilingual (native turn detection)
    { number: "+34612345678", language: "es", voice: "elevenlabs/valentina", stt: "deepgram/flux" },
    // Arabic — Nova-3 → server auto-activates SmartTurn + Silero
    { number: "+972501234567", language: "ar", voice: "elevenlabs/ahmad", stt: "deepgram/nova-3" },
  ],
});
```

The turn detection strategy switches **per call** based on which phone number was called. English and Spanish callers get Flux's native turn detection. Arabic callers get SmartTurn + Silero. **You never configure turn detection or VAD manually** — the server derives them from the STT provider automatically.

> **Why auto-derive?** Turn detection and VAD are tightly coupled to the STT provider. Flux has built-in turn signals that are faster and more accurate than any external system. Nova-3 doesn't, so the server adds SmartTurn + Silero. Exposing this as manual config would create footgun combinations (e.g. Flux with Silero VAD) that degrade quality.

## What's next

- [Example: Turn Detection](/examples/turn-detection) — runnable debug tool showing every event
- [STT Providers](/reference/stt-providers) — full provider reference with tuning parameters
- [Hot-reload](/concepts/hot-reload) — swap STT provider mid-call
- [Events reference](/reference/events) — all turn-related events

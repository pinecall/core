---
title: "Example: Turn Detection"
description: "Debug turn events in real-time — per-turn containers showing the full state machine lifecycle."
---

# Example: Turn Detection

A dev-friendly debug tool that shows **every turn event in real-time**, grouped into visual containers that mirror the server-side turn state machine. Each turn container shows state transitions as they happen.

## State machine

The server maintains a 5-state machine for every call:

```
IDLE ──vad_start──→ LISTENING ──vad_silence──→ ANALYZING
  ↑                     ↑                         │
  │                     │ analysis_pause           │ analysis_end
  │                     └─────────────────────────←┘
  │                                                │
  │                                                ↓
  │                                          BOT_PENDING
  │                                                │
  │                                     bot_reply_start
  │                                                │
  │                                                ↓
  └──────bot_finished──────────────────── BOT_SPEAKING
                                                   │
                           barge_in ──────────────→ LISTENING
                           (< 2s = continuation, ≥ 2s = new turn)
```

## What you'll see

Each turn is rendered as a bordered container:

```
    ┌ Turn #1  ·  IDLE → LISTENING                     08:53:08.000
    │  🎙  speech.started
    │  💬  "Hola, ¿qué tal?"
    │  📝  "Hola. ¿Qué tal?"
    │
    │  LISTENING → BOT_PENDING  prob=96%
    │
    │  BOT_PENDING → BOT_SPEAKING
    │  🤖  bot.speaking  "..."
    │  🗣  "¡Hola! Estoy bien, gracias. ¿Y tú?"
    │  📨  message.confirmed
    │  🔇  bot.finished  3846ms
    │
    └ 4.2s
```

### Interruptions (barge-in)

When the user cuts off the bot, a highlighted interruption section appears:

```
    ┌ Turn #3  ·  IDLE → LISTENING                     08:54:01.000
    │  🎙  speech.started
    │  📝  "Cuéntame un cuento largo"
    │
    │  LISTENING → BOT_PENDING  prob=95%
    │
    │  BOT_PENDING → BOT_SPEAKING
    │  🤖  bot.speaking  "..."
    │  🗣  "Érase una vez, en un reino muy lejano..."
    │
    ├─── ⚡ INTERRUPTION ─────────────────────────────
    │  BOT_SPEAKING → LISTENING  barge-in after 2100ms
    │  🗣  said: "Érase una vez, en un reino muy lejano..."
    │  ↻  continuation — user keeps talking
    │
    │  💬  "No, algo más corto"
    │  📝  "No, algo más corto"
    │
    │  LISTENING → BOT_PENDING  prob=97%
    │
    │  BOT_PENDING → BOT_SPEAKING
    │  🤖  bot.speaking  "..."
    │  🗣  "¡Claro! Había una vez un gato que..."
    │  🔇  bot.finished  3200ms
    │
    └ 12.4s
```

## The code

The key pattern: a `turn` tracker object that maps SDK events to server states:

```typescript
const turn = {
  id: 0, state: "IDLE", startTime: null, open: false,

  log(icon, detail) {
    console.log(`    │  ${icon}  ${detail}`);
  },
  transition(to, extra = "") {
    const arrow = `${this.state} → ${to}`;
    this.state = to;
    console.log(`    │\n    │  ${arrow}  ${extra}\n    │`);
  },
  start(turnId) {
    this.id = turnId;
    this.state = "LISTENING";
    this.startTime = Date.now();
    this.open = true;
    console.log(`\n    ┌ Turn #${this.id}  ·  IDLE → LISTENING`);
  },
  end() {
    const dur = ((Date.now() - this.startTime) / 1000).toFixed(1);
    this.state = "IDLE";
    this.open = false;
    console.log(`    └ ${dur}s`);
  },
};

// Map events to state transitions
agent.on("speech.started", (e) => { turn.start(e.turnId); });
agent.on("user.message", (e) => { turn.log("📝", `"${e.text}"`); });
agent.on("turn.end", () => { turn.transition("BOT_PENDING"); });
agent.on("bot.speaking", () => { turn.transition("BOT_SPEAKING"); });
agent.on("bot.word", (e, call) => { /* live preview via call.currentBotText */ });
agent.on("bot.finished", () => { turn.end(); });
agent.on("bot.interrupted", (e, call) => {
  // Render interruption divider, show what was said
  turn.interruption(e.playedMs, e.reason, call.currentBotText);
});
```

The full runnable version is in [`examples/turn-detection/server.js`](https://github.com/pinecall/sdk/tree/master/examples/turn-detection) — with ANSI colors, timestamps, and the state machine diagram in the startup banner.

## Run it

```bash
cd examples/turn-detection
cp .env.example .env    # edit with your API key and phone number
node server.js
```

## Configuration

Set in `.env`:

| Variable | Default | Description |
|---|---|---|
| `PINECALL_API_KEY` | required | Your API key |
| `PHONE` | required | Phone number to register |
| `MODEL` | `nova` | `nova` → SmartTurn + Silero, `flux` → native turns |
| `STT_LANG` | `es` | Language code (`en`, `es`, `ar`, `fr`, `de`, `pt`) |

## State transitions to observe

| SDK Event | State Before | State After | Notes |
|---|---|---|---|
| `speech.started` | IDLE | LISTENING | New turn opens |
| `turn.pause` | LISTENING | LISTENING | SmartTurn analyzing (nova only) |
| `turn.end` | LISTENING | BOT_PENDING | User finished, LLM fires |
| `bot.speaking` | BOT_PENDING | BOT_SPEAKING | TTS audio starts |
| `bot.finished` | BOT_SPEAKING | IDLE | Turn closes |
| `bot.interrupted` | BOT_SPEAKING | LISTENING | Barge-in, user keeps talking |

## What's next

- [Turn Detection guide](/concepts/turn-detection) — full explanation of the state machine
- [STT Providers](/reference/stt-providers) — language coverage and tuning parameters
- [Events reference](/reference/events) — all events including `bot.word` and `currentBotText`

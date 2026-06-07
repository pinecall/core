/**
 * Pinecall — Turn Detection Example
 *
 * Debug turn detection events in real-time. Shows every event from the
 * turn state machine so you can see exactly how Flux vs SmartTurn works.
 *
 * Each turn is rendered as a bordered container showing the full
 * state machine lifecycle: IDLE → LISTENING → ANALYZING → BOT_PENDING →
 * BOT_SPEAKING → IDLE, with interruptions highlighted.
 *
 * Config via .env:
 *   PHONE  — phone number to register
 *   MODEL  — "flux" (native turns) or "nova" (SmartTurn + Silero)
 *   STT_LANG — language code: "en", "es", "ar", etc.
 *
 * The STT provider, voice, and turn detection are auto-derived:
 *   MODEL=flux  → deepgram/flux   → native turn detection + native VAD
 *   MODEL=nova  → deepgram/nova-3 → SmartTurn + Silero VAD (auto on server)
 */

import "dotenv/config";
import { Pinecall } from "@pinecall/sdk";

// ── Config from env ──────────────────────────────────────────────────────

const PHONE = process.env.PHONE;
const MODEL = (process.env.MODEL || "flux").toLowerCase();
const LANG = process.env.STT_LANG || "en";

if (!PHONE) {
  console.error("Missing PHONE in .env (e.g. PHONE=+15551234567)");
  process.exit(1);
}

// Auto-derive STT and voice from MODEL + LANG
const STT = MODEL === "nova" ? "deepgram/nova-3" : "deepgram/flux";

const VOICES = {
  en: "elevenlabs/sarah",
  es: "elevenlabs/valentina",
  ar: "elevenlabs/ahmad",
  fr: "elevenlabs/claire",
  de: "elevenlabs/anna",
  pt: "elevenlabs/gabriela",
};
const VOICE = VOICES[LANG] || VOICES.en;

const TURN_INFO = MODEL === "nova"
  ? "SmartTurn + Silero (auto-activated by server)"
  : "Native (built into Flux)";

// ── ANSI Colors ─────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
};

function ts() {
  return new Date().toISOString().slice(11, 23);
}

// ── Turn tracker ────────────────────────────────────────────────────────
//
// Maps SDK events to the server-side state machine:
//
//   IDLE ──vad_start──→ LISTENING ──vad_silence──→ ANALYZING
//     ↑                     ↑                         │
//     │                     │ analysis_pause           │ analysis_end
//     │                     └─────────────────────────←┘
//     │                                                │
//     │                                                ↓
//     │                                          BOT_PENDING
//     │                                                │
//     │                                     bot_reply_start
//     │                                                │
//     │                                                ↓
//     └──────bot_finished──────────────────── BOT_SPEAKING
//                                                      │
//                              barge_in ───────────────→ LISTENING
//                              (< 2s = continuation, ≥ 2s = new turn)
//

const turn = {
  id: 0,
  state: "IDLE",
  startTime: null,
  open: false,
  _preview: false, // true when a bot.word preview line is active

  /** Clear the bot.word preview line if active. */
  clearPreview() {
    if (this._preview) {
      process.stdout.write("\r" + " ".repeat(120) + "\r");
      this._preview = false;
    }
  },

  /** Log a line inside the current turn container. */
  log(icon, detail, color = C.white) {
    this.clearPreview();
    console.log(`    ${C.cyan}│${C.reset}  ${icon}  ${color}${detail}${C.reset}`);
  },

  /** Show a state transition arrow. */
  transition(to, extra = "") {
    this.clearPreview();
    const from = this.state;
    this.state = to;
    const arrow = `${C.dim}${from}${C.reset} → ${C.cyan}${C.bold}${to}${C.reset}`;
    console.log(`    ${C.cyan}│${C.reset}`);
    console.log(`    ${C.cyan}│${C.reset}  ${arrow}  ${C.dim}${extra}${C.reset}`);
  },

  /** Open a new turn container. */
  start(turnId) {
    this.clearPreview();
    // Close previous if still open
    if (this.open) this.end();

    this.id = turnId || this.id + 1;
    const prev = this.state;
    this.state = "LISTENING";
    this.startTime = Date.now();
    this.open = true;
    console.log();
    console.log(
      `    ${C.cyan}┌ Turn #${this.id}${C.reset}  ·  ` +
      `${C.dim}${prev} → LISTENING${C.reset}` +
      `${"".padEnd(20)}${C.dim}${ts()}${C.reset}`
    );
  },

  /** Close the current turn container. */
  end() {
    this.clearPreview();
    if (!this.open) return;
    const dur = ((Date.now() - this.startTime) / 1000).toFixed(1);
    console.log(`    ${C.cyan}│${C.reset}`);
    console.log(`    ${C.cyan}└${C.reset} ${C.dim}${dur}s${C.reset}`);
    this.open = false;
    this.state = "IDLE";
  },

  /** Render an interruption divider. */
  interruption(playedMs, reason, spokenText) {
    this.clearPreview();
    console.log(`    ${C.cyan}│${C.reset}`);
    console.log(`    ${C.cyan}├${C.red}─── ⚡ INTERRUPTION ${"─".repeat(38)}${C.reset}`);
    const arrow = `${C.dim}BOT_SPEAKING${C.reset} → ${C.yellow}${C.bold}LISTENING${C.reset}`;
    console.log(`    ${C.cyan}│${C.reset}  ${arrow}  ${C.dim}barge-in after ${playedMs}ms — ${reason}${C.reset}`);
    if (spokenText) {
      const preview = spokenText.slice(0, 55);
      console.log(`    ${C.cyan}│${C.reset}  ${C.dim}🗣  said: "${preview}${preview.length >= 55 ? "..." : ""}"${C.reset}`);
    }
    console.log(`    ${C.cyan}│${C.reset}  ${C.yellow}↻  continuation — user keeps talking${C.reset}`);
    this.state = "LISTENING";
  },
};

// ── Pinecall setup ───────────────────────────────────────────────────────

const pc = new Pinecall();
await pc.connect();

const agent = pc.agent("turn-debug", {
  llm: "openai/gpt-4.1-mini",
  stt: STT,
  voice: VOICE,
  language: LANG,
  prompt:
    "You are a friendly assistant. Keep your responses to 1-2 sentences since this is a voice call. Respond in the same language the user speaks.",
  phoneNumber: PHONE,
});

// ── Call lifecycle ───────────────────────────────────────────────────────

agent.on("call.started", (call) => {
  console.log(
    `\n${"─".repeat(60)}\n  📞 Call started: ${call.from} → ${call.to}\n${"─".repeat(60)}`,
  );
  const greetings = {
    en: "Hello! Talk naturally and watch the turn events in the console.",
    es: "¡Hola! Habla con naturalidad y observa los eventos de turno en la consola.",
    ar: "مرحبا! تحدث بشكل طبيعي وراقب أحداث الدور في وحدة التحكم.",
    fr: "Bonjour! Parlez naturellement et regardez les événements dans la console.",
  };
  call.say(greetings[LANG] || greetings.en);
});

agent.on("call.ended", (call, reason) => {
  if (turn.open) turn.end();
  console.log(
    `\n${"─".repeat(60)}\n  📞 Call ended: ${reason} (${Math.round(call.duration)}s)\n${"─".repeat(60)}\n`,
  );
});

// ── User speech (IDLE → LISTENING) ──────────────────────────────────────

agent.on("speech.started", (event) => {
  // Only start a new turn container if we're idle
  if (!turn.open) {
    turn.start(event.turnId);
  }
  turn.log("🎙", "speech.started", C.cyan);
});

agent.on("user.speaking", (event) => {
  if (!turn.open) return;
  turn.log("💬", `"${event.text}"`, C.dim);
});

agent.on("user.message", (event) => {
  if (!turn.open) return;
  turn.log("📝", `"${event.text}"`, C.green);
});

// ── Turn analysis (LISTENING → ANALYZING → BOT_PENDING) ─────────────────

agent.on("turn.pause", (event) => {
  if (!turn.open) return;
  const prob = (event.probability * 100).toFixed(0);
  turn.log("⏸ ", `turn.pause — prob=${prob}% — waiting for more speech...`, C.yellow);
});

agent.on("turn.end", (event) => {
  if (!turn.open) return;
  const prob = (event.probability * 100).toFixed(0);
  turn.transition("BOT_PENDING", `prob=${prob}%`);
});

// ── Bot speech (BOT_PENDING → BOT_SPEAKING → IDLE) ──────────────────────

agent.on("bot.speaking", (event) => {
  if (!turn.open) {
    // Greeting — bot speaks before any user turn
    const preview = event.text ? `"${event.text.slice(0, 55)}..."` : `"..."`;
    console.log(`\n  ${C.dim}${ts()}${C.reset}  🤖  ${C.blue}greeting${C.reset}  ${preview}`);
    return;
  }
  turn.transition("BOT_SPEAKING");
  const preview = event.text ? `"${event.text.slice(0, 55)}..."` : `"..."`;
  turn.log("🤖", `bot.speaking  ${preview}`, C.blue);
});

agent.on("bot.word", (event, call) => {
  if (!turn.open) return;
  turn._preview = true;
  const preview = call.currentBotText.slice(0, 65);
  process.stdout.write(
    `\r    ${C.cyan}│${C.reset}  🗣  ${C.blue}"${preview}${preview.length >= 65 ? "..." : ""}"${C.reset}${" ".repeat(20)}`
  );
});

agent.on("bot.finished", (event, call) => {
  if (!turn.open) {
    // Greeting finished
    console.log(`  ${C.dim}${ts()}${C.reset}  🔇  ${C.dim}greeting finished (${event.durationMs}ms)${C.reset}`);
    return;
  }
  const preview = call.currentBotText?.slice(0, 55);
  if (preview) {
    turn.log("🗣", `"${preview}${preview.length >= 55 ? "..." : ""}"`, C.blue);
  }
  turn.log("🔇", `bot.finished  ${C.dim}${event.durationMs}ms`, C.dim);
  turn.end();
});

// ── Interruption (BOT_SPEAKING → LISTENING) ─────────────────────────────

agent.on("bot.interrupted", (event, call) => {
  if (!turn.open) return;
  turn.interruption(event.playedMs, event.reason, call.currentBotText);
});

// ── Message confirmed ───────────────────────────────────────────────────

agent.on("message.confirmed", (event) => {
  if (!turn.open) return;
  turn.log("📨", `message.confirmed`, C.magenta);
});

// ── Turn continued (barge-in continuation) ──────────────────────────────

agent.on("turn.continued", () => {
  // State already updated by bot.interrupted handler
});

// ── Ready ────────────────────────────────────────────────────────────────

console.log(`
  ┌──────────────────────────────────────────────────┐
  │         Pinecall — Turn Detection Demo           │
  ├──────────────────────────────────────────────────┤
  │  Phone:    ${PHONE.padEnd(38)}│
  │  STT:      ${STT.padEnd(38)}│
  │  Language: ${LANG.padEnd(38)}│
  │  Voice:    ${VOICE.padEnd(38)}│
  │  Turns:    ${TURN_INFO.padEnd(38)}│
  ├──────────────────────────────────────────────────┤
  │                                                  │
  │  State machine:                                  │
  │    IDLE → LISTENING → ANALYZING → BOT_PENDING    │
  │      ↑      ↑  turn.pause  ↗         │           │
  │      │      └─────────────┘    bot_reply_start   │
  │      │                              ↓            │
  │      └─── bot.finished ─── BOT_SPEAKING          │
  │                                     │            │
  │              barge-in ──→ LISTENING (interrupt)   │
  │                                                  │
  │  Try these to see different turn behaviors:      │
  │  • Short phrase:   "Yes" → instant turn.end      │
  │  • Long sentence:  pause mid-sentence            │
  │  • Barge-in:       interrupt the bot              │
  │                                                  │
  │  Change MODEL / STT_LANG in .env to switch:      │
  │    MODEL=flux  → native turns (fastest)          │
  │    MODEL=nova  → SmartTurn + Silero              │
  │                                                  │
  └──────────────────────────────────────────────────┘
`);

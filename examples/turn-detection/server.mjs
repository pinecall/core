/**
 * Pinecall — Turn Detection Example
 *
 * Turn-taking is the part of a voice agent you cannot see, and the part that
 * decides whether it feels alive or deaf. This example does nothing except
 * render it: every turn event the server emits, drawn as the state machine it
 * really is, so you can watch a pause be judged and a barge-in be caught.
 *
 *   IDLE ──speech.started──▶ LISTENING ──turn.pause──▶ (still LISTENING)
 *                                      ──turn.end────▶ BOT_PENDING
 *                                                          │
 *        ◀──bot.finished── BOT_SPEAKING ◀──bot.speaking────┘
 *                              │
 *                              └──bot.interrupted──▶ LISTENING (barge-in)
 *
 * MODEL picks who decides the turn:
 *   flux → deepgram/flux    — turn detection built into the STT (fastest)
 *   nova → deepgram/nova-3  — SmartTurn + Silero VAD, activated server-side
 *
 * Run:
 *   npm install
 *   npm start
 *
 * Environment:
 *   PINECALL_API_KEY  — your API key
 *   AGENT             — the slug to register as (default: turn-detection)
 *   PHONE             — a number in your org to answer on (optional, E.164)
 *   MODEL             — "flux" or "nova" (default: flux)
 *   STT_LANG          — language code: en, es, ar, fr, de, pt (default: en)
 */

import { Pinecall } from "@pinecall/sdk";

const AGENT = process.env.AGENT || "turn-detection";
const PHONE = process.env.PHONE || undefined;
const MODEL = (process.env.MODEL || "flux").toLowerCase();
const LANG = process.env.STT_LANG || "en";

if (!process.env.PINECALL_API_KEY) {
  console.error("Missing PINECALL_API_KEY");
  process.exit(1);
}

// STT and voice follow from MODEL and LANG — there is nothing to configure
// twice, and the point of the example is the comparison.
const STT = MODEL === "nova" ? "deepgram/nova-3" : "deepgram/flux";
const TURNS = MODEL === "nova" ? "SmartTurn + Silero (server-side)" : "native (built into Flux)";

const VOICES = {
  en: "elevenlabs/sarah",
  es: "elevenlabs/valentina",
  ar: "elevenlabs/ahmad",
  fr: "elevenlabs/claire",
  de: "elevenlabs/anna",
  pt: "elevenlabs/gabriela",
};
const VOICE = VOICES[LANG] || VOICES.en;

const GREETINGS = {
  en: "Hello! Talk naturally and watch the turn events in the console.",
  es: "¡Hola! Habla con naturalidad y observa los eventos de turno en la consola.",
  ar: "مرحبا! تحدث بشكل طبيعي وراقب أحداث الدور في وحدة التحكم.",
  fr: "Bonjour! Parlez naturellement et regardez les événements dans la console.",
  de: "Hallo! Sprich ganz normal und beobachte die Turn-Events in der Konsole.",
  pt: "Olá! Fale naturalmente e observe os eventos de turno no console.",
};

// ── The renderer ─────────────────────────────────────────────────────────
//
// One box per turn. Everything below this line is printing, not Pinecall.

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m",
  red: "\x1b[31m", magenta: "\x1b[35m", blue: "\x1b[34m", white: "\x1b[37m",
};

const stamp = () => new Date().toISOString().slice(11, 23);

const turn = {
  id: 0,
  state: "IDLE",
  startedAt: null,
  open: false,
  preview: false,

  /** Erase the in-place bot.word line, if one is on screen. */
  clearPreview() {
    if (!this.preview) return;
    process.stdout.write("\r" + " ".repeat(120) + "\r");
    this.preview = false;
  },

  log(icon, detail, color = C.white) {
    this.clearPreview();
    console.log(`    ${C.cyan}│${C.reset}  ${icon}  ${color}${detail}${C.reset}`);
  },

  transition(to, extra = "") {
    this.clearPreview();
    const from = this.state;
    this.state = to;
    console.log(`    ${C.cyan}│${C.reset}`);
    console.log(
      `    ${C.cyan}│${C.reset}  ${C.dim}${from}${C.reset} → ${C.cyan}${C.bold}${to}${C.reset}  ${C.dim}${extra}${C.reset}`,
    );
  },

  start(turnId) {
    if (this.open) this.end();
    this.id = turnId || this.id + 1;
    const from = this.state;
    this.state = "LISTENING";
    this.startedAt = Date.now();
    this.open = true;
    console.log();
    console.log(
      `    ${C.cyan}┌ Turn #${this.id}${C.reset}  ·  ${C.dim}${from} → LISTENING${C.reset}` +
        `${"".padEnd(20)}${C.dim}${stamp()}${C.reset}`,
    );
  },

  end() {
    this.clearPreview();
    if (!this.open) return;
    const seconds = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    console.log(`    ${C.cyan}│${C.reset}`);
    console.log(`    ${C.cyan}└${C.reset} ${C.dim}${seconds}s${C.reset}`);
    this.open = false;
    this.state = "IDLE";
  },

  interruption(playedMs, reason, spoken) {
    this.clearPreview();
    console.log(`    ${C.cyan}│${C.reset}`);
    console.log(`    ${C.cyan}├${C.red}─── ⚡ INTERRUPTION ${"─".repeat(38)}${C.reset}`);
    console.log(
      `    ${C.cyan}│${C.reset}  ${C.dim}BOT_SPEAKING${C.reset} → ${C.yellow}${C.bold}LISTENING${C.reset}` +
        `  ${C.dim}barge-in after ${playedMs}ms — ${reason}${C.reset}`,
    );
    if (spoken) this.log("🗣", `got as far as: "${clip(spoken, 55)}"`, C.dim);
    this.state = "LISTENING";
  },
};

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

// ── The agent ────────────────────────────────────────────────────────────

const pc = new Pinecall();

const agent = pc.agent(AGENT, {
  llm: "openai/gpt-4.1-mini",
  stt: STT,
  voice: VOICE,
  language: LANG,
  prompt:
    "You are a friendly assistant. Keep your responses to 1-2 sentences since this is a voice call. Respond in the same language the user speaks.",
  phoneNumber: PHONE,
});

agent.on("ready", () => {
  console.log(`
  Turn detection — agent '${AGENT}'
  ${"─".repeat(46)}
  Reachable  ${PHONE || "browser only (no PHONE set)"}
  STT        ${STT}
  Turns      ${TURNS}
  Voice      ${VOICE} (${LANG})

  Try a one-word answer, a sentence with a pause in the middle,
  and talking over the agent while it speaks.
`);
});
agent.on("error", (err) => console.error(`Agent refused (${err.code}): ${err.message}`));

agent.on("call.started", (call) => {
  console.log(`${"─".repeat(60)}\n  Call ${call.id} from ${call.from}\n${"─".repeat(60)}`);
  call.say(GREETINGS[LANG] || GREETINGS.en);
});

agent.on("call.ended", (call, reason) => {
  turn.end();
  console.log(`${"─".repeat(60)}\n  Call ended: ${reason} (${Math.round(call.duration)}s)\n${"─".repeat(60)}`);
});

// ── IDLE → LISTENING ─────────────────────────────────────────────────────

agent.on("speech.started", (event) => {
  if (!turn.open) turn.start(event.turnId);
  turn.log("🎙", "speech.started", C.cyan);
});

agent.on("user.speaking", (event) => {
  if (turn.open) turn.log("💬", `"${event.text}"`, C.dim);
});

agent.on("user.message", (event) => {
  if (turn.open) turn.log("📝", `"${event.text}"`, C.green);
});

// ── The judgement: is the user done? ─────────────────────────────────────

agent.on("turn.pause", (event) => {
  if (!turn.open) return;
  // A pause the detector was NOT convinced by — the turn stays open.
  turn.log("⏸ ", `turn.pause — ${pct(event.probability)} — waiting for more speech`, C.yellow);
});

agent.on("turn.end", (event) => {
  if (turn.open) turn.transition("BOT_PENDING", pct(event.probability));
});

// ── BOT_PENDING → BOT_SPEAKING → IDLE ────────────────────────────────────

agent.on("bot.speaking", (event) => {
  if (!turn.open) {
    // The greeting: the bot speaks before the user has taken a turn at all.
    console.log(`\n  ${C.dim}${stamp()}${C.reset}  🤖  ${C.blue}greeting${C.reset}`);
    return;
  }
  turn.transition("BOT_SPEAKING");
  turn.log("🤖", `"${clip(event.text || "", 55)}"`, C.blue);
});

agent.on("bot.word", (_event, call) => {
  if (!turn.open) return;
  turn.preview = true;
  process.stdout.write(
    `\r    ${C.cyan}│${C.reset}  🗣  ${C.blue}"${clip(call.currentBotText, 65)}"${C.reset}${" ".repeat(20)}`,
  );
});

agent.on("bot.finished", (event, call) => {
  if (!turn.open) {
    console.log(`  ${C.dim}${stamp()}${C.reset}  🔇  ${C.dim}greeting finished (${event.durationMs}ms)${C.reset}`);
    return;
  }
  if (call.currentBotText) turn.log("🗣", `"${clip(call.currentBotText, 55)}"`, C.blue);
  turn.log("🔇", `bot.finished — ${event.durationMs}ms`, C.dim);
  turn.end();
});

// ── BOT_SPEAKING → LISTENING ─────────────────────────────────────────────

agent.on("bot.interrupted", (event, call) => {
  if (turn.open) turn.interruption(event.playedMs, event.reason, call.currentBotText);
});

agent.on("message.confirmed", () => {
  if (turn.open) turn.log("📨", "message.confirmed", C.magenta);
});

// ── Helpers ──────────────────────────────────────────────────────────────

function pct(probability) {
  return `prob=${(probability * 100).toFixed(0)}%`;
}

/**
 * Pinecall — Ringing Example
 *
 * By default an inbound call is answered for you and you meet it at
 * `call.started`. Register the number with `{ ringing: true }` and the SDK
 * hands you the call one step earlier, at `call.ringing`, while the line is
 * still ringing — before a second of audio is billed and before the agent
 * says a word. You decide: `accept()` or `reject()`.
 *
 * That is the whole point of this example: a blacklist that costs nothing,
 * because the call the agent never answers never happens.
 *
 * This one needs a real number — ringing is a phone concept.
 *
 * Run:
 *   npm install
 *   npm start
 *
 * Environment:
 *   PINECALL_API_KEY  — your API key
 *   AGENT             — the slug to register as (default: ringing)
 *   PHONE             — the number to answer on (E.164, required)
 *   BLACKLIST         — comma-separated numbers to reject (optional)
 */

import { Pinecall } from "@pinecall/sdk";

const AGENT = process.env.AGENT || "ringing";
const PHONE = process.env.PHONE;

if (!process.env.PINECALL_API_KEY) {
  console.error("Missing PINECALL_API_KEY");
  process.exit(1);
}
if (!PHONE) {
  console.error("Missing PHONE — ringing is a phone flow, it needs a number to ring");
  process.exit(1);
}

const BLACKLIST = new Set(
  (process.env.BLACKLIST || "").split(",").map((n) => n.trim()).filter(Boolean),
);

const pc = new Pinecall();

const agent = pc.agent(AGENT, {
  voice: "elevenlabs/sarah",
  language: "en",
  stt: "deepgram/flux",
  llm: "openai/gpt-4.1-mini",
  prompt:
    "You are a friendly assistant. Keep your responses short (1-2 sentences) since this is a voice call.",

  // `ringing: true` is the switch. Without it the call is auto-accepted and
  // `call.ringing` never fires.
  phoneNumber: { number: PHONE, ringing: true },
});

agent.on("ready", () =>
  console.log(
    `Agent '${AGENT}' ready on ${PHONE} — screening ${BLACKLIST.size || "no"} number(s)`,
  ),
);
agent.on("error", (err) => console.error(`Agent refused (${err.code}): ${err.message}`));

// ── The decision ─────────────────────────────────────────────────────────

agent.on("call.ringing", (call) => {
  if (BLACKLIST.has(call.from)) {
    console.log(`Ringing ${call.from} → REJECTED (blacklisted)`);
    // A rejected call is never answered: no audio, no model, nothing billed.
    call.reject("busy");
    return;
  }

  console.log(`Ringing ${call.from} → ACCEPTED`);
  call.accept();
});

// ── After the decision, an ordinary call ─────────────────────────────────

agent.on("call.started", (call) => {
  console.log(`Call ${call.id} started`);
  call.say("Hello! This call came through the ringing flow. How can I help?");
});

agent.on("call.ended", (call, reason) =>
  console.log(`Call ${call.id} ended (${reason}, ${Math.round(call.duration)}s)`),
);

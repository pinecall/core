/**
 * Pinecall — Simple Example
 *
 * A minimal voice agent that answers calls and prints a
 * live audio URL you can open in your browser to listen in.
 *
 * Usage:
 *   PINECALL_API_KEY=pk_... node server.js
 *   PINECALL_API_KEY=pk_... PHONE=+1... node server.js
 *
 * Environment:
 *   PINECALL_API_KEY  — your API key
 *   PHONE             — phone number to register (default: +13049709763)
 */

import { Pinecall } from "@pinecall/sdk";

const API_KEY = process.env.PINECALL_API_KEY;
const PHONE = process.env.PHONE || "+13049709763";
const SERVER = process.env.PINECALL_URL || "https://voice.pinecall.io";

if (!API_KEY) {
  console.error("❌ Missing PINECALL_API_KEY");
  process.exit(1);
}

// ── Pinecall setup ───────────────────────────────────────────────────────

const pc = new Pinecall({ apiKey: API_KEY });
await pc.connect();

const agent = pc.agent("simple-agent", {
  voice: "elevenlabs:EXAVITQu4vr4xnSDxMaL",
  language: "en",
  stt: "deepgram-flux",
  llm: {
    provider: "openai",
    model: "gpt-4.1-mini",
    enabled: true,
    prompt:
      "You are a friendly assistant. Keep your responses short (1-2 sentences) since this is a voice call.",
  },
  media: {
    live: true,
    recording: true,
  },
});

agent.addChannel("phone", PHONE);

// ── Call lifecycle ───────────────────────────────────────────────────────

agent.on("call.started", (call) => {
  const liveUrl = `${SERVER}/live/${call.id}/player?token=${API_KEY}`;

  console.log(`\n📞 Call started: ${call.from} → ${call.to}`);
  console.log(`   🎧 Listen live: ${liveUrl}\n`);

  call.say("Hello! How can I help you today?");
});

agent.on("user.message", (event) => {
  console.log(`   🗣️  User: ${event.text}`);
});

agent.on("message.confirmed", (event) => {
  console.log(`   🤖 Bot:  ${event.text}`);
});

agent.on("call.ended", (call, reason) => {
  console.log(
    `\n📴 Call ended: ${reason} (${Math.round(call.duration)}s)\n`
  );
});

// ── Ready ────────────────────────────────────────────────────────────────

console.log(`
  ⚡ Pinecall Simple Example
  ──────────────────────────
  Phone:     ${PHONE}
  Live:      enabled (URL printed on call start)
  Recording: enabled (emitted on call end)

  Call ${PHONE} to start.
`);

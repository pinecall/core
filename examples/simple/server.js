/**
 * Pinecall — Simple Example
 *
 * A minimal voice agent that answers calls and prints a
 * live audio URL you can open in your browser to listen in.
 *
 * Usage:
 *   PINECALL_API_KEY=pk_... PHONE=+1... node server.js
 *
 * Environment:
 *   PINECALL_API_KEY  — your API key
 *   PHONE             — Twilio phone number to register
 */

import { Pinecall } from "@pinecall/sdk";

const API_KEY = process.env.PINECALL_API_KEY;
const PHONE = process.env.PHONE;

if (!API_KEY) {
  console.error("Missing PINECALL_API_KEY");
  process.exit(1);
}
if (!PHONE) {
  console.error("Missing PHONE (e.g. PHONE=+15551234567)");
  process.exit(1);
}

// ── Pinecall setup ───────────────────────────────────────────────────────

const pc = new Pinecall({ apiKey: API_KEY });
await pc.connect();

const agent = pc.agent("simple-agent", {
  voice: "elevenlabs/sarah",
  language: "en",
  stt: "deepgram/flux",
  llm: "openai/gpt-4.1-mini",
  prompt:
    "You are a friendly assistant. Keep your responses short (1-2 sentences) since this is a voice call.",
  phoneNumbers: [PHONE],
  media: {
    live: true,
    recording: true,
  },
});

// ── Call lifecycle ───────────────────────────────────────────────────────

agent.on("call.started", (call) => {
  console.log(`\nCall started: ${call.from} -> ${call.to}`);
  console.log(`  Listen live: https://voice.pinecall.io/live/${call.id}/player?token=${API_KEY}\n`);

  call.say("Hello! How can I help you today?");
});

agent.on("user.message", (event) => {
  console.log(`  User: ${event.text}`);
});

agent.on("message.confirmed", (event) => {
  console.log(`  Bot:  ${event.text}`);
});

agent.on("call.ended", (call, reason) => {
  console.log(`\nCall ended: ${reason} (${Math.round(call.duration)}s)\n`);
});

// ── Ready ────────────────────────────────────────────────────────────────

console.log(`
  Pinecall Simple Example
  -----------------------
  Phone:     ${PHONE}
  Live:      enabled (URL printed on call start)
  Recording: enabled

  Call ${PHONE} to start.
`);

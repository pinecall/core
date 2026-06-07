/**
 * Pinecall — Simple Example
 *
 * A minimal voice agent that answers calls, remembers returning callers,
 * and saves every message incrementally to a JSON file.
 *
 * Usage:
 *   PINECALL_API_KEY=pk_... PHONE=+1... node server.js
 *
 * Environment:
 *   PINECALL_API_KEY  — your API key
 *   PHONE             — Twilio phone number to register
 */

import "dotenv/config";
import { Pinecall, JsonFileHistory } from "@pinecall/sdk";

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

const history = new JsonFileHistory("./data/calls.json");

const agent = pc.agent("simple-agent", {
  voice: "elevenlabs/sarah",
  language: "en",
  stt: "deepgram/flux",
  llm: "openai/gpt-4.1-mini",
  prompt:
    "You are a friendly assistant. Keep your responses short (1-2 sentences) since this is a voice call.",
  phoneNumber: PHONE,
  history,
});

// ── Call lifecycle ───────────────────────────────────────────────────────

agent.on("call.started", (call) => {
  console.log(`\nCall started: ${call.from} -> ${call.to}`);
  // History is auto-restored by the SDK (last 20 messages from prior calls)
  call.say("Hello! How can I help you today?");
});

agent.on("user.message", (event) => {
  console.log(`  User: ${event.text}`);
});

agent.on("message.confirmed", (event) => {
  console.log(`  Bot:  ${event.text}`);
});

agent.on("call.ended", (call, reason) => {
  console.log(`\nCall ended: ${reason} (${Math.round(call.duration)}s)`);
  console.log(`  💾 ${call.messages.length} messages saved to data/calls.json\n`);
});

// ── Ready ────────────────────────────────────────────────────────────────

console.log(`
  Pinecall Simple Example
  -----------------------
  Phone:     ${PHONE}
  History:   ./data/calls.json (incremental)

  Call ${PHONE} to start.
`);


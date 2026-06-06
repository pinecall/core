/**
 * Pinecall — Ringing Example
 *
 * Demonstrates the call.ringing -> accept/reject flow.
 *
 * When `ringing: true` is set on a phone channel, inbound calls
 * emit `call.ringing` instead of being auto-accepted. Your code
 * can inspect the caller and decide to accept() or reject().
 *
 * Usage:
 *   PINECALL_API_KEY=pk_... PHONE=+1... node server.js
 *
 * Environment:
 *   PINECALL_API_KEY  — your API key
 *   PHONE             — Twilio phone number to register
 *   BLACKLIST         — comma-separated numbers to reject (optional)
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

// Parse blacklist from env (comma-separated)
const BLACKLIST = new Set(
  (process.env.BLACKLIST || "").split(",").map((n) => n.trim()).filter(Boolean)
);

// ── Pinecall setup ───────────────────────────────────────────────────────

const pc = new Pinecall({ apiKey: API_KEY });
await pc.connect();

const agent = pc.agent("ringing-example", {
  voice: "elevenlabs/sarah",
  language: "en",
  stt: "deepgram/flux",
  llm: "openai/gpt-4.1-mini",
  prompt:
    "You are a friendly assistant. Keep your responses short (1-2 sentences) since this is a voice call.",
});

// Register phone with ringing enabled — calls go through call.ringing first
agent.addChannel("phone", PHONE, { ringing: true });

// ── Ringing handler ──────────────────────────────────────────────────────

agent.on("call.ringing", (call) => {
  console.log(`\nRinging: ${call.from} -> ${call.to}`);

  // Check blacklist
  if (BLACKLIST.has(call.from)) {
    console.log(`  REJECTED (blacklisted)`);
    call.reject("busy");
    return;
  }

  // Accept the call
  console.log(`  ACCEPTED`);
  call.accept();
});

// ── Call lifecycle ───────────────────────────────────────────────────────

agent.on("call.started", (call) => {
  console.log(`Call started: ${call.from} -> ${call.to}`);
  call.say("Hello! This call was accepted through the ringing flow. How can I help?");
});

agent.on("call.ended", (call, reason) => {
  console.log(`\nCall ended: ${reason} (${Math.round(call.duration)}s)\n`);
});

// ── Ready ────────────────────────────────────────────────────────────────

console.log(`
  Pinecall Ringing Example
  ------------------------
  Phone:     ${PHONE}
  Ringing:   enabled
  Blacklist: ${BLACKLIST.size > 0 ? [...BLACKLIST].join(", ") : "(none)"}

  Call ${PHONE} to test.
  The agent will log RINGING -> ACCEPTED/REJECTED -> STARTED.
`);

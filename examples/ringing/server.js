/**
 * Pinecall — Ringing Example
 *
 * Tests the call.ringing → accept/reject flow.
 *
 * The agent registers a phone channel with `ringing: true`.
 * When a call comes in, `call.ringing` fires before the call is answered.
 * The SDK can then accept or reject the call based on caller info.
 *
 * Usage:
 *   PINECALL_API_KEY=pk_... PHONE=+14258423349 node server.js
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
  console.error("❌ Missing PINECALL_API_KEY");
  process.exit(1);
}
if (!PHONE) {
  console.error("❌ Missing PHONE (e.g. +14258423349)");
  process.exit(1);
}

// Parse blacklist from env (comma-separated)
const BLACKLIST = new Set(
  (process.env.BLACKLIST || "").split(",").map((n) => n.trim()).filter(Boolean)
);

// ── Pinecall setup ───────────────────────────────────────────────────────

const pc = new Pinecall({ apiKey: API_KEY });
await pc.connect();

const agent = pc.agent("ringing-test", {
  voice: "elevenlabs:EXAVITQu4vr4xnSDxMaL",
  language: "en",
  stt: "deepgram-flux",
  llm: {
    provider: "openai",
    model: "gpt-4.1-mini",
    enabled: true,
    prompt: "You are a test assistant. Say hello and ask how you can help. Keep it short.",
  },
});

// Register phone with ringing enabled
agent.addChannel("phone", PHONE, { ringing: true });

// Dev callers — only route dev calls from this number
agent.routeCallers(["+34607827824"]);

// ── Ringing handler ──────────────────────────────────────────────────────

agent.on("call.ringing", (call) => {
  console.log(`\n🔔 RINGING: ${call.callId}`);
  console.log(`   From: ${call.from}`);
  console.log(`   To:   ${call.to}`);

  // Check blacklist
  if (BLACKLIST.has(call.from)) {
    console.log(`   ❌ REJECTED (blacklisted)`);
    call.reject("busy");
    return;
  }

  // Accept the call
  console.log(`   ✅ ACCEPTED`);
  call.accept();
});

// ── Call lifecycle ───────────────────────────────────────────────────────

agent.on("call.started", (call) => {
  console.log(`📞 Call started: ${call.id} (${call.from} → ${call.to})`);
  call.say("Hello! This call was accepted through the ringing flow. How can I help?");
});

agent.on("call.ended", (call, reason) => {
  console.log(`📴 Call ended: ${call.id} — ${reason} (${Math.round(call.duration)}s)`);
});

// ── Ready ────────────────────────────────────────────────────────────────

console.log(`
  🔔 Pinecall Ringing Example
  ────────────────────────────
  Phone:     ${PHONE}
  Ringing:   enabled
  Blacklist: ${BLACKLIST.size > 0 ? [...BLACKLIST].join(", ") : "(none)"}
  Dev caller: +34607827824

  Call ${PHONE} to test.
  The agent will log RINGING → ACCEPTED/REJECTED → STARTED.

  Available test numbers:
    +13049709763  Support Bot (multi-agent test)
    +13149473426  Sales Agent (multi-agent test)
`);

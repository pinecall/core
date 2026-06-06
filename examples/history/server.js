/**
 * Pinecall — History Example
 *
 * Demonstrates conversation persistence across calls using the built-in
 * JsonFileHistory store.
 *
 * When a contact calls for the first time, the agent greets them normally.
 * When the same contact calls again, the agent restores the previous
 * conversation context so it remembers what was discussed before.
 *
 * How it works:
 *   1. history: JsonFileHistory → auto-saves every call on call.ended
 *   2. On call.started → findByContact() to load prior conversations
 *   3. If found → call.setHistory() to inject prior messages
 *
 * You can replace JsonFileHistory with your own HistoryStore implementation
 * (MongoDB, Postgres, API, etc.) — just implement the save() method.
 *
 * Usage:
 *   PINECALL_API_KEY=pk_... PHONE=+1... node server.js
 *
 * Environment:
 *   PINECALL_API_KEY  — your API key
 *   PHONE             — Twilio phone number to register
 */

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

// ── History store ─────────────────────────────────────────────────────────
//
// JsonFileHistory is the built-in store — saves conversations to a JSON file.
// For production, implement HistoryStore with your own database:
//
//   class MyDBHistory {
//     async save(record) { await db.conversations.upsert(record); }
//     async findByContact(phone) { return db.conversations.find({ from: phone }); }
//   }

const history = new JsonFileHistory("./data/calls.json");

// ── Pinecall setup ───────────────────────────────────────────────────────

const pc = new Pinecall({ apiKey: API_KEY });
await pc.connect();

const agent = pc.agent("history-example", {
  voice: "elevenlabs/sarah",
  language: "en",
  stt: "deepgram/flux",
  llm: "openai/gpt-4.1-mini",
  prompt: `You are a friendly assistant with memory of past conversations.
When you have prior conversation context, reference things discussed before
to make the caller feel recognized. Keep responses short (1-2 sentences)
since this is a voice call.`,
  phoneNumbers: [PHONE],

  // ✨ Auto-save: every call is saved to the JSON file automatically
  history,
});

// ── Load prior history on new calls ─────────────────────────────────────

agent.on("call.started", async (call) => {
  // Identify the contact — phone number for Twilio, userId for WebRTC
  const contactId = call.from && call.from !== "webrtc"
    ? call.from
    : call.metadata?.userId
      ? String(call.metadata.userId)
      : null;

  console.log(`\nCall started: ${call.from} -> ${call.to}`);
  console.log(`  Contact: ${contactId ?? "(unknown)"}`);

  if (!contactId) {
    call.say("Hello! I'm an assistant with memory.");
    return;
  }

  // Look up prior conversations for this contact
  const prior = await history.findByContact(contactId, 1);

  if (prior.length > 0) {
    const last = prior[0];
    const totalCalls = (await history.findByContact(contactId, 100)).length;
    console.log(`  History: ${totalCalls} previous call(s), last: ${new Date(last.endedAt * 1000).toISOString()}`);
    console.log(`  Messages: ${last.messages.length} messages restored`);

    // Inject saved messages into the LLM context
    await call.setHistory(last.messages);

    call.say(`Welcome back! This is call number ${totalCalls + 1}. I remember our last conversation.`);
  } else {
    console.log(`  History: first call`);
    call.say("Hello! I'm an assistant with memory. Call me again and I'll remember what we talked about.");
  }
});

// ── Logging ─────────────────────────────────────────────────────────────

agent.on("user.message", (event) => {
  console.log(`  User: ${event.text}`);
});

agent.on("message.confirmed", (event) => {
  console.log(`  Bot:  ${event.text}`);
});

agent.on("call.ended", (call, reason) => {
  // No manual save needed — history config handles it automatically!
  console.log(`\nCall ended: ${reason} (${Math.round(call.duration)}s)`);
  console.log(`  Messages: ${call.messages?.length ?? 0} (auto-saved)\n`);
});

// ── Ready ────────────────────────────────────────────────────────────────

console.log(`
  Pinecall History Example
  -------------------------
  Phone:    ${PHONE}
  Storage:  ./data/calls.json (auto-saved)

  Call ${PHONE} to start.
  Hang up, then call again — the agent will remember the conversation.
`);

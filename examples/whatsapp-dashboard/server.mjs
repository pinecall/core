/**
 * Pinecall — WhatsApp Dashboard Example
 *
 * A WhatsApp agent a human can take over from, mid-conversation.
 *
 * The mechanism is three calls: `agent.pause(sessionId)` stops the model from
 * answering that one conversation while messages keep arriving,
 * `agent.sendMessage()` lets the operator answer in its place, and
 * `agent.resume()` hands it back — with everything the human said already in
 * the context, so the agent does not contradict them.
 *
 * `agent.stream(res)` is the other half: point an SSE response at it and the
 * browser sees every message, pause and resume as it happens. The dashboard in
 * client/ is a single React component reading that stream.
 *
 * This is the one example with a second folder, because a takeover UI needs a
 * UI. Everything Pinecall does is in this file.
 *
 * Run:
 *   npm install
 *   npm run build      # builds client/dist, which this server serves
 *   npm start
 *
 * Environment:
 *   PINECALL_API_KEY    — your API key
 *   AGENT               — the slug to register as (default: whatsapp-dashboard)
 *   WA_PHONE_NUMBER_ID  — Meta WhatsApp Cloud API phone number id
 *   WA_ACCESS_TOKEN     — Meta access token
 *   WA_VERIFY_TOKEN     — the webhook verify token you set in the Meta console
 *   WA_APP_SECRET       — Meta app secret (optional, verifies webhook signatures)
 *   PORT                — dashboard port (default: 3000)
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Pinecall, JsonFileHistory } from "@pinecall/sdk";

const AGENT = process.env.AGENT || "whatsapp-dashboard";
const PORT = process.env.PORT || 3000;
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "client/dist");

if (!process.env.PINECALL_API_KEY) {
  console.error("Missing PINECALL_API_KEY");
  process.exit(1);
}
if (!process.env.WA_PHONE_NUMBER_ID || !process.env.WA_ACCESS_TOKEN) {
  console.error("Missing WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN — see .env.example");
  process.exit(1);
}
if (!existsSync(CLIENT)) {
  console.error("client/dist is missing — run `npm run build` first");
  process.exit(1);
}

// ── The agent ────────────────────────────────────────────────────────────

const history = new JsonFileHistory("./data/conversations.json");

const pc = new Pinecall();

const agent = pc.agent(AGENT, {
  language: "en",
  llm: "openai/gpt-4.1-mini",
  prompt: `You are a helpful customer support agent on WhatsApp.
Be concise and friendly. Use short paragraphs.
If the customer asks to speak to a human, tell them you'll connect them right away.`,
  history,
});

// WhatsApp is a channel on the agent, not a different kind of agent. The same
// prompt, history and tools would serve a phone number just as well.
agent.addWhatsapp({
  phoneNumberId: process.env.WA_PHONE_NUMBER_ID,
  accessToken: process.env.WA_ACCESS_TOKEN,
  verifyToken: process.env.WA_VERIFY_TOKEN || "pinecall-wa-verify",
  appSecret: process.env.WA_APP_SECRET || undefined,
});

agent.on("ready", () => console.log(`Agent '${AGENT}' ready on WhatsApp`));
agent.on("error", (err) => console.error(`Agent refused (${err.code}): ${err.message}`));

agent.on("whatsapp.sessionStarted", (session) =>
  console.log(`Session ${session.contactName} (${session.contactPhone})`),
);
agent.on("whatsapp.message", (event) =>
  console.log(`${event.paused ? "[paused] " : ""}${event.name}: ${event.text}`),
);
agent.on("whatsapp.response", (event) => console.log(`bot → ${event.to}: ${event.text}`));
agent.on("session.paused", (event) => console.log(`paused ${event.sessionId || "everything"}`));
agent.on("session.resumed", (event) => console.log(`resumed ${event.sessionId || "everything"}`));

// ── The dashboard ────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// One line: every agent event, as Server-Sent Events, for as long as the
// browser holds the response open.
app.get("/api/events", (req, res) => agent.stream(res));

app.post("/api/pause/:sessionId", (req, res) => {
  agent.pause(req.params.sessionId);
  res.json({ ok: true });
});

app.post("/api/resume/:sessionId", (req, res) => {
  agent.resume(req.params.sessionId);
  res.json({ ok: true });
});

app.post("/api/send/:sessionId", (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text is required" });
  agent.sendMessage({ sessionId: req.params.sessionId, text });
  res.json({ ok: true });
});

app.get("/api/history", async (_req, res) => {
  res.json(await history.list(AGENT, 50));
});

app.use(express.static(CLIENT));
app.get("/{*splat}", (_req, res) => res.sendFile(join(CLIENT, "index.html")));

app.listen(PORT, () => console.log(`Dashboard on http://localhost:${PORT}`));

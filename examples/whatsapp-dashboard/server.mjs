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
 * Watching is the other half, and this server does none of it: it mints a
 * read-only Call Log token (`createToken("stream", { scope: "observe" })`) and
 * the dashboard in client/ reads the log straight from Pinecall over SSE with
 * `@pinecall/web/log`. No event fan-out lives here.
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

// Which conversations the operator has taken over. Pausing is a server-side
// verb with no log entry of its own, so the dashboard hydrates it from here.
const paused = new Set();

// The only thing the browser needs to watch the agent: a read-only Call Log
// token. `scope: "observe"` means exactly that — it can read this agent's log
// and nothing else, and it expires. Mint it per logged-in operator; never ship
// PINECALL_API_KEY to a browser.
app.get("/api/token", async (_req, res) => {
  try {
    const { token, server, expiresIn } = await agent.createToken("stream", undefined, {
      scope: "observe",
    });
    res.json({ token, server, expiresIn, agent: AGENT });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.get("/api/state", (_req, res) => res.json({ paused: [...paused] }));

app.post("/api/pause/:sessionId", (req, res) => {
  agent.pause(req.params.sessionId);
  paused.add(req.params.sessionId);
  res.json({ ok: true });
});

app.post("/api/resume/:sessionId", (req, res) => {
  agent.resume(req.params.sessionId);
  paused.delete(req.params.sessionId);
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

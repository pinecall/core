/**
 * WhatsApp Dashboard — Backend
 *
 * A WhatsApp agent with human takeover support.
 * The dashboard (React) connects via SSE to see live messages,
 * and uses REST endpoints to pause, resume, and send messages.
 *
 * Run: PINECALL_API_KEY=pk_... WA_PHONE_NUMBER_ID=... WA_ACCESS_TOKEN=... node server.js
 */

import "dotenv/config";
import express from "express";
import { Pinecall, JsonFileHistory } from "@pinecall/sdk";

const app = express();
app.use(express.json());

// ── Pinecall client ──────────────────────────────────────────────────────

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY });
await pc.connect();

const history = new JsonFileHistory("./data/conversations.json");

const agent = pc.agent("support", {
  language: "en",
  llm: "openai/gpt-4.1-mini",
  prompt: `You are a helpful customer support agent on WhatsApp.
Be concise and friendly. Use short paragraphs.
If the customer asks to speak to a human, tell them you'll connect them right away.`,
  history,
});

// Register WhatsApp channel from environment variables
agent.addWhatsapp({
  phoneNumberId: process.env.WA_PHONE_NUMBER_ID,
  accessToken: process.env.WA_ACCESS_TOKEN,
  verifyToken: process.env.WA_VERIFY_TOKEN || "pinecall-wa-verify",
  appSecret: process.env.WA_APP_SECRET || undefined,
});

// ── Logging ──────────────────────────────────────────────────────────────

agent.on("whatsapp.sessionStarted", (session) => {
  console.log(`💬 New session: ${session.contactName} (${session.contactPhone})`);
});

agent.on("whatsapp.message", (event) => {
  const badge = event.paused ? "[PAUSED] " : "";
  console.log(`📩 ${badge}${event.name}: ${event.text}`);
});

agent.on("whatsapp.response", (event) => {
  console.log(`📤 Bot → ${event.to}: ${event.text}`);
});

agent.on("session.paused", (event) => {
  console.log(`⏸  Paused: ${event.sessionId || "global"}`);
});

agent.on("session.resumed", (event) => {
  console.log(`▶  Resumed: ${event.sessionId || "global"}`);
});

// ── SSE event stream ─────────────────────────────────────────────────────

app.get("/api/events", (req, res) => {
  agent.stream(res);
});

// ── Human takeover API ───────────────────────────────────────────────────

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

// ── History API ──────────────────────────────────────────────────────────

app.get("/api/history", async (req, res) => {
  const conversations = await history.list("support", 50);
  res.json(conversations);
});

// ── Serve React dashboard ────────────────────────────────────────────────

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
app.use(express.static(join(__dirname, "client/dist")));

// SPA fallback — serve index.html for all non-API routes
app.get("/{*splat}", (req, res) => {
  res.sendFile(join(__dirname, "client/dist/index.html"));
});

// ── Start ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  WhatsApp Dashboard`);
  console.log(`  http://localhost:${PORT}\n`);
});

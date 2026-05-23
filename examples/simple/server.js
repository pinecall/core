/**
 * Pinecall — Simple Example
 *
 * Single voice agent with Express + SSE event streaming.
 * Shows how to embed a voice agent in any Node.js app.
 *
 * Usage:
 *   PINECALL_API_KEY=pk_... node server.js
 *
 * Then open http://localhost:3000 in your browser.
 */

import express from "express";
import { Pinecall } from "@pinecall/sdk";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ── Pinecall setup ───────────────────────────────────────────────────────

const pc = new Pinecall({
  apiKey: process.env.PINECALL_API_KEY || "pk_demo",
});

const mara = pc.deploy("mara", {
  prompt: `You are Mara, a friendly voice assistant for DeutschePolska.
DeutschePolska is a premium real estate and relocation company
helping people move between Germany and Poland.

Keep your responses short (1-2 sentences) since this is a voice call.
Be warm, professional, and helpful.`,
  model: "gpt-4.1-mini",
  voice: "elevenlabs:EXAVITQu4vr4xnSDxMaL",
  channels: ["webrtc"],
});

// ── Server-side event hooks ──────────────────────────────────────────────

mara.on("call.started", (call) => {
  console.log(`📞 Call started: ${call.id} (${call.from} via ${call.transport})`);
  call.say("Hey! I'm Mara from DeutschePolska. How can I help you?");
});

mara.on("call.ended", (call, reason) => {
  console.log(`📴 Call ended: ${call.id} — ${reason} (${call.duration}s)`);
});

// ── Routes ───────────────────────────────────────────────────────────────

// SSE event stream — one line!
app.get("/events", (req, res) => {
  mara.stream(res);
});

// Serve the frontend
app.get("/", (req, res) => {
  res.type("html").send(readFileSync(join(__dirname, "index.html"), "utf-8"));
});

// ── Start ────────────────────────────────────────────────────────────────

await pc.connect();
app.listen(PORT, () => {
  console.log(`\n  🎙  Pinecall Simple Example`);
  console.log(`  → http://localhost:${PORT}\n`);
});

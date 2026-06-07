/**
 * Pinecall — SSE Dashboard Example
 *
 * Express server that boots a Pinecall agent and serves a React dashboard
 * with live SSE events, incoming call cards, and an outbound dialer.
 *
 * Config via .env:
 *   PINECALL_API_KEY — your API key
 *   PHONE           — phone number to register (E.164)
 *   AGENT_NAME      — agent identifier (default: "support")
 *   MODEL           — "flux" or "nova"
 *   STT_LANG        — language code: en, es, ar, fr, de, pt
 *   PROMPT          — system prompt
 *   PORT            — dashboard port (default: 4600)
 */

import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Pinecall } from "@pinecall/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// ── Config ──────────────────────────────────────────────────────────────

const PHONE = process.env.PHONE;
const MODEL = (process.env.MODEL || "flux").toLowerCase();
const LANG = process.env.STT_LANG || "en";
const PORT = process.env.PORT || 4600;
const AGENT_NAME = process.env.AGENT_NAME || "support";
const PROMPT = process.env.PROMPT || "You are a friendly support assistant. Keep responses to 1-2 sentences. Respond in the same language the user speaks.";

if (!PHONE) {
  console.error("Missing PHONE in .env (e.g. PHONE=+15551234567)");
  process.exit(1);
}

const STT = MODEL === "nova" ? "deepgram/nova-3" : "deepgram/flux";
const VOICES = {
  en: "elevenlabs/sarah",
  es: "elevenlabs/valentina",
  ar: "elevenlabs/ahmad",
  fr: "elevenlabs/claire",
  de: "elevenlabs/anna",
  pt: "elevenlabs/gabriela",
};
const VOICE = VOICES[LANG] || VOICES.en;

// ── Pinecall agent ──────────────────────────────────────────────────────

const pc = new Pinecall();
await pc.connect();

const GREETINGS = {
  en: "Hello! How can I help you today?",
  es: "¡Hola! ¿En qué puedo ayudarte?",
  ar: "مرحبا! كيف يمكنني مساعدتك اليوم؟",
  fr: "Bonjour! Comment puis-je vous aider?",
  de: "Hallo! Wie kann ich Ihnen helfen?",
  pt: "Olá! Como posso ajudá-lo hoje?",
};

const agent = pc.agent(AGENT_NAME, {
  llm: "openai/gpt-4.1-mini",
  stt: STT,
  voice: VOICE,
  language: LANG,
  prompt: PROMPT,
  phoneNumber: PHONE,
  greeting: GREETINGS[LANG] || GREETINGS.en,
});

console.log(`  📞 Agent "${AGENT_NAME}" registered on ${PHONE} (${STT}, ${VOICE})`);

// ── SSE: Live event stream ──────────────────────────────────────────────

const SSE_EVENTS = [
  "call.started", "call.ended",
  "speech.started",
  "user.speaking", "user.message",
  "turn.pause", "turn.end",
  "bot.speaking", "bot.word", "bot.finished", "bot.interrupted",
  "message.confirmed",
];

app.get("/events", (_req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  res.write(`data: ${JSON.stringify({ event: "connected", agent: AGENT_NAME })}\n\n`);

  const handlers = [];

  for (const evt of SSE_EVENTS) {
    const handler = (...args) => {
      const payload = { event: evt };

      for (const arg of args) {
        if (!arg || typeof arg !== "object") continue;

        // Call object — extract safe fields
        if ("id" in arg && "from" in arg && "to" in arg && "transport" in arg) {
          payload.call_id = arg.id;
          payload.from = arg.from;
          payload.to = arg.to;
          payload.direction = arg.direction;
          payload.transport = arg.transport;
          if (arg.duration) payload.duration = arg.duration;
          if (arg.currentBotText) payload.currentBotText = arg.currentBotText;
          continue;
        }

        // Event data — flatten safe fields
        for (const [k, v] of Object.entries(arg)) {
          if (typeof v === "function" || k.startsWith("_")) continue;
          if (k === "callId") payload.call_id = v;
          else payload[k] = v;
        }
      }

      try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {}
    };
    handlers.push({ event: evt, handler });
    agent.on(evt, handler);
  }

  // Ping every 30s to keep connection alive
  const ping = setInterval(() => {
    try { res.write(":ping\n\n"); } catch { clearInterval(ping); }
  }, 30_000);

  res.on("close", () => {
    clearInterval(ping);
    for (const { event, handler } of handlers) agent.off(event, handler);
  });
});

// ── API: Dial (outbound call) ───────────────────────────────────────────

app.post("/api/dial", async (req, res) => {
  const { to, greeting } = req.body;
  if (!to) return res.status(400).json({ error: "Missing 'to' field" });

  try {
    const call = await agent.dial({
      to,
      from: PHONE,
      greeting: greeting || undefined,
    });
    res.json({ ok: true, callId: call?.id || "dispatched" });
  } catch (err) {
    console.error("[api/dial] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Hangup ─────────────────────────────────────────────────────────

app.post("/api/hangup/:id", (req, res) => {
  const call = agent.call(req.params.id);
  if (call) {
    call.hangup();
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "Call not found" });
  }
});

// ── API: Agent info ─────────────────────────────────────────────────────

app.get("/api/info", (_req, res) => {
  res.json({
    agent: AGENT_NAME,
    phone: PHONE,
    stt: STT,
    voice: VOICE,
    language: LANG,
    model: MODEL,
  });
});

// ── Static files ────────────────────────────────────────────────────────

app.use(express.static(join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(join(__dirname, "public", "index.html")));

// ── Start ───────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  📋 SSE Dashboard`);
  console.log(`  → http://localhost:${PORT}\n`);
});

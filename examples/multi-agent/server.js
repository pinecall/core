/**
 * Pinecall — Multi-Agent Example (Vapi-style)
 *
 * Agents are stored in a JSON database. Create, update, and delete
 * them via the REST API. Each agent is dynamically registered with
 * the Pinecall voice server.
 *
 * Usage:
 *   PINECALL_API_KEY=pk_... node server.js
 *
 * Then open http://localhost:3000 in your browser.
 *
 * API:
 *   GET    /api/agents          → list all agents
 *   POST   /api/agents          → create agent
 *   PATCH  /api/agents/:id      → update agent
 *   DELETE /api/agents/:id      → delete agent
 *   GET    /api/conversations   → list conversations
 *   GET    /api/events          → SSE stream (all agents)
 *   GET    /api/events?agent=X  → SSE stream (one agent)
 */

import express from "express";
import { Pinecall } from "@pinecall/sdk";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  listAgents, getAgent, createAgent, updateAgent, deleteAgent,
  saveConversation, listConversations,
} from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ── Pinecall setup ───────────────────────────────────────────────────────

const pc = new Pinecall({
  apiKey: process.env.PINECALL_API_KEY || "pk_demo",
});

// Register all agents from DB on startup
function registerAgent(record) {
  const agent = pc.agent(record.id, {
    voice: record.voice,
    language: record.language,
    stt: "deepgram-flux",
    greeting: record.greeting,
    llm: {
      engine: "openai",
      model: record.model || "gpt-4.1-mini",
      enabled: true,
      instructions: record.prompt,
    },
  });

  // Register channels
  for (const ch of record.channels || ["webrtc"]) {
    if (typeof ch === "string") {
      if (ch === "webrtc" || ch === "mic" || ch === "chat") {
        agent.addChannel(ch);
      } else {
        // Phone number
        agent.addChannel("phone", ch);
      }
    }
  }

  // Auto-save conversations
  agent.on("call.ended", (call, reason) => {
    saveConversation({
      id: call.id,
      agentId: record.id,
      from: call.from,
      transport: call.transport,
      transcript: call.transcript,
      duration: call.duration,
      startedAt: new Date(call.startedAt).toISOString(),
      endedAt: new Date().toISOString(),
    });
    console.log(`💾 Saved conversation ${call.id} for ${record.id}`);
  });

  agent.on("call.started", (call) => {
    console.log(`📞 [${record.id}] Call from ${call.from} via ${call.transport}`);
    if (record.greeting) {
      call.say(record.greeting);
    }
  });

  return agent;
}

// ── Bootstrap: register existing agents ──────────────────────────────────

for (const record of listAgents()) {
  registerAgent(record);
  console.log(`  ✓ Registered agent: ${record.id}`);
}

// ── REST API ─────────────────────────────────────────────────────────────

// List agents
app.get("/api/agents", (req, res) => {
  res.json(listAgents());
});

// Create agent
app.post("/api/agents", (req, res) => {
  const { id, name, prompt, model, voice, language, greeting, channels } = req.body;

  if (!id || !prompt) {
    return res.status(400).json({ error: "id and prompt are required" });
  }
  if (getAgent(id)) {
    return res.status(409).json({ error: `Agent '${id}' already exists` });
  }

  const record = createAgent({ id, name: name || id, prompt, model, voice, language, greeting, channels: channels || ["webrtc"] });
  registerAgent(record);
  console.log(`  ✓ Created agent: ${id}`);
  res.status(201).json(record);
});

// Update agent
app.patch("/api/agents/:id", (req, res) => {
  const record = updateAgent(req.params.id, req.body);
  if (!record) return res.status(404).json({ error: "Agent not found" });

  // Re-configure the live agent
  const agent = pc.getAgent(req.params.id);
  if (agent && req.body.prompt) {
    agent.configure({
      llm: { model: record.model || "gpt-4.1-mini", instructions: record.prompt, enabled: true },
    });
  }

  res.json(record);
});

// Delete agent
app.delete("/api/agents/:id", (req, res) => {
  const deleted = deleteAgent(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Agent not found" });

  pc.removeAgent(req.params.id);
  console.log(`  ✗ Removed agent: ${req.params.id}`);
  res.json({ ok: true });
});

// List conversations
app.get("/api/conversations", (req, res) => {
  res.json(listConversations(req.query.agent));
});

// ── SSE event stream ─────────────────────────────────────────────────────

app.get("/api/events", (req, res) => {
  const agentFilter = req.query.agent;

  if (agentFilter) {
    // Stream one agent
    const agent = pc.getAgent(agentFilter);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    agent.stream(res);
  } else {
    // Stream all agents
    pc.stream(res);
  }
});

// ── Frontend ─────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.type("html").send(readFileSync(join(__dirname, "index.html"), "utf-8"));
});

// ── Start ────────────────────────────────────────────────────────────────

await pc.connect();
app.listen(PORT, () => {
  console.log(`\n  🎙  Pinecall Multi-Agent Example`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → ${listAgents().length} agents loaded from DB\n`);
});

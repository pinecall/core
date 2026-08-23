/**
 * Pinecall — Tools Example
 *
 * One agent, one tool, and a way to prove the tool actually ran.
 *
 * `getOrderStatus` returns facts the model could not possibly guess — the port
 * "Rotterdam", the carrier "Maersk". If the agent says Rotterdam, the function
 * fired; no prompt-shaped answer can hallucinate its way to that string. That
 * is the design: a tool example is only worth anything if you can tell the
 * difference between a call and a good improvisation.
 *
 * The schema is a zod object. Its `.describe()` text is what the model reads
 * to decide what to put in each field, so it is documentation for the LLM, not
 * for you.
 *
 * Run:
 *   npm install
 *   npm start
 *
 * Test it (no phone, no human — see the README):
 *   npx pinecall test .
 *
 * Environment:
 *   PINECALL_API_KEY  — your API key
 *   AGENT             — the slug to register as (default: tools)
 *   PHONE             — a number in your org to answer on (optional, E.164)
 *   LLM               — the model to A/B without editing this file
 */

import { Pinecall, tool } from "@pinecall/sdk";
import { z } from "zod";

const AGENT = process.env.AGENT || "tools";
const PHONE = process.env.PHONE || undefined;
const LLM = process.env.LLM || "openai/gpt-4.1-mini";

if (!process.env.PINECALL_API_KEY) {
  console.error("Missing PINECALL_API_KEY");
  process.exit(1);
}

// ── The tool ─────────────────────────────────────────────────────────────

const getOrderStatus = tool({
  name: "getOrderStatus",
  description: "Look up the current shipping status of a customer order by its order id.",
  schema: z.object({
    orderId: z.string().describe("The order id, e.g. ABC-123"),
  }),
  execute: async ({ orderId }) => {
    console.log(`  getOrderStatus(${orderId})`);
    // A real implementation would hit your warehouse API here. What matters
    // for the example is that these values live nowhere but this function.
    return {
      orderId,
      status: "held in customs",
      port: "Rotterdam",
      carrier: "Maersk",
      etaDays: 6,
    };
  },
});

// ── The agent ────────────────────────────────────────────────────────────

const pc = new Pinecall();

const agent = pc.agent(AGENT, {
  llm: LLM,
  voice: "elevenlabs/sarah",
  language: "en",
  stt: "deepgram/flux",
  prompt:
    "You are a concise order-support assistant. " +
    "When a customer asks about an order, call getOrderStatus with the order id and " +
    "answer using ONLY what the tool returns. Never invent a status, port or carrier. " +
    "If you don't have an order id, ask for it.",
  phoneNumber: PHONE,
  tools: [getOrderStatus],
});

agent.on("ready", () =>
  console.log(`Agent '${AGENT}' ready — llm ${LLM}, tools: getOrderStatus`),
);
agent.on("error", (err) => console.error(`Agent refused (${err.code}): ${err.message}`));

agent.on("call.started", (call) => console.log(`Call ${call.id} from ${call.from}`));
agent.on("call.ended", (call, reason) => console.log(`Call ${call.id} ended (${reason})`));

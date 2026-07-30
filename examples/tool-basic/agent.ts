/**
 * Minimal tool-calling smoke test — one agent, one plain tool, no skills.
 *
 * The point of the design: `getOrderStatus` returns a fact the model CANNOT
 * guess (a specific port, a specific date, a specific carrier). If the agent
 * says "Rotterdam" the tool provably fired — no prompt-shaped answer can
 * hallucinate its way to that string.
 *
 * Run:   PINECALL_API_KEY=pk_… pinecall run agent.ts
 * Test:  PINECALL_API_KEY=pk_… ANTHROPIC_API_KEY=sk-… pinecall test .
 */

import { Pinecall, tool } from "@pinecall/sdk";
import { z } from "zod";

const pc = new Pinecall();

let calls = 0;

const getOrderStatus = tool({
  name: "getOrderStatus",
  description: "Look up the current shipping status of a customer order by its order id.",
  schema: z.object({
    orderId: z.string().describe("The order id, e.g. ABC-123"),
  }),
  execute: async ({ orderId }) => {
    calls++;
    console.log(`  🔧 getOrderStatus(${orderId})  [call #${calls}]`);
    return {
      orderId,
      status: "held in customs",
      port: "Rotterdam",
      carrier: "Maersk",
      etaDays: 6,
    };
  },
});

// A/B the agent's LLM without editing the file:
//   AGENT_LLM=openai/gpt-5.3-chat-latest pinecall run agent.ts
const AGENT_LLM = process.env.AGENT_LLM || "openai/gpt-4.1-mini";

const agent = pc.agent("tooltest", {
  llm: AGENT_LLM,
  prompt:
    "You are a concise order-support assistant. " +
    "When a customer asks about an order, call getOrderStatus with the order id and " +
    "answer using ONLY what the tool returns. Never invent a status, port or carrier. " +
    "If you don't have an order id, ask for it.",
  tools: [getOrderStatus],
});

agent.on("ready", () =>
  console.log(`✅ agent 'tooltest' registered — llm: ${AGENT_LLM} — tools: getOrderStatus`),
);

/**
 * Skill demo agent — verifies on-demand skill loading end to end.
 *
 * The agent starts with NO domain tools visible to the LLM — only the
 * auto-generated `loadSkill` / `unloadSkill` meta-tools. When the user asks
 * about the weather or their balance, the model must load the matching skill,
 * which exposes that skill's tool, then call it and answer.
 *
 * Run:   PINECALL_API_KEY=pk_… pinecall run agent.ts
 * Test:  PINECALL_API_KEY=pk_… pinecall test .
 */

import { Pinecall, tool, skill } from "@pinecall/sdk";
import { z } from "zod";

const pc = new Pinecall();

// ── weather skill ─────────────────────────────────────────────────────────
const getWeather = tool({
  name: "getWeather",
  description: "Get the current weather for a city.",
  schema: z.object({ city: z.string().describe("City name") }),
  execute: async ({ city }) => {
    console.log(`  🔧 getWeather(${city})`);
    return { city, tempC: 21, condition: "sunny" };
  },
});

const weather = skill({
  name: "weather",
  description: "Look up the current weather for a city.",
  instructions:
    "Use getWeather to fetch real data. Never invent weather. Report the temperature in Celsius and the condition.",
  tools: [getWeather],
});

// ── billing skill ─────────────────────────────────────────────────────────
const getBalance = tool({
  name: "getBalance",
  description: "Get the account balance for an account id.",
  schema: z.object({ accountId: z.string().describe("Account id, e.g. ACC-123") }),
  execute: async ({ accountId }) => {
    console.log(`  🔧 getBalance(${accountId})`);
    return { accountId, balanceUSD: 1234.56 };
  },
});

const billing = skill({
  name: "billing",
  description: "Answer billing and account balance questions.",
  instructions: "Use getBalance to look up a balance. Always state the amount in USD.",
  tools: [getBalance],
});

// ── agent ─────────────────────────────────────────────────────────────────
const agent = pc.agent("skilltest", {
  llm: "openai/gpt-4.1-mini",
  prompt:
    "You are Nova, a concise assistant. You have skills you can load on demand. " +
    "When a request needs a capability you don't currently have, load the matching " +
    "skill first, then use its tool to answer. Unload a skill when you're done with it.",
  skills: [weather, billing],
});

agent.on("skill.loaded", (e, _call) => console.log(`🧩 skill.loaded: ${e.skill} (by ${e.by})`));
agent.on("skill.unloaded", (e, _call) => console.log(`🧩 skill.unloaded: ${e.skill}`));

console.log("✅ agent 'skilltest' registered — skills: weather, billing (latent until loaded)");

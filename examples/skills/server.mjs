/**
 * Pinecall — Skills Example
 *
 * A tool the model can see is a tool the model has to consider. Twenty of them
 * and the prompt is mostly menu. A `skill()` is a bundle of tools plus its own
 * instructions that stays LATENT: the model sees only a name and a one-line
 * description, and must load the skill before it can call anything inside.
 *
 * So this agent starts with no domain tools at all — only the `loadSkill` and
 * `unloadSkill` meta-tools the SDK generates for it. Ask about the weather and
 * the model has to load `weather` first, which is what makes the flow visible:
 * `skill.loaded` fires before the tool call, every time.
 *
 * Skills need the server-side LLM (a managed key on a paid org).
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
 *   AGENT             — the slug to register as (default: skills)
 *   PHONE             — a number in your org to answer on (optional, E.164)
 */

import { Pinecall, tool, skill } from "@pinecall/sdk";
import { z } from "zod";

const AGENT = process.env.AGENT || "skills";
const PHONE = process.env.PHONE || undefined;

if (!process.env.PINECALL_API_KEY) {
  console.error("Missing PINECALL_API_KEY");
  process.exit(1);
}

// ── weather ──────────────────────────────────────────────────────────────

const getWeather = tool({
  name: "getWeather",
  description: "Get the current weather for a city.",
  schema: z.object({ city: z.string().describe("City name") }),
  execute: async ({ city }) => {
    console.log(`  getWeather(${city})`);
    return { city, tempC: 21, condition: "sunny" };
  },
});

const weather = skill({
  name: "weather",
  description: "Look up the current weather for a city.",
  // `instructions` reach the model only once the skill is loaded — this is how
  // a skill carries its own rules without spending prompt on them upfront.
  instructions:
    "Use getWeather to fetch real data. Never invent weather. Report the temperature in Celsius and the condition.",
  tools: [getWeather],
});

// ── billing ──────────────────────────────────────────────────────────────

const getBalance = tool({
  name: "getBalance",
  description: "Get the account balance for an account id.",
  schema: z.object({ accountId: z.string().describe("Account id, e.g. ACC-123") }),
  execute: async ({ accountId }) => {
    console.log(`  getBalance(${accountId})`);
    return { accountId, balanceUSD: 1234.56 };
  },
});

const billing = skill({
  name: "billing",
  description: "Answer billing and account balance questions.",
  instructions: "Use getBalance to look up a balance. Always state the amount in USD.",
  tools: [getBalance],
});

// ── The agent ────────────────────────────────────────────────────────────

const pc = new Pinecall();

const agent = pc.agent(AGENT, {
  llm: "openai/gpt-4.1-mini",
  voice: "elevenlabs/sarah",
  language: "en",
  stt: "deepgram/flux",
  prompt:
    "You are Nova, a concise assistant. You have skills you can load on demand. " +
    "When a request needs a capability you don't currently have, load the matching " +
    "skill first, then use its tool to answer. Unload a skill when you're done with it.",
  phoneNumber: PHONE,

  // Not `tools` — these are latent until the model asks for them.
  skills: [weather, billing],
});

agent.on("ready", () =>
  console.log(`Agent '${AGENT}' ready — skills: weather, billing (latent until loaded)`),
);
agent.on("error", (err) => console.error(`Agent refused (${err.code}): ${err.message}`));

agent.on("skill.loaded", (event) => console.log(`  skill.loaded: ${event.skill} (by ${event.by})`));
agent.on("skill.unloaded", (event) => console.log(`  skill.unloaded: ${event.skill}`));

agent.on("call.started", (call) => console.log(`Call ${call.id} from ${call.from}`));
agent.on("call.ended", (call, reason) => console.log(`Call ${call.id} ended (${reason})`));

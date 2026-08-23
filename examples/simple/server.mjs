/**
 * Pinecall — Simple Example
 *
 * The smallest agent that is still worth running: a prompt, a voice, and a
 * place to keep what was said. `history` is the only line that is not
 * obvious — hand the agent a store and every finished call writes itself
 * there, so the transcript outlives the process without a callback.
 *
 * With no PHONE the agent registers browser-only: it is online and reachable
 * from a widget or `pinecall chat`, it just owns no number.
 *
 * Run:
 *   npm install
 *   npm start
 *
 * Environment:
 *   PINECALL_API_KEY  — your API key
 *   AGENT             — the slug to register as (default: simple)
 *   PHONE             — a number in your org to answer on (optional, E.164)
 */

import { Pinecall, JsonFileHistory } from "@pinecall/sdk";

const AGENT = process.env.AGENT || "simple";
const PHONE = process.env.PHONE || undefined;

if (!process.env.PINECALL_API_KEY) {
  console.error("Missing PINECALL_API_KEY");
  process.exit(1);
}

const pc = new Pinecall();

const agent = pc.agent(AGENT, {
  voice: "elevenlabs/sarah",
  language: "en",
  stt: "deepgram/flux",
  llm: "openai/gpt-4.1-mini",
  prompt:
    "You are a friendly assistant. Keep your responses short (1-2 sentences) since this is a voice call.",
  greeting: "Hello! How can I help you today?",
  phoneNumber: PHONE,

  // Every call is appended here when it ends — no save() call of your own.
  // Swap in any object with save()/findByContact() to use a real database.
  history: new JsonFileHistory("./data/calls.json"),
});

agent.on("ready", () =>
  console.log(`Agent '${AGENT}' ready${PHONE ? ` on ${PHONE}` : " (browser only — no PHONE set)"}`),
);
agent.on("error", (err) => console.error(`Agent refused (${err.code}): ${err.message}`));

agent.on("call.started", (call) => console.log(`Call ${call.id} from ${call.from}`));
agent.on("call.ended", (call, reason) =>
  console.log(`Call ${call.id} ended (${reason}) — saved to ./data/calls.json`),
);

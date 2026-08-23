/**
 * Pinecall — History Example
 *
 * A caller who rings twice should not have to introduce themselves twice.
 *
 * `history` on the agent is the write half: every call is saved when it ends,
 * automatically. This example adds the read half — on `call.started` it looks
 * the caller up by their number and, if there is a previous conversation,
 * pushes those messages into the live call's LLM context with
 * `call.setHistory()`. From the model's point of view the earlier call simply
 * continues.
 *
 * `JsonFileHistory` is the built-in store, a file. Swap in your own object
 * with the same `save()` / `findByContact()` shape to use a real database.
 *
 * Run:
 *   npm install
 *   npm start
 *
 * Environment:
 *   PINECALL_API_KEY  — your API key
 *   AGENT             — the slug to register as (default: history)
 *   PHONE             — a number in your org to answer on (optional, E.164)
 */

import { Pinecall, JsonFileHistory } from "@pinecall/sdk";

const AGENT = process.env.AGENT || "history";
const PHONE = process.env.PHONE || undefined;

if (!process.env.PINECALL_API_KEY) {
  console.error("Missing PINECALL_API_KEY");
  process.exit(1);
}

const history = new JsonFileHistory("./data/calls.json");

const pc = new Pinecall();

const agent = pc.agent(AGENT, {
  voice: "elevenlabs/sarah",
  language: "en",
  stt: "deepgram/flux",
  llm: "openai/gpt-4.1-mini",
  prompt: `You are a friendly assistant with memory of past conversations.
When you have prior conversation context, reference things discussed before so
the caller feels recognised. Keep responses short (1-2 sentences) since this is
a voice call.`,
  phoneNumber: PHONE,

  // The write half: saved on call.ended, with no code from you.
  history,
});

agent.on("ready", () =>
  console.log(`Agent '${AGENT}' ready${PHONE ? ` on ${PHONE}` : " (browser only — no PHONE set)"}`),
);
agent.on("error", (err) => console.error(`Agent refused (${err.code}): ${err.message}`));

// ── The read half ────────────────────────────────────────────────────────

agent.on("call.started", async (call) => {
  const contactId = contactOf(call);
  console.log(`Call ${call.id} from ${contactId ?? "(unknown contact)"}`);

  // Nobody to look up — an anonymous browser session, say.
  if (!contactId) {
    call.say("Hello! I'm an assistant with memory.");
    return;
  }

  const prior = await history.findByContact(contactId, 100);

  if (prior.length === 0) {
    console.log("  first call — nothing to restore");
    call.say("Hello! Call me again and I'll remember what we talked about.");
    return;
  }

  const last = prior[0];
  console.log(`  ${prior.length} previous call(s), restoring ${last.messages.length} messages`);

  // This is the line that matters: the previous conversation becomes the
  // opening context of this one.
  await call.setHistory(last.messages);

  call.say(`Welcome back! This is call number ${prior.length + 1}. I remember our last conversation.`);
});

agent.on("call.ended", (call, reason) =>
  console.log(`Call ${call.id} ended (${reason}) — ${call.messages?.length ?? 0} messages saved`),
);

// ── Helpers ──────────────────────────────────────────────────────────────

/** Who is on the other end: the phone number, or a userId for browser calls. */
function contactOf(call) {
  if (call.from && call.from !== "webrtc") return call.from;
  return call.metadata?.userId ? String(call.metadata.userId) : null;
}

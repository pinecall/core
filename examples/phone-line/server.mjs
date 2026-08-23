/**
 * Pinecall — Phone Line Example
 *
 * A business front line with NO agent in it. `pc.line()` claims the number,
 * and everything the caller hears until the hand-over is decided by the code
 * below: no prompt, no model, no tokens spent.
 *
 * The caller hears a greeting the instant the call connects, then ONE menu:
 *
 *     1 → opening hours      (a constant, spoken)
 *     2 → the address        (a constant, spoken)
 *     3 → a person           (forward — the call leaves Pinecall)
 *     0 → the assistant      (routeTo — the LIVE call is handed to an agent)
 *
 * A press cuts the menu short; silence gets one repeat and then a polite
 * goodbye. What was said is printed on `call.ended`.
 *
 * Usage:
 *   PINECALL_API_KEY=pk_... LINE_NUMBER=+1... AGENT=my-agent HUMAN=+1... node server.mjs
 *
 * Environment:
 *   PINECALL_API_KEY  — your API key
 *   LINE_NUMBER       — the phone number this line owns (E.164)
 *   AGENT             — the agent slug option 0 hands callers to
 *   HUMAN             — a real phone number option 3 forwards to
 *   PINECALL_URL      — override the voice server (optional; used by the smoke test)
 */

import { Pinecall } from "@pinecall/sdk";

const LINE_NUMBER = process.env.LINE_NUMBER;
const AGENT = process.env.AGENT || "reception";
const HUMAN = process.env.HUMAN;

if (!process.env.PINECALL_API_KEY) {
  console.error("Missing PINECALL_API_KEY");
  process.exit(1);
}
if (!LINE_NUMBER) {
  console.error("Missing LINE_NUMBER (e.g. LINE_NUMBER=+12186633772)");
  process.exit(1);
}

// ── The business, as constants ───────────────────────────────────────────
// This is the whole point: none of it goes near a model.

const SCRIPT = {
  greeting: "Thanks for calling Mill Street Dental.",
  menu: "Press one for opening hours, two for our address, three to speak to somebody, or zero for our assistant.",
  hours: "We are open Monday to Friday, nine in the morning to six in the evening.",
  address: "We are at forty-two Mill Street, in Duluth, Minnesota.",
  human: "Putting you through. One moment.",
  unavailable: "Sorry, nobody is available right now. Please call back later.",
  lost: "Sorry, I didn't get that. Goodbye.",
};

// ── The line ─────────────────────────────────────────────────────────────

const pc = new Pinecall(
  process.env.PINECALL_URL ? { apiUrl: process.env.PINECALL_URL } : {},
);

const line = pc.line(LINE_NUMBER, {
  stt: "soniox/stt-rt-v5",
  voice: "elevenlabs/sarah",
  language: "en",
  // Speak the moment the call connects. A post-dial extension window
  // (`extension: { window: 2500 }`) would let "+1…,10" skip the menu, but it
  // is 2.5 s of silence for every caller — not worth it on a front line.
  extension: { window: 0 },
});

line.on("ready", () => console.log(`Line ready on ${pretty(LINE_NUMBER)}`));
line.on("error", (err) => console.error(`Line refused (${err.code}): ${err.message}`));

// ── The flow ─────────────────────────────────────────────────────────────

line.on("call", async (call) => {
  console.log(`Call ${call.id} from ${call.from}`);

  await call.say(SCRIPT.greeting);

  // Ask once, and once more for a caller who said nothing — a menu read twice
  // is the most a front line should ever do before letting go.
  let choice = await call.ask(SCRIPT.menu, { digits: 1, timeout: 5000 });
  if (choice.by === "timeout") choice = await call.ask(SCRIPT.menu, { digits: 1, timeout: 5000 });

  if (choice.by !== "keypad") {
    await call.say(SCRIPT.lost);
    call.hangup("no_selection");
    return;
  }

  switch (choice.digit) {
    case "1":
      await call.say(SCRIPT.hours);
      call.hangup("done");
      return;

    case "2":
      await call.say(SCRIPT.address);
      call.hangup("done");
      return;

    case "3":
      if (!HUMAN) {
        await call.say(SCRIPT.unavailable);
        call.hangup("no_human_configured");
        return;
      }
      await call.say(SCRIPT.human);
      // forward LEAVES Pinecall — a real phone rings, and nothing we do
      // reaches the call after this.
      call.forward(HUMAN);
      return;

    case "0":
    default: {
      // routeTo keeps the call INSIDE Pinecall: same audio stream, no re-dial.
      // The agent gets a normal call.started carrying routedFrom and
      // everything the line heard.
      const routed = await call.routeTo(AGENT, {
        context: { came_from: "front_line" },
      });
      if (!routed.ok) {
        // An offline agent is OUR decision, not a dead number.
        console.warn(`route to ${AGENT} failed: ${routed.reason}`);
        await call.say(SCRIPT.unavailable);
        call.hangup("agent_offline");
      }
      return;
    }
  }
});

line.on("call.ended", (call, reason) => {
  console.log(`Call ${call.id} ended (${reason})`);
  for (const entry of call.transcript) {
    console.log(`  ${entry.who === "line" ? "line  " : "caller"} ${entry.text}`);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────

function pretty(number) {
  return number.replace(/^(\+\d)(\d{3})(\d{3})(\d{4})$/, "$1 $2 $3 $4");
}

// Keep the process alive; the SDK owns the socket.
process.on("SIGINT", () => {
  line.destroy();
  pc.disconnect();
  process.exit(0);
});

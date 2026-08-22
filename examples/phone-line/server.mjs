/**
 * Pinecall — Phone Line Example
 *
 * A business front line with NO agent in it. `pc.line()` claims the number,
 * and everything the caller hears until the hand-over is decided by the code
 * below: no prompt, no model, no tokens spent.
 *
 * What it does:
 *   1. Reads the extension the caller dialled (`+1…,10`) and routes 10 straight
 *      to an agent — no menu, no question.
 *   2. Otherwise asks for a language, by keypad OR by voice.
 *   3. Offers a menu that is pure code:
 *        1 → opening hours (a constant, spoken)
 *        2 → the address (a constant, spoken)
 *        3 → forward to a human, out of Pinecall
 *        0 → hand the LIVE call to the agent, in the chosen language
 *   4. Logs what was said on `call.ended`.
 *
 * Usage:
 *   PINECALL_API_KEY=pk_... LINE_NUMBER=+1... AGENT=my-agent HUMAN=+1... node server.mjs
 *
 * Environment:
 *   PINECALL_API_KEY  — your API key
 *   LINE_NUMBER       — the phone number this line owns (E.164)
 *   AGENT             — the agent slug to hand callers to
 *   HUMAN             — a real phone number to forward to (option 3)
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
  en: {
    voice: "elevenlabs/sarah",
    menu: "Press one for opening hours, two for our address, three to speak to somebody, or zero for our assistant.",
    hours: "We are open Monday to Friday, nine in the morning to six in the evening.",
    address: "We are at forty-two Mill Street, in Duluth, Minnesota.",
    human: "Putting you through. One moment.",
    unavailable: "Sorry, nobody is available right now. Please call back later.",
    lost: "Sorry, I didn't get that. Goodbye.",
  },
  es: {
    voice: "elevenlabs/marta",
    menu: "Marque uno para el horario, dos para la dirección, tres para hablar con una persona, o cero para nuestro asistente.",
    hours: "Abrimos de lunes a viernes, de nueve de la mañana a seis de la tarde.",
    address: "Estamos en la calle Mill cuarenta y dos, en Duluth, Minnesota.",
    human: "Le paso. Un momento.",
    unavailable: "Lo siento, no hay nadie disponible ahora mismo. Vuelva a llamar más tarde.",
    lost: "Lo siento, no le he entendido. Hasta luego.",
  },
};

// ── The line ─────────────────────────────────────────────────────────────

const pc = new Pinecall(
  process.env.PINECALL_URL ? { apiUrl: process.env.PINECALL_URL } : {},
);

const line = pc.line(LINE_NUMBER, {
  stt: "soniox/stt-rt-v5",      // multilingual — nobody knows the caller's language yet
  voice: "elevenlabs/sarah",
  language: "en",
  extension: { window: 2500 },  // ms of silence after connect to collect `+1…,10`
});

line.on("ready", () => {
  console.log(`Line ready on ${line.number}`);
  console.log(`  direct to the agent:  ${pretty(LINE_NUMBER)}, 10`);
  console.log(`  the menu:             ${pretty(LINE_NUMBER)}`);
});

line.on("error", (err) => {
  console.error(`Line refused (${err.code}): ${err.message}`);
});

// Extension 10 is the agent's own door: dialled with a pause, it skips
// everything below. "*" is left out on purpose — a call with no extension
// falls through to the handler.
line.extensions({
  "10": AGENT,
});

// ── The flow ─────────────────────────────────────────────────────────────

line.on("call", async (call) => {
  console.log(`Call ${call.id} from ${call.from} (extension: ${call.extension ?? "none"})`);

  const lang = await pickLanguage(call);
  const s = SCRIPT[lang];
  // Everything from here is spoken in the caller's language.
  call.context("language", lang);

  const choice = await call.ask(s.menu, { digits: 1, timeout: 6000, language: lang });

  if (choice.by !== "keypad") {
    await call.say(s.lost, { voice: s.voice });
    call.hangup("no_selection");
    return;
  }

  switch (choice.digit) {
    case "1":
      await call.say(s.hours, { voice: s.voice });
      call.hangup("done");
      return;

    case "2":
      await call.say(s.address, { voice: s.voice });
      call.hangup("done");
      return;

    case "3":
      if (!HUMAN) {
        await call.say(s.unavailable, { voice: s.voice });
        call.hangup("no_human_configured");
        return;
      }
      await call.say(s.human, { voice: s.voice });
      // forward LEAVES Pinecall — a real phone rings, and nothing we do
      // reaches the call after this.
      call.forward(HUMAN);
      return;

    case "0":
    default: {
      // routeTo keeps the call INSIDE Pinecall: same audio stream, no re-dial.
      // The agent gets a normal call.started carrying routedFrom, extension
      // and everything the line heard.
      const routed = await call.routeTo(AGENT, {
        language: lang,
        voice: s.voice,
        context: { came_from: "front_line", language: lang },
      });
      if (!routed.ok) {
        // An offline agent is OUR decision, not a dead number.
        console.warn(`route to ${AGENT} failed: ${routed.reason}`);
        await call.say(s.unavailable, { voice: s.voice });
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

/**
 * Ask for a language and take the answer from EITHER input — the keypad, or
 * the caller's voice off the same session the agent will keep using.
 */
async function pickLanguage(call) {
  const answer = await call.ask(
    "For English, press one or say English. Para español, marque dos o diga español.",
    { digits: 1, speech: true, timeout: 5000 },
  );

  if (answer.by === "keypad") return answer.digit === "2" ? "es" : "en";
  if (answer.by === "speech" && /espa|spanish/i.test(answer.text)) return "es";
  return "en";                                    // timeout, or anything else
}

/** The one printable form of a number with an extension: a comma, never `#`. */
function pretty(number) {
  return number.replace(/^(\+\d)(\d{3})(\d{3})(\d{4})$/, "$1 $2 $3 $4");
}

// Keep the process alive; the SDK owns the socket.
process.on("SIGINT", () => {
  line.destroy();
  pc.disconnect();
  process.exit(0);
});

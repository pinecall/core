/**
 * Pinecall — Outbound Dispatch Example
 *
 * Inbound is one call at a time. Outbound is a list, and a list needs a pace,
 * a memory of who has already been rung, and somewhere to put the answer.
 * `DispatchHub` is that: it watches a source, places calls within limits you
 * set, and never rings the same row twice.
 *
 * Here the source is a CSV. A row with no `status` is work; a row with one is
 * done. The agent writes the status back with a tool when the contact answers,
 * and the hub writes it back for the calls nobody picked up — so the file is
 * both the queue and the result, and re-running is safe.
 *
 * Add a row to data/leads.csv while this is running and the call goes out on
 * the next poll.
 *
 * This one dials real numbers. Point it at your own before you run it.
 *
 * Run:
 *   npm install
 *   npm start
 *
 * Environment:
 *   PINECALL_API_KEY  — your API key
 *   AGENT             — the slug to register as (default: outbound-dispatch)
 *   PHONE             — the number to call FROM (E.164, required)
 *   LEADS             — path to the CSV (default: ./data/leads.csv)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { Pinecall, tool } from "@pinecall/sdk";
import { DispatchHub, CsvStrategy } from "@pinecall/dispatch";
import { z } from "zod";

const AGENT = process.env.AGENT || "outbound-dispatch";
const PHONE = process.env.PHONE;
const LEADS = process.env.LEADS || "./data/leads.csv";

if (!process.env.PINECALL_API_KEY) {
  console.error("Missing PINECALL_API_KEY");
  process.exit(1);
}
if (!PHONE) {
  console.error("Missing PHONE — outbound calls need a number to call from");
  process.exit(1);
}

// ── The CSV is the queue AND the result ──────────────────────────────────

/** Stamp a status onto the row for this phone + service, adding the column if needed. */
function recordStatus(phone, service, status) {
  const lines = readFileSync(LEADS, "utf-8").split("\n").filter((line) => line.trim());
  if (lines.length === 0) return;

  const hasStatusColumn = lines[0].toLowerCase().includes("status");
  if (!hasStatusColumn) lines[0] += ",status";

  // Match on phone AND service: the same person can be due two appointments.
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].includes(phone) && lines[i].includes(service)) {
      lines[i] = hasStatusColumn ? lines[i].replace(/,[^,]*$/, `,${status}`) : `${lines[i]},${status}`;
      break;
    }
  }

  writeFileSync(LEADS, `${lines.join("\n")}\n`);
  console.log(`  ${phone} (${service}) → ${status}`);
}

/** True when this row already carries a status — never overwrite an outcome. */
function alreadyRecorded(phone, service) {
  for (const line of readFileSync(LEADS, "utf-8").split("\n")) {
    if (!line.includes(phone) || !line.includes(service)) continue;
    const columns = line.split(",");
    return columns.length > 5 && Boolean(columns.at(-1).trim());
  }
  return false;
}

// ── The agent ────────────────────────────────────────────────────────────

const PROMPT = `
# APPOINTMENT REMINDER ASSISTANT

You are a friendly assistant calling to remind people about an upcoming
appointment. Be warm, concise and helpful.

## APPOINTMENT DETAILS
{{appointment_details}}

## INSTRUCTIONS
- Greet the contact by name
- Mention the appointment date, time and service
- Ask: "Can you confirm you'll be there?"
- If they confirm -> call confirm_appointment with status "confirmed"
- If they want to cancel -> call confirm_appointment with status "cancelled"
- If they want to reschedule -> call confirm_appointment with status "reschedule"
- Keep every response under 20 words
`.trim();

const confirmAppointment = tool({
  name: "confirm_appointment",
  description:
    "Record the appointment status after the contact responds. " +
    "Call this once the person confirms, cancels, or requests rescheduling.",
  schema: z.object({
    status: z.enum(["confirmed", "cancelled", "reschedule"]).describe("The appointment outcome"),
    notes: z.string().optional().describe("Optional notes from the conversation"),
  }),
  execute: async ({ status, notes }, call) => {
    // The metadata the strategy attached to this record comes back on the call.
    const { name = "unknown", phone = "", service = "" } = call.metadata ?? {};
    console.log(`Answer from ${name} (${service}): ${status}${notes ? ` — ${notes}` : ""}`);
    recordStatus(phone, service, status);
    return { success: true, status };
  },
});

const pc = new Pinecall();

const agent = pc.agent(AGENT, {
  voice: "elevenlabs/sarah",
  language: "en",
  stt: "deepgram/flux",
  llm: "openai/gpt-4.1-mini",
  prompt: PROMPT,
  phoneNumber: PHONE,
  tools: [confirmAppointment],
});

agent.on("ready", () => console.log(`Agent '${AGENT}' ready — dialling from ${PHONE}`));
agent.on("error", (err) => console.error(`Agent refused (${err.code}): ${err.message}`));

agent.on("call.started", (call) =>
  console.log(`Calling ${call.to}${call.metadata?.name ? ` — ${call.metadata.name}` : ""}`),
);
agent.on("call.ended", (call, reason) =>
  console.log(`Call ${call.id} ended (${reason}, ${Math.round(call.duration)}s)`),
);

// ── The source ───────────────────────────────────────────────────────────

const leads = new CsvStrategy({
  file: LEADS,
  // Return null to skip a row. A row with a status has been handled already —
  // this is what makes restarting the process harmless.
  mapRow: (row) => {
    if (!row.phone) return null;
    if (row.status?.trim()) return null;

    return {
      id: `${row.phone}-${row.service}-${row.date}`,
      phone: row.phone,
      greeting: `Hi ${row.name}, this is a reminder about your appointment on ${row.date} at ${row.time}. Can you confirm you'll be there?`,
      metadata: { name: row.name, phone: row.phone, service: row.service, date: row.date, time: row.time },
      promptVars: {
        appointment_details: [
          `Contact: ${row.name}`,
          `Service: ${row.service}`,
          `Date: ${row.date}`,
          `Time: ${row.time}`,
        ].join("\n"),
      },
    };
  },
});

// A call can end without the agent ever calling the tool — voicemail, a hangup,
// a refusal. Those rows still need an outcome, or the hub will ring them forever.
leads.onCompleted = (record, _callId, reason) => {
  const { phone = record.phone, service = "" } = record.metadata ?? {};
  if (alreadyRecorded(phone, service)) return;
  recordStatus(phone, service, reason);
};

leads.onFailed = (record) => {
  const { phone = record.phone, service = "" } = record.metadata ?? {};
  recordStatus(phone, service, "no_answer");
};

// ── The pace ─────────────────────────────────────────────────────────────

const hub = new DispatchHub({
  agent,
  strategies: [leads],
  from: PHONE,
  maxCallsPerMinute: 5,
  maxConcurrent: 2,
  retryAttempts: 1,
  pollIntervalMs: 5000,
});

hub.start();
console.log(`Dispatching from ${LEADS} — 5 calls/min, 2 at a time. Ctrl-C to stop.`);

process.on("SIGINT", () => {
  hub.stop();
  pc.disconnect();
  process.exit(0);
});

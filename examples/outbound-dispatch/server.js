/**
 * Pinecall — Outbound Dispatch Example
 *
 * Reads leads from a CSV and dispatches outbound appointment reminder
 * calls. Each call gets a personalized greeting and prompt context.
 * When the contact confirms or cancels, the AI calls the
 * `confirm_appointment` tool which writes the result back to the CSV.
 *
 * Usage:
 *   cp .env.example .env  # set your API key and phone
 *   npm install
 *   node server.js
 *
 * Then add rows to data/leads.csv while the script runs —
 * the dispatcher detects new rows and places calls automatically.
 */

import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { Pinecall, tool } from "@pinecall/sdk";
import { DispatchHub, CsvStrategy } from "@pinecall/dispatch";
import { z } from "zod";

const API_KEY = process.env.PINECALL_API_KEY;
const PHONE = process.env.PHONE;

if (!API_KEY) {
  console.error("Missing PINECALL_API_KEY");
  process.exit(1);
}
if (!PHONE) {
  console.error("Missing PHONE (e.g. PHONE=+15551234567)");
  process.exit(1);
}

// ── CSV result writer ────────────────────────────────────────────────────────

const CSV_PATH = "./data/leads.csv";

/**
 * Writes a result back to the CSV by appending/updating a `status` column.
 * Finds the row by phone number and updates the status value.
 */
function writeResultToCsv(phone, service, status) {
  const content = readFileSync(CSV_PATH, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return;

  // Ensure header has a 'status' column
  const header = lines[0];
  const hasStatus = header.toLowerCase().includes("status");
  if (!hasStatus) lines[0] = header + ",status";

  // Find the row matching both phone AND service (handles duplicate phones)
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].includes(phone) && lines[i].includes(service)) {
      lines[i] = hasStatus
        ? lines[i].replace(/,[^,]*$/, `,${status}`)
        : lines[i] + `,${status}`;
      break;
    }
  }

  writeFileSync(CSV_PATH, lines.join("\n") + "\n");
  console.log(`  📝 CSV updated: ${phone} (${service}) → ${status}`);
}

// ── Prompt ───────────────────────────────────────────────────────────────────

const PROMPT = `
# APPOINTMENT REMINDER ASSISTANT

You are a friendly AI assistant calling to remind people about their upcoming
appointments. Be warm, concise, and helpful.

## APPOINTMENT DETAILS
{{appointment_details}}

## INSTRUCTIONS
- Greet the contact by name
- Mention the appointment date, time, and service
- Ask: "Can you confirm you'll be there?"
- If they confirm → call confirm_appointment with status "confirmed"
- If they want to cancel → call confirm_appointment with status "cancelled"
- If they want to reschedule → call confirm_appointment with status "reschedule"
- Keep every response under 20 words
- Be polite and professional
`.trim();

// ── Tools ────────────────────────────────────────────────────────────────────

const confirmAppointment = tool({
  name: "confirm_appointment",
  description:
    "Record the appointment status after the contact responds. " +
    "Call this once the person confirms, cancels, or requests rescheduling.",
  schema: z.object({
    status: z
      .enum(["confirmed", "cancelled", "reschedule"])
      .describe("The appointment outcome"),
    notes: z
      .string()
      .optional()
      .describe("Optional notes from the conversation"),
  }),
  execute: async ({ status, notes }, call) => {
    const name = call.metadata?.name ?? "Unknown";
    const phone = call.metadata?.phone ?? "";
    const service = call.metadata?.service ?? "";

    console.log(`\n  ✅ APPOINTMENT UPDATE`);
    console.log(`     Contact:  ${name}`);
    console.log(`     Service:  ${service}`);
    console.log(`     Status:   ${status.toUpperCase()}`);
    if (notes) console.log(`     Notes:    ${notes}`);

    // Write result back to CSV
    writeResultToCsv(phone, service, status);

    return { success: true, status };
  },
});

// ── Pinecall setup ───────────────────────────────────────────────────────────

const pc = new Pinecall({ apiKey: API_KEY });
await pc.connect();

const agent = pc.agent("reminder-agent", {
  voice: "elevenlabs/sarah",
  language: "en",
  stt: "deepgram/flux",
  llm: "openai/gpt-4.1-mini",
  prompt: PROMPT,
  phoneNumber: PHONE,
  tools: [confirmAppointment],
});

// ── Call lifecycle logging ───────────────────────────────────────────────────

agent.on("call.started", (call) => {
  console.log(`\n📞 Call started: ${call.from} → ${call.to}`);
  if (call.metadata?.name) {
    console.log(`   Contact: ${call.metadata.name} | ${call.metadata.service}`);
  }
});

agent.on("call.ended", (call, reason) => {
  console.log(`📴 Call ended: ${reason} (${Math.round(call.duration)}s)\n`);
});

// ── CSV Strategy ─────────────────────────────────────────────────────────────

const csv = new CsvStrategy({
  file: CSV_PATH,
  mapRow: (row, index) => {
    if (!row.phone) return null;

    // Skip rows that already have a status (already processed)
    if (row.status && row.status.trim()) return null;

    return {
      id: `${row.phone}-${row.service}-${row.date}`,
      phone: row.phone,
      greeting: `Hi ${row.name}, this is a reminder about your appointment on ${row.date} at ${row.time}. Can you confirm you'll be there?`,
      metadata: {
        name: row.name,
        phone: row.phone,
        service: row.service,
        date: row.date,
        time: row.time,
      },
      promptVars: {
        appointment_details: [
          `Contact: ${row.name}`,
          `Phone: ${row.phone}`,
          `Service: ${row.service}`,
          `Date: ${row.date}`,
          `Time: ${row.time}`,
        ].join("\n"),
      },
    };
  },
});

// Write status for calls that end without the AI calling the tool
// (rejected, no answer, hangup before tool call)
csv.onCompleted = (record, _callId, reason) => {
  const phone = record.metadata?.phone ?? record.phone;
  const service = record.metadata?.service ?? "";
  // Don't overwrite if the tool already wrote a status
  const content = readFileSync(CSV_PATH, "utf-8");
  for (const line of content.split("\n")) {
    if (line.includes(phone) && line.includes(service)) {
      const cols = line.split(",");
      if (cols.length > 5 && cols[cols.length - 1].trim()) return; // Already has status
    }
  }
  writeResultToCsv(phone, service, reason);
};

csv.onFailed = (record, error) => {
  const phone = record.metadata?.phone ?? record.phone;
  const service = record.metadata?.service ?? "";
  writeResultToCsv(phone, service, "no_answer");
};

// ── Dispatch Hub ─────────────────────────────────────────────────────────────

const hub = new DispatchHub({
  agent,
  strategies: [csv],
  from: PHONE,
  maxCallsPerMinute: 5,
  maxConcurrent: 2,
  retryAttempts: 1,
  pollIntervalMs: 5000,
});

hub.start();

console.log(`
  Pinecall Outbound Dispatch Example
  ───────────────────────────────────
  Phone:     ${PHONE}
  CSV:       ${CSV_PATH}
  Rate:      5 calls/min, 2 concurrent

  Add rows to the CSV to trigger calls.
  Results are written back to the CSV.
`);

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down…");
  hub.stop();
  pc.disconnect();
  process.exit(0);
});

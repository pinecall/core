/**
 * Pinecall — Reservations Example
 *
 * What a real tool-using agent looks like once there is more than one tool:
 * three of them, in an order the prompt enforces. Check availability BEFORE
 * offering a time, book ONLY after the caller confirms, cancel ONLY after they
 * say so. The model is not trusted to invent a free table — every "yes" comes
 * out of `checkAvailability`.
 *
 * The bookings live in a Map, so they vanish when you stop the process. That
 * is deliberate: this file is about the tool choreography, not storage.
 *
 * Run:
 *   npm install
 *   npm start
 *
 * Environment:
 *   PINECALL_API_KEY  — your API key
 *   AGENT             — the slug to register as (default: reservations)
 *   PHONE             — a number in your org to answer on (optional, E.164)
 */

import { Pinecall, tool } from "@pinecall/sdk";
import { z } from "zod";

const AGENT = process.env.AGENT || "reservations";
const PHONE = process.env.PHONE || undefined;

if (!process.env.PINECALL_API_KEY) {
  console.error("Missing PINECALL_API_KEY");
  process.exit(1);
}

// ── The book, such as it is ──────────────────────────────────────────────

/** @type {Map<string, { id: string, name: string, date: string, time: string, partySize: number, table: string }>} */
const reservations = new Map();

const OPENS = 11;
const CLOSES = 22;
const MAX_PARTY = 8;

/** The room a party of this size gets — the same rule in both tools. */
function tableFor(partySize) {
  if (partySize <= 2) return "window seat";
  if (partySize <= 4) return "garden terrace";
  return "private dining";
}

// ── Tools ────────────────────────────────────────────────────────────────

const checkAvailability = tool({
  name: "checkAvailability",
  description:
    "Check table availability for a date, time and party size. " +
    "Call this BEFORE offering the caller any time — never guess availability.",
  schema: z.object({
    date: z.string().describe("Date in YYYY-MM-DD format"),
    time: z.string().describe("Time in HH:MM format (24h)"),
    partySize: z.number().describe("Number of guests"),
  }),
  execute: async ({ date, time, partySize }) => {
    const hour = Number.parseInt(time.split(":")[0], 10);
    const isWeekend = new Date(date).getDay() % 6 === 0;

    // A refusal is more useful than a bare false: the model reads `reason`
    // out loud and `suggestion` becomes the next thing it offers.
    if (partySize > MAX_PARTY) {
      return {
        available: false,
        reason: `Maximum party size is ${MAX_PARTY} guests`,
        suggestion: "For larger groups, please email events@pines.example",
      };
    }
    if (hour < OPENS || hour > CLOSES) {
      return {
        available: false,
        reason: `We are open from ${OPENS}:00 to ${CLOSES}:00`,
        nextAvailable: hour < OPENS ? `${OPENS}:00` : `${OPENS}:00 next day`,
      };
    }
    if (isWeekend && hour >= 18 && hour <= 21 && partySize > 4) {
      return {
        available: false,
        reason: "Weekend dinner is fully booked for large parties",
        nextAvailable: "22:00, or a weekday",
      };
    }

    return {
      available: true,
      table: tableFor(partySize),
      estimatedDuration: partySize <= 4 ? "1.5 hours" : "2 hours",
    };
  },
});

const makeReservation = tool({
  name: "makeReservation",
  description:
    "Confirm and create a reservation. " +
    "ONLY call after the caller has explicitly confirmed the booking.",
  schema: z.object({
    name: z.string().describe("Guest name for the reservation"),
    date: z.string().describe("Date in YYYY-MM-DD format"),
    time: z.string().describe("Time in HH:MM format (24h)"),
    partySize: z.number().describe("Number of guests"),
    specialRequests: z
      .string()
      .optional()
      .describe("Dietary restrictions, seating preferences, celebrations"),
  }),
  execute: async ({ name, date, time, partySize, specialRequests }) => {
    const id = `RES-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    const table = tableFor(partySize);

    reservations.set(id, { id, name, date, time, partySize, table, specialRequests });
    console.log(`  booked ${id} — ${name}, ${date} ${time}, ${partySize} guests`);

    return { confirmed: true, reservationId: id, name, date, time, partySize, table };
  },
});

const cancelReservation = tool({
  name: "cancelReservation",
  description:
    "Cancel an existing reservation by its id. " +
    "ONLY call after the caller explicitly confirms they want to cancel.",
  schema: z.object({
    reservationId: z.string().describe("Reservation id, e.g. RES-ABC123"),
  }),
  execute: async ({ reservationId }) => {
    const existing = reservations.get(reservationId);
    if (!existing) return { cancelled: false, reason: "Reservation not found" };

    reservations.delete(reservationId);
    console.log(`  cancelled ${reservationId}`);

    return {
      cancelled: true,
      reservationId,
      was: `${existing.name}, ${existing.date} at ${existing.time}`,
      refundPolicy: "Full refund — cancelled more than 24h in advance",
    };
  },
});

// ── The agent ────────────────────────────────────────────────────────────

const pc = new Pinecall();

const agent = pc.agent(AGENT, {
  voice: "cartesia/sonic",
  llm: "openai/gpt-4.1-mini",
  language: "en",
  stt: "deepgram/flux",
  prompt: `You are the reservation assistant for Pines, an upscale farm-to-table restaurant.

Your responsibilities:
- Help callers check table availability
- Make new reservations
- Cancel or modify existing bookings
- Answer questions about the restaurant

Restaurant details:
- Hours: 11:00 AM - 10:00 PM, seven days a week
- Cuisine: seasonal farm-to-table, Mediterranean-inspired
- Dress code: smart casual
- Location: 742 Evergreen Terrace, Springfield

Be warm, professional and concise. Never offer a time you have not checked with
checkAvailability. Always confirm the details back before booking. If the caller
doesn't specify a date, assume today.`,
  greeting: "Thank you for calling Pines — how may I help you with your reservation today?",
  phoneNumber: PHONE,
  tools: [checkAvailability, makeReservation, cancelReservation],
});

agent.on("ready", () =>
  console.log(`Agent '${AGENT}' ready${PHONE ? ` on ${PHONE}` : " (browser only — no PHONE set)"}`),
);
agent.on("error", (err) => console.error(`Agent refused (${err.code}): ${err.message}`));

agent.on("call.started", (call) => console.log(`Call ${call.id} from ${call.from}`));
agent.on("call.ended", (call, reason) =>
  console.log(`Call ${call.id} ended (${reason}) — ${reservations.size} booking(s) in memory`),
);

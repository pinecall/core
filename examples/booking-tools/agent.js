/**
 * Pinecall Agent — boots on Vite dev server start.
 *
 * Uses tool() for declarative tool definitions with auto-execution.
 * Tool results flow to the browser via WebRTC DataChannel automatically.
 */

import { Pinecall, tool } from "@pinecall/sdk";
import { z } from "zod";

// ── Fake slots ──────────────────────────────────────────────────────

function getFakeSlots(date) {
  const day = new Date(date).getDay();
  const allSlots = [
    "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM",
    "11:00 AM", "11:30 AM", "12:00 PM",
    "2:00 PM", "2:30 PM", "3:00 PM", "3:30 PM",
    "4:00 PM", "4:30 PM", "5:00 PM",
  ];
  if (day === 0) return [];
  const hash = date.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  return allSlots.filter((_, i) => (hash + i * 7) % 3 !== 0);
}

// ── Tool definitions ────────────────────────────────────────────────

const getAvailableSlots = tool({
  name: "getAvailableSlots",
  description: "Get available appointment slots for a date. Call when user wants to book.",
  schema: z.object({
    date: z.string().describe("YYYY-MM-DD"),
    service: z.string().optional().describe("e.g. haircut, facial"),
  }),
  execute: async ({ date, service }) => {
    const d = date || new Date().toISOString().split("T")[0];
    const slots = getFakeSlots(d);
    console.log(`  📅 ${d} → ${slots.length} slots`);
    return { date: d, service: service || "appointment", slots };
  },
});

const showContactForm = tool({
  name: "showContactForm",
  description: "Show a contact form on the user's screen to collect their details (name, email, phone). Call this AFTER the user picks a time slot. You can prefill fields if you already know them.",
  schema: z.object({
    prefill: z.object({
      name: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
    }).optional().describe("Optional pre-filled values"),
  }),
  execute: async ({ prefill }) => {
    console.log(`  📋 Contact form shown`);
    return { fields: ["name", "email", "phone"], prefill: prefill || {} };
  },
});

const fillField = tool({
  name: "fillField",
  description: "Auto-fill a specific field in the contact form on screen. Use this when the user tells you a value verbally (e.g. 'my name is John').",
  schema: z.object({
    field: z.enum(["name", "email", "phone"]).describe("Which form field to fill"),
    value: z.string().describe("The value to put in the field"),
  }),
  execute: async ({ field, value }) => {
    console.log(`  ✏️  Auto-fill: ${field} = "${value}"`);
    return { field, value };
  },
});

const submitForm = tool({
  name: "submitForm",
  description: "Submit the contact form on the user's screen. Call when the user says submit, confirm, done, or similar.",
  schema: z.object({}),
  execute: async () => {
    console.log(`  📨 Form submitted by voice command`);
    return { submitted: true };
  },
});

const confirmBooking = tool({
  name: "confirmBooking",
  description: "Confirm a booking. Only call after the contact form has been submitted.",
  schema: z.object({
    date: z.string(),
    time: z.string(),
    service: z.string(),
    clientName: z.string(),
  }),
  execute: async ({ date, time, service, clientName }) => {
    const confirmationId = `BK-${Date.now().toString(36).toUpperCase()}`;
    console.log(`  ✅ Booked: ${clientName} @ ${time}`);
    return { confirmed: true, date, time, service, clientName, confirmationId };
  },
});

const tools = [getAvailableSlots, showContactForm, fillField, submitForm, confirmBooking];

// ── Start ───────────────────────────────────────────────────────────

export async function startAgent() {
  const apiKey = process.env.PINECALL_API_KEY;
  if (!apiKey) {
    console.error("❌ Set PINECALL_API_KEY env var");
    return;
  }

  const pc = new Pinecall({ apiKey });
  await pc.connect();

  const agent = pc.deploy("booking-demo", {
    prompt: `You are a friendly booking assistant for "Glow Studio" beauty salon.

RULES:
- When the user wants to book, call getAvailableSlots first.
- After calling it, say you're showing the slots on screen and let them pick.
- When they choose a slot, call showContactForm to collect their details.
- If the user tells you their name, email, or phone verbally, call fillField to auto-fill the field on screen.
- The form state is visible in the "## UI Context" section of your prompt — you can see what they've typed.
- When the user says "submit", "confirm", "that's all", or similar, call submitForm to submit the form on screen.
- After the form is submitted, call confirmBooking with the collected details.
- Today is {{date}}, time is {{time}}.

SERVICES: Haircut ($35), Hair coloring ($80), Facial ($55), Manicure ($25), Spa package ($150).

VOICE: No markdown, no emojis, no bullets. Short responses (1-2 sentences).`,
    model: "gpt-4.1-mini",
    voice: "elevenlabs:EXAVITQu4vr4xnSDxMaL",
    channels: ["webrtc"],
    tools,
    session_limits: {
      idle_timeout_seconds: 20,
      idle_warning_seconds: 10,
    },
  });

  agent.on("call.started", (call) => {
    console.log(`📞 Call started: ${call.id}`);
    call.say("Hi! Welcome to Glow Studio. Would you like to book an appointment?");
  });

  agent.on("session.idle_warning", (event, call) => {
    console.log(`⏱️ Idle warning: ${event.remaining_seconds}s remaining`);
    call.say("Are you still there?");
  });

  agent.on("call.ended", (call, reason) => {
    console.log(`📴 Call ended: ${call.id} — ${reason}`);
  });

  console.log("  🎙  Agent 'booking-demo' ready (WebRTC)");
  return { agent };
}

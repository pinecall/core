/**
 * Pinecall Agent — boots on Vite dev server start.
 *
 * pc.deploy() + tool handlers. Tool results flow to the
 * browser via WebRTC DataChannel automatically.
 */

import { Pinecall } from "@pinecall/sdk";

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

const tools = [
  {
    type: "function",
    function: {
      name: "getAvailableSlots",
      description:
        "Get available appointment slots for a date. Call when user wants to book.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD" },
          service: { type: "string", description: "e.g. haircut, facial" },
        },
        required: ["date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "showContactForm",
      description:
        "Show a contact form on the user's screen to collect their details (name, email, phone). Call this AFTER the user picks a time slot. You can prefill fields if you already know them.",
      parameters: {
        type: "object",
        properties: {
          prefill: {
            type: "object",
            description: "Optional pre-filled values",
            properties: {
              name: { type: "string" },
              email: { type: "string" },
              phone: { type: "string" },
            },
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fillField",
      description:
        "Auto-fill a specific field in the contact form on screen. Use this when the user tells you a value verbally (e.g. 'my name is John').",
      parameters: {
        type: "object",
        properties: {
          field: { type: "string", enum: ["name", "email", "phone"], description: "Which form field to fill" },
          value: { type: "string", description: "The value to put in the field" },
        },
        required: ["field", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submitForm",
      description:
        "Submit the contact form on the user's screen. Call when the user says submit, confirm, done, or similar. The form will be submitted with whatever values are currently filled.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "confirmBooking",
      description: "Confirm a booking. Only call after the contact form has been submitted.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string" },
          time: { type: "string" },
          service: { type: "string" },
          clientName: { type: "string" },
        },
        required: ["date", "time", "service", "clientName"],
      },
    },
  },
];

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

  agent.on("llm.tool_call", async (call, data) => {
    const toolCalls = data?.tool_calls;
    if (!toolCalls) return;
    const results = [];

    for (const tc of toolCalls) {
      let result;
      try {
        const args = JSON.parse(tc.arguments || "{}");
        switch (tc.name) {
          case "getAvailableSlots": {
            const date = args.date || new Date().toISOString().split("T")[0];
            result = { date, service: args.service || "appointment", slots: getFakeSlots(date) };
            console.log(`  📅 ${date} → ${result.slots.length} slots`);
            break;
          }
          case "showContactForm":
            result = { fields: ["name", "email", "phone"], prefill: args.prefill || {} };
            console.log(`  📋 Contact form shown`);
            break;
          case "fillField":
            result = { field: args.field, value: args.value };
            console.log(`  ✏️  Auto-fill: ${args.field} = "${args.value}"`);
            break;
          case "submitForm":
            result = { submitted: true };
            console.log(`  📨 Form submitted by voice command`);
            break;
          case "confirmBooking":
            result = { confirmed: true, ...args, confirmationId: `BK-${Date.now().toString(36).toUpperCase()}` };
            console.log(`  ✅ Booked: ${args.clientName} @ ${args.time}`);
            break;
          default:
            result = { error: `Unknown tool: ${tc.name}` };
        }
      } catch (err) {
        result = { error: err.message };
      }
      results.push({ tool_call_id: tc.id, result });
    }

    agent.send({ event: "llm.tool_result", call_id: call.id, msg_id: data.msg_id, results });
  });

  console.log("  🎙  Agent 'booking-demo' ready (WebRTC)");
}

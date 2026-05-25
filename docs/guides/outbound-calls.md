---
title: "Outbound Calls"
description: "Make programmatic outbound phone calls with a greeting and metadata."
---

# Outbound Calls

Pinecall agents can place outbound calls. Use it for appointment reminders, follow-ups, surveys, or any flow where the agent is the one initiating contact.

## The minimum example

```typescript
const call = await agent.dial({
  to: "+14155551234",
  from: "+13186330963",
  greeting: "Hi! This is a follow-up call from Acme.",
});

call.on("call.ended", (_, reason) => {
  console.log(`Done: ${reason}`);
});
```

`agent.dial()` returns a `Promise<Call>` — same `Call` object you get from `call.started`.

## How the greeting works

Unlike inbound calls (where you use `call.say()` in `call.started`), outbound calls take a `greeting` string. The server speaks it via TTS the instant the callee picks up — no roundtrip through your code, no race condition between picking up and greeting.

```typescript
await agent.dial({
  to: "+14155551234",
  from: "+13186330963",
  greeting: "Hi, this is Mara from Acme calling to confirm your appointment tomorrow at 3 PM.",
});
```

After the greeting, the conversation continues normally — `turn.end`, `llm.tool_call`, etc. all fire as on inbound calls.

## Required fields

| Field | Type | Required | Description |
|---|---|---|---|
| `to` | `string` | ✅ | Destination number in E.164 format |
| `from` | `string` | ✅ | Caller ID — must be a number registered to your Pinecall account |
| `greeting` | `string` | — | Text the server speaks when the callee picks up |
| `metadata` | `object` | — | Custom data attached to the call (visible on the `Call` object) |
| `config` | `object` | — | Per-call config override (voice, STT, language) |

## Attaching metadata

Use `metadata` to carry context from your scheduling system into the call. It's available as `call.metadata` throughout the call.

```typescript
const call = await agent.dial({
  to: "+14155551234",
  from: "+13186330963",
  greeting: "Hi! This is Mara with a quick reminder about your appointment.",
  metadata: {
    appointmentId: "appt_001",
    patientName: "Maria",
    doctorName: "Dr. García",
    appointmentTime: "2026-06-01T15:00:00Z",
  },
});

agent.on("call.started", async (call) => {
  if (call.direction === "outbound" && call.metadata?.patientName) {
    await call.setPromptVars({
      patient: call.metadata.patientName,
      doctor: call.metadata.doctorName,
      time: call.metadata.appointmentTime,
    });
  }
});
```

## Per-call config overrides

Override voice, STT, or language for a specific outbound call. The agent's defaults stay untouched.

```typescript
const call = await agent.dial({
  to: "+34611234567",
  from: "+13186330963",
  greeting: "¡Hola! Te llamo para confirmar tu cita.",
  config: {
    voice: "elevenlabs:spanishVoiceId",
    language: "es",
  },
});
```

## Running a campaign

To call a list of people, just loop:

```typescript
const recipients = await db.appointments.dueForReminder();

for (const r of recipients) {
  try {
    const call = await agent.dial({
      to: r.phone,
      from: "+13186330963",
      greeting: `Hi ${r.name}, this is a quick reminder about your appointment tomorrow at ${r.time}.`,
      metadata: { appointmentId: r.id },
    });

    call.on("call.ended", async (_, reason) => {
      await db.appointments.markReminderSent(r.id, reason);
    });

    // throttle to avoid hammering the network
    await new Promise((res) => setTimeout(res, 1000));
  } catch (err) {
    console.error(`Failed to dial ${r.phone}:`, err);
    await db.appointments.markReminderFailed(r.id, err.message);
  }
}
```

For production campaigns, add: concurrency limits, retry logic, time-of-day enforcement, do-not-call list filtering, and call result logging.

## Handling no-answer / voicemail

When the callee doesn't pick up, the call ends with a reason like `no_answer`, `busy`, or `failed`. Check `reason` in `call.ended`:

```typescript
call.on("call.ended", async (_, reason) => {
  switch (reason) {
    case "hangup":
      await markCompleted(call);
      break;
    case "no_answer":
    case "busy":
      await scheduleRetry(call, "1 hour");
      break;
    case "failed":
      await markFailed(call);
      break;
  }
});
```

## What's next

- [Inbound voice](/guides/inbound-voice) — for receiving calls
- [Tools and Functions](/guides/tools-and-functions) — let the outbound agent act on responses (book a slot, cancel, transfer)
- [Session limits](/reference/session-limits) — cap outbound call duration

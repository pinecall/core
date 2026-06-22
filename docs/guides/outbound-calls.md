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

After the greeting, the conversation continues normally — `turn.end`, `llm.toolCall`, etc. all fire as on inbound calls.

## Required fields

| Field | Type | Required | Description |
|---|---|---|---|
| `to` | `string` | ✅ | Destination number in E.164 format |
| `from` | `string` | — | Caller ID — auto-resolved if agent has one phone channel. Required when multiple. |
| `greeting` | `string` | — | Text the server speaks when the callee picks up |
| `metadata` | `object` | — | Custom data attached to the call (visible on the `Call` object) |
| `config` | `object` | — | Per-call config override (voice, STT, language) |
| `detectTurnEnd` | `boolean` | — | Wait for the other side to finish *its* greeting before speaking yours (and relay `turn.end` to your code). Default `false`. See below. |

> **Tip:** If your agent has exactly one phone channel, you can omit `from` — the SDK auto-resolves it. Only pass `from` explicitly when the agent has multiple phone numbers.

## `detectTurnEnd` — wait for the other side's greeting before speaking

`detectTurnEnd` controls **when your greeting is delivered**.

- **`false` (default)** — the greeting is spoken **immediately** when the callee
  picks up. This is what you want when calling a **human**: they say "Hello?", and
  your agent answers right away.
- **`true`** — the agent does **not** speak first. The server waits, runs turn
  detection on the **other party**, and only delivers your greeting **after the other
  side finishes its own greeting**. This is what you want when the callee is a
  **bot, IVR, or answering machine** that speaks first — so your agent doesn't talk
  over the machine's "You've reached…/Press 1 for…" prompt.

| Value | When the greeting is sent | Use it when |
|---|---|---|
| `false` *(default)* | Immediately on pickup. | Calling a **human** — they answer, the agent greets right back. |
| `true` | After the **other side** finishes speaking (its end-of-turn). | Calling a **bot / IVR / answering machine** that greets first — wait for its prompt to end, then speak. |

```typescript
// Calling an answering machine / IVR: let it finish its greeting first.
const call = await agent.dial({
  to: "+14155551234",
  greeting: "Hi, this is Mara from Acme returning your call.",
  detectTurnEnd: true,
});
```

When `detectTurnEnd` is `true`, the server also **relays the other party's
end-of-turn to your code** as a `turn.end` event (plus `eager.turn` / `turn.pause`).
That lets code that drives the call by hand — e.g. an automated/test/judge agent
that speaks with `call.say()` instead of a server-side LLM — know exactly when the
other side finished and take its turn:

```typescript
const call = await agent.dial({ to: "+14155551234", detectTurnEnd: true });

call.on("user.message", (e) => {/* what the callee said */});
call.on("turn.end", () => {
  call.say("Got it — let me confirm that for you.");
});
```

Under the hood this just adds `detect_turn_end: true` to the dial request. For
agent-to-agent (`agent.bridge`) the default is the opposite — `true` — because the
other side is always another agent that greets first and the initiator is
code-driven (see below).

## Agent-to-agent voice (`agent.bridge`)

To have one Pinecall agent hold a **voice** conversation with **another** Pinecall
agent — no phone, no WebRTC — use `agent.bridge(target)`. The server cross-wires
the two agents' audio (each side's TTS becomes the other's incoming audio), so
both run their real STT/turn-detection/TTS pipelines. The calling agent is driven
manually: speak with `call.say()`, read the target via `user.message` / `turn.end`.

```typescript
// The judge has voice + STT but no server-side LLM — your code is its brain.
const judge = pc.agent("judge", { voice: "elevenlabs/sarah", stt: "deepgram/flux" });
await pc.ready;

const call = await judge.bridge("pines", { detectTurnEnd: true });

call.on("user.message", (e) => {/* what the judge HEARD the target say */});
call.on("turn.end", () => {/* target finished → take your turn */ call.say("…"); });
```

`detectTurnEnd` (default `true` for `bridge`, `false` for `dial`) makes the caller
wait for the target agent's greeting to finish and emits the target's end-of-turn
(`turn.end`, `source: "bot"`) to the initiator, so the code-driven caller knows when
to speak. This is what powers voice-mode `pinecall test`.

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
    voice: "elevenlabs/valentina",
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

## Handling no-answer / busy / rejected

When the callee doesn't pick up or rejects, `dial()` rejects immediately with the Twilio reason — no 30-second timeout:

```typescript
try {
  const call = await agent.dial({ to: "+14155551234" });
  // Call connected — run your logic
} catch (err) {
  // err.message is one of: "no-answer", "busy", "failed", "canceled", "Dial timeout"
  console.log(`Call failed: ${err.message}`);
}
```

If the call connects and then ends, `call.ended` fires with the reason:

```typescript
agent.on("call.ended", (call, reason) => {
  // reason: "hangup", "disconnected", "idle_timeout", "max_duration", etc.
  console.log(`Call ended: ${reason} (${call.duration}s)`);
});
```

## Running a campaign with `@pinecall/dispatch`

For production outbound campaigns, use the `@pinecall/dispatch` library. It handles rate limiting, concurrency control, deduplication by phone, and call result tracking.

```bash
npm install @pinecall/dispatch
```

```typescript
import { DispatchHub, CsvStrategy } from "@pinecall/dispatch";

const csv = new CsvStrategy({
  file: "./leads.csv",
  mapRow: (row) => {
    if (!row.phone || row.status) return null; // Skip processed rows
    return {
      id: `${row.phone}-${row.service}-${row.date}`,
      phone: row.phone,
      greeting: `Hi ${row.name}, this is a reminder about your appointment on ${row.date}.`,
      metadata: { name: row.name, service: row.service },
    };
  },
});

const hub = new DispatchHub({
  agent,
  strategies: [csv],
  from: "+13186330963",
  maxCallsPerMinute: 5,
  maxConcurrent: 2,
  retryAttempts: 1,
  pollIntervalMs: 5000,
});

hub.start();
```

### What `DispatchHub` does

| Feature | Description |
|---|---|
| **Hot-reload** | Re-reads the CSV on every poll — add rows while it's running |
| **Dedup by phone** | Won't call the same phone twice simultaneously |
| **Dedup by ID** | Won't re-dispatch a record that's already been handled |
| **Rate limiting** | Configurable calls per minute (sliding window) |
| **Concurrency** | Max simultaneous active calls |
| **Lifecycle callbacks** | `onDispatched`, `onCompleted`, `onFailed`, `onSkipped` |

### Strategy callbacks

Override callbacks on the strategy to react to call lifecycle events:

```typescript
csv.onCompleted = (record, callId, reason) => {
  writeResultToCsv(record.phone, reason); // "hangup", "no-answer", etc.
};

csv.onFailed = (record, error) => {
  writeResultToCsv(record.phone, "no_answer");
};

csv.onSkipped = (record, reason) => {
  console.log(`Skipped ${record.phone}: ${reason}`); // "duplicate"
};
```

> **See the full working example:** [`examples/outbound-dispatch/`](https://github.com/pinecall/sdk/tree/main/examples/outbound-dispatch) — CSV-driven appointment reminders with a `confirm_appointment` tool that writes results back to the CSV.

## What's next

- [Inbound voice](/guides/inbound-voice) — for receiving calls
- [Tools and Functions](/guides/tools-and-functions) — let the outbound agent act on responses (book a slot, cancel, transfer)
- [Session limits](/reference/session-limits) — cap outbound call duration

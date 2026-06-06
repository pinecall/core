---
title: "Call Ringing & Reject"
description: "Screen incoming calls before answering — accept, reject, or route based on caller info."
---

# Call Ringing & Reject

By default, Pinecall auto-accepts every incoming call. The **ringing** feature gives you a window to inspect the call _before_ it's answered, so you can:

- **Reject** spam or blacklisted callers
- **Route** calls to different agents based on caller ID
- **Log** incoming calls for analytics
- **Conditionally accept** based on time of day, capacity, etc.

## How it works

```
Phone rings → call.ringing fires → you decide → accept() or reject()
                                                    ↓             ↓
                                             call.started     caller hears busy
```

Without ringing enabled, the flow goes directly from ring → `call.started` (auto-accept).

## Enable ringing

Pass `ringing: true` in the channel overrides:

```typescript
agent.addChannel("phone", "+13186330963", { ringing: true });
```

<Warning>
Only phone channels support ringing. WebRTC and chat channels don't have a ringing phase.
</Warning>

## Handle `call.ringing`

When a call comes in, the SDK emits `call.ringing` with a `RingingCall` object. This object has caller info but no audio — the call isn't connected yet.

```typescript
agent.on("call.ringing", (call) => {
  console.log(`Incoming: ${call.from} → ${call.to}`);
  console.log(`Call SID: ${call.callId}`);

  // Accept the call — proceeds to call.started
  call.accept();
});
```

### RingingCall API

| Property | Type | Description |
|----------|------|-------------|
| `call.callId` | `string` | Twilio Call SID |
| `call.from` | `string` | Caller phone number (E.164) |
| `call.to` | `string` | Called phone number (E.164) |
| `call.accept()` | `void` | Accept the call — triggers `call.started` |
| `call.reject(reason?)` | `void` | Reject the call. Reason: `"busy"` or `"rejected"` |

## Reject calls

Reject with an optional reason that maps to a Twilio rejection:

```typescript
agent.on("call.ringing", (call) => {
  if (BLACKLIST.has(call.from)) {
    call.reject("busy");    // caller hears busy signal
    return;
  }
  call.accept();
});
```

| Reason | Caller experience |
|--------|-------------------|
| `"busy"` | Hears busy tone |
| `"rejected"` | Call is dropped immediately |
| _(none)_ | Defaults to `"rejected"` |

## Default behavior

If you don't call `accept()` or `reject()` within the timeout (configurable on the server, default ~15s), the call is **auto-accepted**. This prevents calls from hanging indefinitely if your handler crashes.

<Note>
If you don't register a `call.ringing` handler at all, calls are auto-accepted immediately — same as before this feature existed. Ringing is fully opt-in.
</Note>

## Full example

```typescript
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY });
await pc.connect();

const BLACKLIST = new Set(["+15551234567", "+15559876543"]);

const agent = pc.agent("receptionist", {
  voice: "elevenlabs/sarah",
  language: "en",
  stt: "deepgram/flux",
  llm: "openai/gpt-4.1-mini",
  prompt: "You are a receptionist. Be brief and helpful.",
});

// Enable ringing on the phone channel
agent.addChannel("phone", "+13186330963", { ringing: true });

// Screen calls before answering
agent.on("call.ringing", (call) => {
  console.log(`🔔 Incoming: ${call.from}`);

  if (BLACKLIST.has(call.from)) {
    console.log(`❌ Rejected: ${call.from} (blacklisted)`);
    call.reject("busy");
    return;
  }

  console.log(`✅ Accepted: ${call.from}`);
  call.accept();
});

// Normal call lifecycle
agent.on("call.started", (call) => {
  call.say("Thanks for calling! How can I help?");
});

agent.on("call.ended", (call, reason) => {
  console.log(`📴 ${call.id} ended: ${reason} (${call.duration}s)`);
});
```

Run the example from the SDK repo:

```bash
cd sdk/examples/ringing
PHONE=+13186330963 node server.js
```

## Wire protocol

The ringing handshake uses two new events and commands:

| Direction | Message | Payload |
|-----------|---------|---------|
| Server → SDK | `call.ringing` | `{ call_id, from, to }` |
| SDK → Server | `call.accept` | `{ call_id }` |
| SDK → Server | `call.reject` | `{ call_id, reason }` |

For full wire protocol details, see `sdk-server/PROTOCOL.md`.

## What's next

- [Inbound Voice](/guides/inbound-voice) — the standard (non-ringing) flow
- [Dev Mode](/guides/dev-mode) — route dev calls to your local agent
- [Events Reference](/reference/events) — all SDK events

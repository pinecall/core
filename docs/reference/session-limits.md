---
title: "Session Limits"
description: "Safety limits to prevent runaway sessions."
---

# Session Limits

Calls have built-in safety limits to prevent runaway sessions: max call duration, idle timeout, warnings, and grace periods. Tune them per agent.

## Defaults

| Setting | Default | Description |
|---|---|---|
| `max_duration_seconds` | `600` (10 min) | Hard cap on total call length |
| `idle_timeout_seconds` | `60` | Auto-hangup after this many seconds of no user speech |
| `idle_warning_seconds` | `15` | Emit `session.idleWarning` this many seconds **before** idle timeout |
| `idle_grace_seconds` | `10` | After idle timeout fires, agent gets this many seconds to prompt user before force-hangup |

## Tuning per agent

```typescript
const agent = pc.agent("receptionist", {
  voice: "elevenlabs/sarah",
  stt: "deepgram/flux-en",
  llm: "openai/gpt-4.1-mini",
  prompt: "...",
  sessionLimits: {
    max_duration_seconds: 1800,  // 30 minutes
    idle_timeout_seconds: 120,   // 2 minutes of silence
    idle_warning_seconds: 30,    // warn 30s before timeout
    idle_grace_seconds: 15,
  },
});
```

## Disabling limits

Set to `0` to disable. **Not recommended for production** — runaway sessions are a real cost risk.

```typescript
sessionLimits: {
  max_duration_seconds: 0,  // 0 = unlimited
  idle_timeout_seconds: 0,  // 0 = disabled
}
```

## How it works

1. The server starts two watchdog tasks when a call begins.
2. The **max-duration watchdog** fires after `max_duration_seconds` — emits `session.timeout` then hangs up.
3. The **idle watchdog** tracks user activity:
   - When the user hasn't spoken for `idle_timeout_seconds - idle_warning_seconds`, emits `session.idleWarning`
   - Then waits `idle_warning_seconds` for the user to speak
   - If still silent at `idle_timeout_seconds`, fires `session.idleWarning` again, gives the agent `idle_grace_seconds` to prompt the user
   - If still silent, emits `session.timeout` and hangs up
4. Any user speech resets the idle timer.

## Reacting to warnings

The `session.idleWarning` event lets you prompt the user before the timeout:

```typescript
agent.on("session.idleWarning", (event, call) => {
  // event.remainingSeconds: seconds until timeout
  // event.idleTimeoutSeconds: the configured idle timeout
  call.say("Are you still there?");
});

agent.on("session.timeout", (event, call) => {
  // event.reason: "max_duration" | "idle_timeout"
  call.say("Goodbye! The call is ending due to inactivity.");
});
```

## Timeline

```
[silence starts] ──── idle_warning fires ──── idle_timeout fires ──── hangup
     0s              (timeout - warning)s         timeout s
```

> **Important:** Bot speech (e.g. "Are you still there?") **pauses** the idle counter but does **not** reset it. Only real user speech resets the timer. This prevents infinite warning loops.

## Widget integration

The `@pinecall/voice-widget` automatically responds to `session.idleWarning` by switching the orb to a blinking amber state (`.idle-warning` CSS class, configurable via `colorWarning` theme prop). On `session.timeout`, the widget auto-disconnects.

## Common configs

### Quick IVR-style flows

```typescript
sessionLimits: {
  max_duration_seconds: 180,   // 3 min hard cap
  idle_timeout_seconds: 20,    // hang up fast on silence
  idle_warning_seconds: 5,
}
```

### Long-form support calls

```typescript
sessionLimits: {
  max_duration_seconds: 3600,  // 1 hour
  idle_timeout_seconds: 180,   // 3 min of silence
  idle_warning_seconds: 60,
}
```

### Outbound campaigns

```typescript
sessionLimits: {
  max_duration_seconds: 600,   // 10 min — most outbound calls end quickly
  idle_timeout_seconds: 30,    // hang up if callee stops engaging
}
```

## What's next

- [Events reference → `session.*`](/reference/events)
- [Outbound calls](/guides/outbound-calls)

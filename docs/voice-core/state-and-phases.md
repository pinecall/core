---
title: "State and Phases"
description: "The reactive state model: status, phases, transcript messages, and lifecycles."
---

# State and Phases

The `VoiceSession` exposes a single reactive state object via `getState()`. This page covers what's in it and how it changes over the lifetime of a call.

## State shape

```typescript
interface VoiceSessionState {
  status: "idle" | "connecting" | "connected" | "error";
  error: string | null;
  isMuted: boolean;
  phase: "idle" | "listening" | "speaking" | "pause" | "thinking";
  userSpeaking: boolean;
  agentSpeaking: boolean;
  duration: number;             // seconds since connected
  messages: TranscriptMessage[];
  toolCalls: ToolUI[];          // active tool UI entries (only for tracked tools)
  idleWarning: number | null;   // seconds until idle timeout (null = no warning)
}
```

| Field | Meaning |
|---|---|
| `status` | The connection lifecycle. `idle` → `connecting` → `connected` → (`idle` on disconnect, or `error`). |
| `error` | Populated when `status === "error"`. Always check this when handling errors. |
| `isMuted` | Mic state. Mirrors `setMuted()` / `toggleMute()`. |
| `phase` | What the conversation is doing right now (see below). |
| `userSpeaking` | `true` between `speech.started` and `speech.ended` events. Use for live waveform UIs. |
| `agentSpeaking` | `true` while TTS is playing. |
| `duration` | Seconds since `status` became `connected`. Updates every second. |
| `messages` | Full transcript — user and bot turns. See [Transcript messages](#transcript-messages) below. |
| `idleWarning` | When the server emits `session.idleWarning`, this holds the seconds remaining until timeout. `null` when no warning is active. |

## Call phases

`phase` tells you what the conversation is doing **right now**. It's the field you'll bind to UI state most often (orb color, animation, status label).

| Phase | Meaning | Triggered by |
|---|---|---|
| `idle` | Not in a call | Initial state, after disconnect |
| `listening` | Mic is hot, waiting for speech | Connection established; after bot finishes; after `turn.resumed` |
| `speaking` | Agent is speaking (TTS playing) | First `bot.word` event |
| `thinking` | Processing user input, waiting for LLM | `user.message` (STT final), `turn.end` |
| `pause` | Turn detection pause — user may still be talking | `turn.pause` (brief silence detected) |

Typical flow during one exchange:

```
listening ──► (user speaks) ──► thinking ──► speaking ──► (bot finishes) ──► listening
                                   ▲
                                   │ (turn.pause / turn.resumed cycles)
                                   ▼
                                 pause
```

## Transcript messages

The `messages` array contains the full conversation history. Each message is structured:

```typescript
interface TranscriptMessage {
  id: number;
  role: "user" | "bot" | "system";
  text: string;
  isInterim?: boolean;     // user only: STT is still processing
  speaking?: boolean;      // bot only: TTS is playing this message
  interrupted?: boolean;   // bot only: user barged in
  messageId?: string;      // bot only: server-assigned ID
  toolCallId?: string;     // system only: tool call ID (for updating with result)
}
```

Messages mutate in place as STT refines, words stream in, and the bot finishes speaking — they don't get replaced. That means if you bind to `messages` reactively, the right entry will update.

### User message lifecycle

```
user.speaking → { role: "user", text: "Hola",     isInterim: true }
                                  text updates as STT refines...
user.speaking → { role: "user", text: "Hola que", isInterim: true }
user.message  → { role: "user", text: "Hola, ¿qué tal?", isInterim: false }
```

If you're rendering a transcript, render `isInterim: true` messages with reduced opacity or a "typing" indicator so the user sees that the STT is still processing.

### Bot message lifecycle (word-by-word)

```
bot.speaking  → { role: "bot", text: "",                 speaking: true, messageId: "abc" }
bot.word      → text: "Hello"
bot.word      → text: "Hello there"
bot.word      → text: "Hello there how"
bot.word      → text: "Hello there how are"
bot.word      → text: "Hello there how are you"
bot.finished  → { speaking: false, text: "Hello there, how are you?" }
```

`bot.speaking` arrives with the full intended `text`, but the widget intentionally starts with `text: ""` and builds word-by-word so the on-screen captions stay in sync with the audio.

`bot.finished` may include a polished final text (with proper punctuation that the per-word stream doesn't have).

### Interrupted bot

When the user barges in mid-utterance:

```
bot.word        → text: "Hello there how"
bot.interrupted → { speaking: false, interrupted: true }
```

Render interrupted messages with a visual marker (e.g. `⚡` icon, ellipsis, gray border) so users see the bot was cut off rather than just suddenly stopping.

## Subscribing to changes

The state object is **stable by identity** — `getState()` returns the same reference until something changes. This is what makes it safe for React's `useSyncExternalStore`:

```typescript
session.subscribe(() => {
  const next = session.getState(); // new reference only if state changed
  // ...
});
```

For more targeted updates, subscribe to specific events:

```typescript
session.addEventListener("phase", (e) => {
  // only fires when phase actually changes
  document.body.dataset.phase = e.detail.phase;
});
```

## Driving UI from `phase` and `agentSpeaking`

A common pattern: bind your "orb" or status visual to `phase` for the overall mode, and use `agentSpeaking` for a faster-reacting animation layer.

```typescript
const orb = document.getElementById("orb");

session.subscribe(() => {
  const { phase, agentSpeaking, idleWarning } = session.getState();

  orb.dataset.phase = phase;                    // CSS handles per-phase styling
  orb.classList.toggle("speaking", agentSpeaking);
  orb.classList.toggle("idle-warning", idleWarning !== null);
});
```

The `voice-widget` package follows exactly this pattern — see [its theming guide](/voice-widget/theming) for the full set of CSS classes.

## What's next

- [DataChannel protocol](/voice-core/datachannel-protocol) — the raw events that drive state changes
- [`VoiceSession` class](/voice-core/voice-session) — methods and constructor

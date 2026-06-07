---
title: "Events"
description: "Every event the SDK emits, with payload shapes and timing."
---

# Events

This is the complete catalog of events. Subscribe via `agent.on(event, handler)`. All call-scoped events include the `Call` as the final argument.

## Real-time flow

This is the order events fire during a typical exchange:

```
User speaks    →  speech.started
               →  user.speaking  (interim, fires multiple times)
               →  speech.ended
               →  user.message   (final confirmed text)
               →  eager.turn / turn.end

Bot responds   →  bot.speaking   (message ID assigned)
               →  bot.word       (word-by-word as TTS plays)
               →  bot.finished   (done speaking)

Interruption   →  bot.interrupted
               →  turn.continued (active ReplyStreams auto-aborted)
```

## Lifecycle events

### `call.started`

```typescript
agent.on("call.started", (call: Call) => { });
```

A new call connected. The `Call` object is partially populated — `id`, `from`, `to`, `direction`, `transport`, `metadata` are available. `duration`, `endedAt`, `reason` are not yet.

### `call.ended`

```typescript
agent.on("call.ended", (call: Call, reason: string) => { });
```

The call ended. The `Call` is now fully populated, including `duration`, `endedAt`, `messages`, and `transcript`.

`reason` values: `hangup`, `timeout`, `idle_timeout`, `max_duration`, `no_answer`, `busy`, `failed`.

## User speech events

### `speech.started` / `speech.ended`

```typescript
agent.on("speech.started", (event, call: Call) => { });
agent.on("speech.ended", (event, call: Call) => { });
```

VAD-level events: fire when the audio energy crosses the speech threshold.

### `user.speaking`

```typescript
agent.on("user.speaking", (event: { text: string }, call: Call) => { });
```

Interim STT transcript. Fires multiple times as the STT engine refines its guess.

### `user.message`

```typescript
agent.on("user.message", (event: { text: string; messageId: string }, call: Call) => { });
```

Final confirmed user text. After this fires, `eager.turn` or `turn.end` follows shortly.

## Turn events

### `eager.turn`

```typescript
agent.on("eager.turn", (turn: { text: string; probability: number }, call: Call) => { });
```

Early signal that the user *probably* finished a turn. Use for low-latency responses — start the LLM, but be ready to abort if `turn.continued` fires.

### `turn.end`

```typescript
agent.on("turn.end", (turn: { text: string; probability: number }, call: Call) => { });
```

Final turn signal. Higher confidence than `eager.turn`. This is where most apps trigger the LLM.

### `turn.continued`

```typescript
agent.on("turn.continued", (event, call: Call) => { });
```

The user kept talking after a turn signal. Any active `ReplyStream` auto-aborts. Your handler doesn't need to do anything — just don't be surprised when the stream stops.

## Bot speech events

Bot speech follows this lifecycle:

```
bot.speaking  →  bot.word × N  →  bot.finished      (completed normally)
                                  bot.interrupted    (user barged in)
                                  message.confirmed  (full text saved to history)
```

`call.currentBotText` accumulates `bot.word` events into a live preview string.
It resets on each new `bot.speaking` and clears after `bot.finished` / `bot.interrupted`.

### `bot.speaking`

```typescript
agent.on("bot.speaking", (event: { messageId: string; text: string }, call: Call) => { });
```

The bot started speaking a message. `messageId` lets you track this specific utterance.

`text` contains the full response text for non-streaming replies (`call.say()`, `call.reply()`). For streaming replies (`call.replyStream()`), `text` is empty because tokens arrive incrementally — use `bot.word` events or `call.currentBotText` to track what the bot is saying.

### `bot.word`

```typescript
agent.on("bot.word", (event: { messageId: string; word: string }, call: Call) => { });
```

A word was just played by TTS — synchronized with the actual audio playback. Use for live captions, subtitles, or transcript UIs.

Each `bot.word` is automatically accumulated into `call.currentBotText`:

```typescript
// Live preview — grows word-by-word as the bot speaks
agent.on("bot.word", (event, call) => {
  console.log(`🗣  "${call.currentBotText}"`);
  // "¡Hola!"
  // "¡Hola! Estoy"
  // "¡Hola! Estoy bien,"
  // "¡Hola! Estoy bien, gracias."
});
```

> **Note:** `bot.word` timing is aligned with TTS audio. If the bot says a 5-second sentence, words arrive spread across those 5 seconds — not all at once.

### `bot.finished`

```typescript
agent.on("bot.finished", (event: { messageId: string; durationMs: number }, call: Call) => { });
```

The bot finished speaking. TTS audio fully played. `call.currentBotText` still contains the accumulated words during this handler — it clears immediately after.

```typescript
agent.on("bot.finished", (event, call) => {
  console.log(`Done (${event.durationMs}ms): "${call.currentBotText}"`);
});
```

### `bot.interrupted`

```typescript
agent.on("bot.interrupted", (event: { messageId: string; playedMs: number; reason: string }, call: Call) => { });
```

The user cut off the bot mid-speech. `call.currentBotText` shows what the bot managed to say before being interrupted.

```typescript
agent.on("bot.interrupted", (event, call) => {
  console.log(`Interrupted after ${event.playedMs}ms, said: "${call.currentBotText}"`);
});
```

## Protocol events

### `message.confirmed`

```typescript
agent.on("message.confirmed", (event: { messageId: string }, call: Call) => { });
```

The server acknowledged a bot message you sent (via `say`, `reply`, or `replyStream`).

### `llm.toolCall`

```typescript
agent.on("llm.toolCall", (data: {
  msgId: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
}, call: Call) => { });
```

The server-side LLM is requesting one or more tool calls. If you defined tools with `tool()`, the SDK auto-executes them and sends results via `call.toolResult()`. This event still fires — use it for logging, metrics, or UI updates.

See [Tools and Functions](/guides/tools-and-functions).

### `session.idleWarning`

```typescript
agent.on("session.idleWarning", (event: {
  remainingSeconds: number;
  idleTimeoutSeconds: number;
}, call: Call) => { });
```

Fires before idle timeout. The user hasn't spoken in a while. Use it to prompt them.

```typescript
agent.on("session.idleWarning", (event, call) => {
  call.say("Are you still there?");
});
```

### `session.timeout`

```typescript
agent.on("session.timeout", (event: {
  reason: "max_duration" | "idle_timeout";
}, call: Call) => { });
```

A session limit hit. The call is about to end.

## WhatsApp events

### `whatsapp.sessionStarted`

```typescript
agent.on("whatsapp.sessionStarted", (event: {
  sessionId: string;
  contactPhone: string;
  contactName: string;
}) => { });
```

First message from a new contact.

### `whatsapp.message`

```typescript
agent.on("whatsapp.message", (event: {
  sessionId: string;
  from: string;
  name: string;
  type: "text" | "audio" | "image" | "video" | "document";
  text: string;
  messageId: string;
  paused: boolean;  // true when agent is paused (human-in-the-loop)
}) => { });
```

Incoming WhatsApp message. For voice notes (`type: "audio"`), `text` is the transcript.

When `paused` is `true`, the AI did not respond — a human should handle this message via `agent.sendMessage()`.

### `whatsapp.response`

```typescript
agent.on("whatsapp.response", (event: {
  sessionId: string;
  to: string;
  text: string;
  source?: "human";  // present when sent by human via agent.sendMessage()
}) => { });
```

The agent sent a WhatsApp response. When `source` is `"human"`, the message was sent by a human operator (not the AI).

### `whatsapp.status`

```typescript
agent.on("whatsapp.status", (event: {
  status: "sent" | "delivered" | "read";
  recipient: string;
  messageId: string;
}) => { });
```

Delivery status update from Meta.

## Human-in-the-loop events

### `session.paused`

```typescript
agent.on("session.paused", (event: {
  sessionId?: string;   // set for session-level pause
  contact?: string;     // set for contact-level pause
  // both undefined = global pause
}) => { });
```

Confirmation that the agent was paused. Fires after `agent.pause()`.

### `session.resumed`

```typescript
agent.on("session.resumed", (event: {
  sessionId?: string;
  contact?: string;
}) => { });
```

Confirmation that the agent was resumed. Fires after `agent.resume()`.

## Audio metrics

When you enable `analysis.send_audio_metrics`:

```typescript
agent.on("audio.metrics", (event: {
  source: "user" | "bot";
  energyDb: number;     // -60 to 0
  rms: number;          // 0–1
  peak: number;         // 0–1
  isSpeech: boolean;
  vadProb: number;      // 0–1
}, call: Call) => { });
```

Use for live waveform UIs, energy meters, or VAD visualization.

## SSE events

When streamed over SSE (via `pc.stream()` or `agent.stream()`), each event has an `event:` field and a JSON `data:` body with `agent` ID:

```
event: user.message
data: {"callId":"CA123","text":"Hello","messageId":"msg_abc","agent":"mara"}
```

A `:ping` comment is sent every 30s as keepalive.

## What's next

- [`Call` API reference](/api/call) — methods to call in response to events
- [Multi-tenant](/guides/multi-tenant) — scope SSE event streams

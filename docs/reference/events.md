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

### `bot.speaking`

```typescript
agent.on("bot.speaking", (event: { messageId: string; text: string }, call: Call) => { });
```

The bot started speaking a message. `messageId` lets you track this specific utterance.

### `bot.word`

```typescript
agent.on("bot.word", (event: { messageId: string; word: string }, call: Call) => { });
```

A word was just played by TTS. Use to build live captions.

```typescript
let current = "";
agent.on("bot.speaking", () => { current = ""; });
agent.on("bot.word", (e) => {
  current += e.word + " ";
  updateCaption(current);
});
agent.on("bot.finished", () => clearCaption());
```

### `bot.finished`

```typescript
agent.on("bot.finished", (event: { messageId: string }, call: Call) => { });
```

The bot finished speaking the message. TTS audio fully played out.

### `bot.interrupted`

```typescript
agent.on("bot.interrupted", (event: { messageId: string }, call: Call) => { });
```

The user cut off the bot mid-speech. The bot stops talking immediately.

## Protocol events

### `message.confirmed`

```typescript
agent.on("message.confirmed", (event: { messageId: string }, call: Call) => { });
```

The server acknowledged a bot message you sent (via `say`, `reply`, or `replyStream`).

### `llm.tool_call`

```typescript
agent.on("llm.tool_call", (data: {
  msgId: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
}, call: Call) => { });
```

The server-side LLM is requesting one or more tool calls. Handle them and respond with `call.toolResult(data.msgId, results)`.

See [Tools and Functions](/docs/guides/tools-and-functions).

### `session.idle_warning`

```typescript
agent.on("session.idle_warning", (event: {
  remainingSeconds: number;
  idleTimeoutSeconds: number;
}, call: Call) => { });
```

Fires before idle timeout. The user hasn't spoken in a while. Use it to prompt them.

```typescript
agent.on("session.idle_warning", (event, call) => {
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

### `whatsapp.session_started`

```typescript
agent.on("whatsapp.session_started", (event: {
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
}) => { });
```

Incoming WhatsApp message. For voice notes (`type: "audio"`), `text` is the transcript.

### `whatsapp.response`

```typescript
agent.on("whatsapp.response", (event: {
  sessionId: string;
  to: string;
  text: string;
}) => { });
```

The agent sent a WhatsApp response.

### `whatsapp.status`

```typescript
agent.on("whatsapp.status", (event: {
  status: "sent" | "delivered" | "read";
  recipient: string;
  messageId: string;
}) => { });
```

Delivery status update from Meta.

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

- [`Call` API reference](/docs/api/call) — methods to call in response to events
- [Multi-tenant](/docs/guides/multi-tenant) — scope SSE event streams

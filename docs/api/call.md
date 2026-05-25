---
title: "Call"
description: "Per-session handle. Speak, control, configure, read state."
---

# Call

A live call session. Created automatically and passed to your `call.started` handler. Use it to speak, control the call, configure it mid-flight, and read its state.

```typescript
agent.on("call.started", (call) => {
  // call is a Call instance
});
```

## Properties

```typescript
call.id          // "CA7ec979f5..." — unique call ID
call.from        // "+13186330963" or "sip:..."
call.to          // destination number / URI
call.direction   // "inbound" | "outbound"
call.transport   // "phone" | "webrtc" | "chat" | "whatsapp" | "unknown"
call.metadata    // custom metadata from the channel or dial()
call.transcript  // [{ role: "user", content: "..." }, ...] — user + assistant only
call.messages    // full LLM history (populated on call.ended)
call.duration    // seconds (populated on call.ended)
call.startedAt   // epoch seconds
call.endedAt     // epoch seconds
call.reason      // "hangup" | "timeout" | ...
```

## Speech

### `say(text)`

Speak text immediately. Standalone — no `in_reply_to` tracking. Use for greetings and proactive announcements.

```typescript
call.say("Hello! How can I help?");
```

### `reply(text)`

Reply to the latest user message. Auto-tracks `in_reply_to`. Use when responding to what the user just said.

```typescript
call.reply("Sure, let me look that up for you.");
```

### `replyStream(turn?)`

Open a token-by-token stream for LLM responses. TTS starts as soon as a sentence boundary is detected.

```typescript
const stream = call.replyStream(turn);

for await (const token of llm.stream(prompt)) {
  if (stream.aborted) break; // user interrupted
  stream.write(token);
}
stream.end();
```

See [`ReplyStream`](/api/reply-stream) for details.

### `toolResult(msgId, results)`

Respond to a server-side LLM tool call. Always called from within an `llm.tool_call` handler.

```typescript
agent.on("llm.tool_call", async (data, call) => {
  const results = [];
  for (const tc of data.toolCalls) {
    const args = JSON.parse(tc.arguments);
    const result = await myToolHandler(tc.name, args);
    results.push({ toolCallId: tc.id, result });
  }
  call.toolResult(data.msgId, results);
});
```

### `cancel(msgId?)`

Cancel a specific bot message (by ID) or the current one (if no ID).

```typescript
call.cancel();             // cancel current
call.cancel("msg_abc123"); // cancel specific
```

### `clear()`

Flush all queued TTS audio. Stops the bot mid-speech.

```typescript
call.clear();
```

## Call control

### `hangup()`

End the call.

```typescript
call.hangup();
```

### `forward(to, opts?)`

Transfer the call to another number.

```typescript
call.forward("+15558675309");
```

### `sendDTMF(digits)`

Send DTMF tones. Use `0-9`, `*`, `#`.

```typescript
call.sendDTMF("1234#");
```

### `hold()` / `unhold()`

Put the call on hold (plays hold music, mutes mic) and resume.

```typescript
call.hold();
// ...later
call.unhold();
```

### `mute()` / `unmute()`

Mute and unmute the mic. Transcripts are buffered while muted; on `unmute()`, `call.unmuted` fires with the buffered transcript.

```typescript
call.mute();
call.unmute();
```

## Mid-call configuration

### `configure(opts)`

Change voice, STT, or language. Takes effect on the next LLM turn or TTS output.

```typescript
call.configure({ voice: "elevenlabs:spanishVoiceId", language: "es" });
```

### `setPrompt(text)`

Replace the system prompt for this call only. The agent's default prompt is unchanged.

```typescript
call.setPrompt("You are now in escalation mode. Be more formal.");
```

### `setPromptVars(vars)`

Set `{{variable}}` values in the prompt template.

```typescript
await call.setPromptVars({
  customer_name: "Maria",
  tier: "premium",
});
```

### `addContext(text)`

Append context after the system prompt. Useful for injecting CRM data, tool results, or live state.

```typescript
await call.addContext(`Recent orders:\n- ORD-001: shipped\n- ORD-002: pending`);
```

You can call `addContext` multiple times during a call — each call appends.

### `setPromptFile(path)`

Load a prompt from a file and set it. Equivalent to `readFile + setPrompt`.

```typescript
await call.setPromptFile("./prompts/escalation.md");
```

## Conversation history

### `getHistory()`

Fetch the current conversation messages in OpenAI format.

```typescript
const messages = await call.getHistory();
// [{ role: "system", content: "..." }, { role: "user", content: "..." }, ...]
```

### `addHistory(msgs)`

Inject messages into the history. Useful for CRM context or seeding past conversation.

```typescript
await call.addHistory([
  { role: "user", content: "I called yesterday about my order" },
  { role: "assistant", content: "Yes, I see it shipped this morning." },
]);
```

### `setHistory(msgs)`

Replace the entire conversation history.

```typescript
await call.setHistory([
  { role: "system", content: "You are now in escalation mode." },
]);
```

### `clearHistory()`

Clear all messages. The system prompt is preserved.

```typescript
call.clearHistory();
```

## Common patterns

### Greet on `call.started`

```typescript
agent.on("call.started", (call) => {
  if (call.direction === "inbound") {
    call.say("Hello! How can I help?");
  }
});
```

### Persist transcripts on `call.ended`

```typescript
agent.on("call.ended", async (call, reason) => {
  await db.calls.create({
    id: call.id,
    from: call.from,
    to: call.to,
    direction: call.direction,
    transport: call.transport,
    duration: call.duration,
    reason,
    transcript: call.transcript,
    messages: call.messages,
  });
});
```

### Transfer when escalation requested

```typescript
agent.on("llm.tool_call", async (data, call) => {
  for (const tc of data.toolCalls) {
    if (tc.name === "transferToHuman") {
      call.say("Connecting you now.");
      call.forward("+15558675309");
    }
  }
});
```

## What's next

- [`ReplyStream`](/api/reply-stream) — for client-side LLMs
- [Events reference](/reference/events) — all events the call emits
- [Hot-reload](/concepts/hot-reload) — `configure`, `setPrompt`, `addContext` patterns

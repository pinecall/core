---
title: "ReplyStream"
description: "Token-by-token streaming for client-side LLM responses."
---

# ReplyStream

A streaming interface for sending LLM tokens to the server. TTS starts as soon as a sentence boundary is detected — you don't wait for the full response.

Use it when running a client-side LLM (bring your own provider). For server-side LLMs, you don't need it — the server streams TTS automatically.

## Creating a stream

```typescript
const stream = call.replyStream(turn);
```

Pass the `turn` object from `turn.end` so the stream is tied to that specific user turn. If the user keeps talking, the stream auto-aborts.

## Writing tokens

```typescript
for await (const chunk of llm.stream(prompt)) {
  if (stream.aborted) break;
  const token = chunk.choices[0]?.delta?.content;
  if (token) stream.write(token);
}
stream.end();
```

| Method | Description |
|---|---|
| `stream.write(token)` | Append a token to the stream |
| `stream.end()` | Mark the stream complete — server flushes remaining TTS |
| `stream.aborted` | `true` if the user interrupted or kept talking |

Always call `stream.end()` when done, even on error — otherwise the server keeps waiting.

## Handling interruptions

The `aborted` flag flips to `true` when:

- The user starts speaking again (`turn.continued`)
- The user explicitly cancels (`bot.interrupted`)
- The call ends (`call.ended`)

Always check `aborted` in your token loop:

```typescript
for await (const chunk of openai.chat.completions.create({ /* ... */ })) {
  if (stream.aborted) break;
  const token = chunk.choices[0]?.delta?.content;
  if (token) stream.write(token);
}
stream.end();
```

If you don't, you'll keep computing tokens (and paying for them) after the user has moved on.

## Full client-side LLM pattern

```typescript
import OpenAI from "openai";
const openai = new OpenAI();

agent.on("turn.end", async (turn, call) => {
  const stream = call.replyStream(turn);

  try {
    const history = await call.getHistory();
    const completion = await openai.chat.completions.create({
      llm: "openai/gpt-5-chat-latest",
      messages: [
        { role: "system", content: "You are helpful. Be concise." },
        ...history,
        { role: "user", content: turn.text },
      ],
      stream: true,
    });

    for await (const chunk of completion) {
      if (stream.aborted) break;
      const token = chunk.choices[0]?.delta?.content;
      if (token) stream.write(token);
    }
  } catch (err) {
    console.error("LLM error:", err);
  } finally {
    stream.end();
  }
});
```

## With Anthropic

```typescript
import Anthropic from "@anthropic-ai/sdk";
const anthropic = new Anthropic();

agent.on("turn.end", async (turn, call) => {
  const stream = call.replyStream(turn);

  try {
    const response = await anthropic.messages.stream({
      model: "claude-opus-4-7",
      max_tokens: 1024,
      system: "You are helpful. Be concise.",
      messages: [{ role: "user", content: turn.text }],
    });

    for await (const event of response) {
      if (stream.aborted) break;
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        stream.write(event.delta.text);
      }
    }
  } finally {
    stream.end();
  }
});
```

## With LangChain

```typescript
import { ChatOpenAI } from "@langchain/openai";
const model = new ChatOpenAI({ model: "gpt-5-chat-latest", streaming: true });

agent.on("turn.end", async (turn, call) => {
  const stream = call.replyStream(turn);

  const llmStream = await model.stream([
    { role: "system", content: "You are helpful." },
    { role: "user", content: turn.text },
  ]);

  for await (const chunk of llmStream) {
    if (stream.aborted) break;
    if (chunk.content) stream.write(chunk.content.toString());
  }
  stream.end();
});
```

## What's next

- [Server-side vs client-side LLM](/concepts/server-vs-client-llm) — when to use each
- [Events reference](/reference/events) — `turn.end`, `turn.continued`, `bot.interrupted`

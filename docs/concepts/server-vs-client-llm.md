---
title: "Server-side vs Client-side LLM"
description: "The single most important architectural decision when building a Pinecall agent."
---

# Server-side vs Client-side LLM

When you build a Pinecall agent, you choose where the LLM runs. This is the single most important architectural decision in the SDK.

## The two modes

### Server-side LLM (recommended)

The Pinecall server runs the LLM. You give it a prompt, a model, and (optionally) tool definitions. The server handles STT, runs the LLM, generates TTS — you only handle tool calls.

```typescript
import { tool } from "@pinecall/sdk";
import { z } from "zod";

const lookupCustomer = tool({
  name: "lookupCustomer",
  description: "Look up a customer by phone",
  schema: z.object({ phone: z.string() }),
  execute: async ({ phone }) => await db.customers.findOne({ phone }),
});

const agent = pc.deploy("receptionist", {
  prompt: "You are a helpful receptionist. Be concise.",
  model: "gpt-4.1-mini",
  voice: "elevenlabs:abc",
  language: "en",
  tools: [lookupCustomer],
});

agent.on("call.started", (call) => call.say("Hello, how can I help?"));
```

### Client-side LLM (bring your own)

You run the LLM yourself. The server handles STT → text and text → TTS. You receive the user's text on `turn.end`, generate a response with whatever LLM you want, and stream it back.

```typescript
import OpenAI from "openai";
const openai = new OpenAI();

const agent = pc.agent("my-bot", { voice: "cartesia:abc", language: "en" });

agent.on("turn.end", async (turn, call) => {
  const stream = call.replyStream(turn);
  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: "You are helpful. Be concise." },
      { role: "user", content: turn.text },
    ],
    stream: true,
  });
  for await (const chunk of completion) {
    if (stream.aborted) break;
    const token = chunk.choices[0]?.delta?.content;
    if (token) stream.write(token);
  }
  stream.end();
});
```

## Which one to choose

| | Server-side | Client-side |
|---|---|---|
| LLM choice | OpenAI, Mistral (more coming) | Any provider, any model, local |
| You handle conversation history | ❌ Server does it | ✅ You do it |
| You see tool calls | ✅ Via `llm.tool_call` | ✅ You define them |
| Easier to ship | ✅ Yes | Slightly more code |
| Required for WhatsApp | ✅ Yes | ❌ No (server-side only) |
| Latency | Slightly lower (LLM runs near the audio pipeline) | Depends on your provider |
| Cost | Pinecall passes through provider cost | You pay your provider directly |

**Pick server-side if**: you're using OpenAI or Mistral, you want the simplest possible code, or you need WhatsApp.

**Pick client-side if**: you need a specific LLM Pinecall doesn't host (Anthropic, local Ollama, fine-tuned model), you have an existing LangChain/LlamaIndex pipeline, or you need full control over the prompt-building logic.

## You can mix them

A single `Pinecall` instance can host multiple agents, each with a different LLM strategy:

```typescript
// Server-side agent for WhatsApp + phone
const support = pc.agent("support", {
  llm: { provider: "openai", model: "gpt-4.1-mini", enabled: true, prompt: "..." },
});
support.addChannel("whatsapp", { /* config */ });
support.addChannel("phone", "+13186330963");

// Client-side agent using Anthropic for a specialized use case
const research = pc.agent("research", { voice: "elevenlabs:xyz", language: "en" });
research.addChannel("webrtc");
research.on("turn.end", async (turn, call) => {
  /* call Anthropic, stream back */
});
```

## What about hybrid?

What if you want to use the server-side LLM but inject context or modify history mid-call? You can:

- **Inject context dynamically** — `call.addContext("Recent order: #12345 shipped today")`
- **Replace the prompt mid-call** — `call.setPrompt("Now you're in escalation mode.")`
- **Set template variables** — define `{{customer_name}}` in the prompt, fill it per-call
- **Modify history** — `call.addHistory([...])`, `call.setHistory([...])`, `call.clearHistory()`

See [Hot-Reload](/concepts/hot-reload) for the full set of mid-call controls.

## What's next

- [Hot-reload everything](/concepts/hot-reload)
- [Tool calling guide](/guides/tools-and-functions)
- [Events reference](/reference/events) — see all the events you can hook into

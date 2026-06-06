---
title: "LLM Providers"
description: "Server-side LLM providers and configuration."
---

# LLM Providers

When using server-side LLM (the recommended path for most agents), the server runs the LLM and streams responses directly through TTS. Configure it via the `llm` and `prompt` fields on the agent.

For client-side LLMs, see [ReplyStream](/api/reply-stream).

## Quick start

```typescript
const agent = pc.agent("my-bot", {
  voice: "elevenlabs/sarah",
  stt: "deepgram/flux",
  llm: "openai/gpt-4.1-mini",
  prompt: "You are a friendly assistant. Keep responses short.",
});
```

The `llm` shortcut takes the `provider/model` format. `prompt` is a top-level field — no need to nest it inside an object.

## Shortcut format

```typescript
// Recommended: provider/model
llm: "openai/gpt-4.1-mini"

// Bare model name (assumes OpenAI)
llm: "gpt-4.1-mini"

// Both expand to:
// { provider: "openai", model: "gpt-4.1-mini", enabled: true }
```

> The legacy `provider:model` format (e.g. `"openai:gpt-4.1-mini"`) still works but is not recommended.

## Tuning with a full config object

For `temperature`, `max_tokens`, and other tuning parameters, use the full config object:

```typescript
const agent = pc.agent("my-bot", {
  voice: "elevenlabs/sarah",
  stt: "deepgram/flux",
  llm: {
    provider: "openai",
    llm: "openai/gpt-4.1-mini",
    enabled: true,
    temperature: 0.3,      // 0-2. Lower = more deterministic
    max_tokens: 256,        // caps response length
  },
  prompt: "You are a customer support agent. Be concise.",
});
```

> **Tip:** `prompt` stays top-level even when using the full `llm` object. The server merges them. You can also put `prompt` inside the `llm` object — both work.

## OpenAI

```typescript
llm: "openai/gpt-4.1-mini"
```

Or with tuning:

```typescript
llm: {
  provider: "openai",
  llm: "openai/gpt-4.1-mini",
  enabled: true,
  temperature: 0.7,
  max_tokens: 512,
}
```

**Model picker:**

| Model | Best for |
|---|---|
| `gpt-4.1-nano` | Highest-volume, simple flows; lowest cost |
| `gpt-4.1-mini` | Most agents — strong reasoning, good cost (recommended default) |
| `gpt-4.1` | Complex multi-step reasoning, sensitive flows |

## Mistral

```typescript
llm: "mistral/mistral-medium"
```

Or with tuning:

```typescript
llm: {
  provider: "mistral",
  model: "mistral-medium",
  enabled: true,
  temperature: 0.7,
  max_tokens: 512,
}
```

## The `enabled` field

`enabled: false` disables server-side LLM for this agent. The server still does STT and TTS, but it won't generate responses — you handle every `turn.end` yourself with a client-side LLM.

```typescript
// Server-side off — bring your own LLM
const agent = pc.agent("my-bot", {
  voice: "elevenlabs/sarah",
  language: "en",
  // no llm field — or llm: { provider: "openai", enabled: false }
});

agent.on("turn.end", async (turn, call) => {
  const stream = call.replyStream(turn);
  // ... your LLM here
});
```

## Prompt template variables

Define a prompt with `{{placeholders}}`. The server resolves them before each LLM request. Built-in: `{{date}}`, `{{time}}`.

```typescript
const agent = pc.agent("support-bot", {
  voice: "elevenlabs/sarah",
  stt: "deepgram/flux",
  llm: "openai/gpt-4.1-mini",
  prompt: `You are {{agent_name}}, support agent at {{company}}.
Today is {{date}}. Customer: {{customer_name}}.`,
});
```

Set values per-call:

```typescript
agent.on("call.started", async (call) => {
  await call.setPromptVars({
    agent_name: "Nova",
    company: "Acme",
    customer_name: "Maria",
  });
});
```

See [Hot-Reload](/concepts/hot-reload) for the full pattern.

## Temperature & max_tokens

Standard parameters supported by all providers:

- `temperature` — 0–2. Lower = more deterministic. For voice agents, `0.3–0.7` is typical.
- `max_tokens` — caps response length. For voice, keep it short — `256–512` is common to avoid long monologues.

```typescript
// Short, deterministic answers (IVR, routing)
llm: { provider: "openai", model: "gpt-4.1-nano", temperature: 0.2, max_tokens: 128 }

// Natural conversation
llm: { provider: "openai", model: "gpt-4.1-mini", temperature: 0.7, max_tokens: 512 }

// Creative, open-ended
llm: { provider: "openai", model: "gpt-4.1", temperature: 1.0, max_tokens: 1024 }
```

## Tools

Define tools with `tool()` and Zod schemas. The SDK auto-converts them to the OpenAI function-calling wire format and auto-executes them:

```typescript
import { tool } from "@pinecall/sdk";
import { z } from "zod";

const lookupOrder = tool({
  name: "lookupOrder",
  description: "Look up an order by ID",
  schema: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => await db.orders.findOne(orderId),
});

// Pass to agent config
tools: [lookupOrder],
```

See [Tools and Functions](/guides/tools-and-functions) for the full pattern.

## Hot-reloading the LLM

Swap models or providers at runtime:

```typescript
// Agent-wide (all future calls)
agent.configure({ llm: "openai/gpt-4.1" });

// One call only
call.configure({ llm: "mistral/mistral-medium" });
```

This is useful for A/B testing different models, or upgrading the model for VIP callers without redeploying.

## What's next

- [Server-side vs client-side LLM](/concepts/server-vs-client-llm)
- [Tools and Functions](/guides/tools-and-functions)
- [Hot-reload](/concepts/hot-reload)

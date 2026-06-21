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
  llm: "openai/gpt-5-chat-latest",
  prompt: "You are a friendly assistant. Keep responses short.",
});
```

The `llm` shortcut takes the `provider/model` format. `prompt` is a top-level field — no need to nest it inside an object.

## Shortcut format

```typescript
// Recommended: provider/model
llm: "openai/gpt-5-chat-latest"

// Bare model name (assumes OpenAI)
llm: "gpt-5-chat-latest"

// Both expand to:
// { provider: "openai", model: "gpt-5-chat-latest", enabled: true }
```

> The legacy `provider:model` format (e.g. `"openai:gpt-5-chat-latest"`) still works but is not recommended.

## Managed vs bring-your-own-key (BYOK)

| LLM provider | Managed (no key needed) | Notes |
|---|---|---|
| `openai` | ✅ Yes | Default, recommended |
| `anthropic` (`claude`) | ✅ Yes | |
| `google` (`gemini`) | ✅ Yes | |
| `mistral` | ✅ Yes | |
| `xai` (`grok`) | ❌ BYOK only | Add an xAI key |
| `groq` | ❌ BYOK only | Add a Groq key |
| `cerebras` | ❌ BYOK only | Add a Cerebras key |
| `deepseek` | ❌ BYOK only | Add a DeepSeek key |
| `openrouter` | ❌ BYOK only | One key → many models; model = full slug, e.g. `x-ai/grok-4` |

> **BYOK enforcement:** configuring a BYOK-only LLM provider without a saved key for
> it rejects agent registration with `PROVIDER_KEY_REQUIRED` — Pinecall never falls
> back to its own key. With your own key, those tokens are billed by the provider
> directly and are **not** deducted from your Pinecall credits.

## Tuning with a full config object

For `temperature`, `max_tokens`, and other tuning parameters, use the full config object:

```typescript
const agent = pc.agent("my-bot", {
  voice: "elevenlabs/sarah",
  stt: "deepgram/flux",
  llm: {
    provider: "openai",
    llm: "openai/gpt-5-chat-latest",
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
llm: "openai/gpt-5-chat-latest"
```

Or with tuning:

```typescript
llm: {
  provider: "openai",
  llm: "openai/gpt-5-chat-latest",
  enabled: true,
  temperature: 0.7,
  max_tokens: 512,
}
```

**Model picker:**

| Model | Best for |
|---|---|
| `gpt-5-chat-latest` | Most agents — strong reasoning, good cost (recommended default) |
| `gpt-5-chat-mini` | Highest-volume, simple flows; lowest cost |

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

## Google (Gemini)

```typescript
llm: "google/gemini-2.5-flash"
```

Or with tuning:

```typescript
llm: {
  provider: "google",
  model: "gemini-2.5-flash",
  enabled: true,
  temperature: 0.7,
  max_tokens: 512,
}
```

> `gemini` is accepted as an alias for `google` (e.g. `llm: "gemini/gemini-2.5-flash"`).

**Model picker:**

| Model | Best for |
|---|---|
| `gemini-2.5-flash` | Most voice agents — fast, low cost, strong reasoning (recommended default) |

## Anthropic

```typescript
llm: "anthropic/claude-haiku-4-5"
```

Or with tuning:

```typescript
llm: {
  provider: "anthropic",
  model: "claude-haiku-4-5",
  enabled: true,
  temperature: 0.7,
  max_tokens: 512,
}
```

> `claude` is accepted as an alias for `anthropic` (e.g. `llm: "claude/claude-sonnet-4-6"`).

**Model picker:**

| Model | Best for |
|---|---|
| `claude-haiku-4-5` | Most voice agents — fast and low cost (recommended default) |
| `claude-sonnet-4-6` | Higher reasoning quality when latency/cost matter less |

> Opus is intentionally **not** offered for voice agents — it's the premium tier (too slow/costly for real-time). Sonnet 4.6 and Haiku 4.5 are the supported Anthropic models. Set your `ANTHROPIC_API_KEY` on the server (managed) or add an Anthropic credential to your org (BYOK).

## xAI Grok (BYOK)

```typescript
llm: "xai/grok-4"        // "grok" is accepted as an alias for "xai"
```

OpenAI-compatible. Requires your own xAI key. Models: `grok-4`, `grok-4-fast`, `grok-3`.

## Groq (BYOK)

```typescript
llm: "groq/llama-3.3-70b-versatile"
```

Fastest open-model inference. Requires your own Groq key.

## Cerebras (BYOK)

```typescript
llm: "cerebras/llama-3.3-70b"
```

Highest tokens/sec. Requires your own Cerebras key.

## DeepSeek (BYOK)

```typescript
llm: "deepseek/deepseek-chat"     // or "deepseek/deepseek-reasoner" (no tools)
```

Requires your own DeepSeek key.

## OpenRouter (BYOK)

One key unlocks hundreds of models (OpenAI, Anthropic, Google, xAI/Grok, Llama, …).
The `model` is the **full OpenRouter slug** — it keeps its own slash:

```typescript
llm: { provider: "openrouter", model: "x-ai/grok-4" }
```

Requires your own OpenRouter key.

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
  llm: "openai/gpt-5-chat-latest",
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
llm: { provider: "openai", model: "gpt-5-chat-mini", temperature: 0.2, max_tokens: 128 }

// Natural conversation
llm: { provider: "openai", model: "gpt-5-chat-latest", temperature: 0.7, max_tokens: 512 }

// Creative, open-ended
llm: { provider: "openai", model: "gpt-5-chat-latest", temperature: 1.0, max_tokens: 1024 }
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
agent.update({ llm: "openai/gpt-5-chat-latest" });

// One call only
call.update({ llm: "mistral/mistral-medium" });
```

This is useful for A/B testing different models, or upgrading the model for VIP callers without redeploying.

## What's next

- [Server-side vs client-side LLM](/concepts/server-vs-client-llm)
- [Tools and Functions](/guides/tools-and-functions)
- [Hot-reload](/concepts/hot-reload)

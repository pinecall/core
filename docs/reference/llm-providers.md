---
title: "LLM Providers"
description: "Server-side LLM providers and configuration."
---

# LLM Providers

When using server-side LLM (the recommended path for most agents), the server runs the LLM and handles STT/TTS. Configure it via the `llm` field on the agent.

For client-side LLMs, see [ReplyStream](/api/reply-stream).

## OpenAI

```typescript
llm: {
  provider: "openai",
  model: "gpt-4.1-mini",       // or "gpt-4.1", "gpt-4.1-nano"
  enabled: true,
  prompt: "System prompt here.",
  temperature: 0.7,
  max_tokens: 1024,
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
llm: {
  provider: "mistral",
  model: "mistral-medium",
  enabled: true,
  prompt: "System prompt here.",
  temperature: 0.7,
  max_tokens: 1024,
}
```

## Shortcuts

```typescript
llm: "openai:gpt-4.1-mini"
// expands to:
// { provider: "openai", model: "gpt-4.1-mini", enabled: true }
```

The shortcut is convenient but leaves the prompt empty. You'll typically want the full object form when shipping.

## The `enabled` field

`enabled: false` disables server-side LLM for this agent. The server still does STT and TTS, but it won't generate responses — you have to handle every `turn.end` yourself with a client-side LLM.

```typescript
// Server-side off — bring your own LLM
const agent = pc.agent("my-bot", {
  voice: "elevenlabs:abc",
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
llm: {
  provider: "openai",
  model: "gpt-4.1-mini",
  enabled: true,
  prompt: `You are {{agent_name}}, support agent at {{company}}.
Today is {{date}}. Customer: {{customer_name}}.`,
}
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

Standard OpenAI parameters:

- `temperature` — 0–2. Lower = more deterministic. For voice agents, `0.3–0.7` is typical.
- `max_tokens` — caps response length. For voice, keep responses short — `512` or less is common to avoid long monologues.

## Tools

Tool definitions use the OpenAI function-calling format regardless of provider:

```typescript
tools: [
  {
    type: "function",
    function: {
      name: "lookupOrder",
      description: "Look up an order by ID",
      parameters: {
        type: "object",
        properties: { orderId: { type: "string" } },
        required: ["orderId"],
      },
    },
  },
],
```

See [Tools and Functions](/guides/tools-and-functions) for handling the calls.

## Hot-reloading the LLM

Swap models or providers at runtime:

```typescript
// Agent-wide (all future calls)
agent.configure({
  llm: { provider: "openai", model: "gpt-4.1", enabled: true, prompt: "..." },
});
```

This is useful for A/B testing different models, or upgrading the model for VIP callers without redeploying.

## What's next

- [Server-side vs client-side LLM](/concepts/server-vs-client-llm)
- [Tools and Functions](/guides/tools-and-functions)
- [Hot-reload](/concepts/hot-reload)

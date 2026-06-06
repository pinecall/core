---
title: "Hot-Reload"
description: "Change voice, language, prompt, tools — even during an active call."
---

# Hot-Reload

Everything in Pinecall is hot-reloadable. Voice, language, STT provider, prompt, tools — all can change **during an active call**. The server applies changes on the next LLM turn.

This isn't a power-user feature you'll use rarely. It's the foundation of how Pinecall handles real-world conversation: switching languages when the user does, injecting CRM context when the call connects, swapping voices for different contexts.

## The three scopes

| Scope | Method | Affects |
|---|---|---|
| Agent defaults | `pc.agent("id", config)` | All future calls |
| Agent hot-reload | `agent.update(updates)` | Updates defaults, future calls |
| Session (mid-call) | `call.update(opts)` | This call only |
| Prompt (mid-call) | `call.setPrompt(text)` | This call's system prompt |
| Template vars | `call.setPromptVars(vars)` | This call's `{{var}}` values |
| Context | `call.addContext(text)` | Appended after prompt |

## Updating the agent's defaults

`agent.update()` updates the agent's defaults at runtime. Changes take effect on **all future calls** — existing calls keep their current config.

```typescript
// Switch the default voice to French
agent.update({ voice: "elevenlabs/claire", language: "fr" });

// Upgrade to a bigger model
agent.update({ llm: "openai/gpt-4.1", prompt: "..." });

// Swap STT providers
agent.update({ stt: "gladia" });
```

No REST call needed. `agent.update()` uses the existing WebSocket — changes propagate to the server instantly.

## Changing a live call

`call.update()` changes the active call only. Other calls on the same agent are unaffected.

```typescript
// User asks for Spanish mid-conversation
call.update({ voice: "elevenlabs/valentina", language: "es" });
call.reply("¡Claro! Ahora hablo en español.");
```

The next TTS the bot produces uses the new voice. The next STT transcription uses the new language.

## Prompt template variables

Define a prompt with `{{placeholders}}`. The server resolves them before each LLM request. Built-in variables: `{{date}}`, `{{time}}`.

```typescript
const agent = pc.agent("support", {
  llm: "openai/gpt-4.1-mini",
  prompt: `You are {{agent_name}}, support agent at {{company}}.
Today is {{date}}, {{time}}.
Customer: {{customer_name}} ({{tier}} tier).`,
});

agent.on("call.started", async (call) => {
  const customer = await lookupCaller(call.from);
  await call.setPromptVars({
    agent_name: "Nova",
    company: "Acme Corp",
    customer_name: customer.name,
    tier: customer.tier,
  });
  call.say(`Hi ${customer.name}! How can I help?`);
});
```

This pattern lets you keep a single canonical prompt but personalize it for every caller without rewriting the whole template.

## Adding context mid-call

Append dynamic context without replacing the prompt:

```typescript
agent.on("call.started", async (call) => {
  const orders = await getRecentOrders(call.from);
  await call.addContext(
    `Recent orders:\n${orders.map((o) => `- ${o.id}: ${o.status}`).join("\n")}`,
  );
});
```

You can call `addContext` multiple times during a call — each call appends. Use it to inject anything that changes during the conversation: lookups, calculations, tool results you want the LLM to remember.

## Replacing the prompt mid-call

For more aggressive changes — escalation, new persona, mode switch — replace the whole prompt:

```typescript
call.setPrompt(
  "You are now in escalation mode. Be more formal. Offer to connect to a human.",
);
```

The next LLM turn uses the new prompt. History is preserved.

## Why this matters

Most voice platforms treat the agent as a fixed config: you upload a JSON, the platform serves it, the end. Changes require redeploying or hitting a dashboard.

Pinecall treats the agent as **live state inside your process**. That changes what you can build:

- **Personalize every call** — load CRM data on `call.started`, set prompt vars, the LLM knows about the customer from word one
- **Multi-language by default** — detect language from the first user message, switch voice + STT accordingly
- **Phase transitions** — `setPrompt` when the conversation enters a new mode (qualification → demo → close)
- **Live A/B testing** — `agent.update` to flip the model or voice based on traffic without redeploying

## What's next

- [Tools and Functions](/guides/tools-and-functions) — combine hot-reload with tool calling
- [`Call` API reference](/api/call) — every method you can use mid-call

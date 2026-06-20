---
title: "Self-Hosted LLM Gateway"
description: "Consume Pinecall's hosted open model (Qwen3) for chat and structured analysis over an authenticated, plan-gated streaming endpoint."
---

# Self-Hosted LLM Gateway

Pinecall hosts an open LLM and exposes it through an authenticated streaming
endpoint on the sdk-server. Use it for any task that wants a cheap, in-house LLM
instead of a paid per-token provider: **chat / agent loops** and **structured
analysis** (classification, extraction, summarization, recommendations).

| Model | Size | Best for |
|-------|------|----------|
| `qwen3:14b` | ~9 GB | **default** — hybrid model: clean JSON/analysis with thinking off, step-by-step reasoning with thinking on |
| `deepseek-r1:14b` | ~9 GB | dedicated reasoning — **coming soon** |
| `qwen2.5-coder:14b` | ~9 GB | code generation, refactors, tool/JSON authoring — **coming soon** |
| `mistral-nemo:12b` | ~7 GB | strong multilingual + 128k context — **coming soon** |

> Models flagged **coming soon** aren't live yet — `GET /api/llm/models` always
> returns the currently available set.

## Authentication & access

- **Base URL:** `https://voice.pinecall.io`
- **Auth:** a Pinecall API key via `X-API-Key: <key>` **or** `Authorization: Bearer <key>`.
- **Plan gating:** **paid plans only** (`starter`, `pro`, `enterprise`). Both `free`
  and `free_trial` receive **`402 SUBSCRIPTION_REQUIRED`**.

## `POST /api/llm/chat`

Streams the completion as **Server-Sent Events**.

### Request body

```jsonc
{
  "messages":    [{ "role": "user", "content": "..." }],  // required
  "system":      "optional system prompt",
  "model":       "qwen3:14b",                             // default: qwen3:14b
  "mode":        "chat" | "analysis",                     // default: "chat"
  "think":       false,                                   // reasoning on/off (default false; analysis forces false)
  "temperature": 0.7,
  "max_tokens":  512,
  "format":      { /* JSON schema */ } | "json"           // analysis mode only
}
```

Qwen3 is a **hybrid** model: `think: false` (the default) returns a clean, direct
answer — best for JSON and low latency. `think: true` lets it reason step-by-step
first (better on hard problems); the reasoning never leaks into the streamed
answer. `mode: "analysis"` always forces thinking off so JSON stays clean.

### SSE event stream

```
data: {"type":"token","content":"..."}                 // repeated — incremental text
data: {"type":"done","usage":{"input_tokens":N,"output_tokens":M}}
data: {"type":"error","error":"...","code":"UPSTREAM_ERROR|INTERNAL"}
data: [DONE]                                            // terminator
```

### Errors

| Status | Code | Meaning |
|--------|------|---------|
| 401 | `MISSING_KEY` / `INVALID_KEY` | no or bad API key |
| 402 | `SUBSCRIPTION_REQUIRED` | tier is `free` or `free_trial` |
| 400 | `MISSING_MESSAGES` / `BAD_MODEL` / `BAD_REQUEST` | invalid request |

## `GET /api/llm/models`

Same auth + gate. Returns the available models, the default, and the caller's tier —
handy to probe access before streaming. **This is the source of truth for what's
currently available** (the list grows over time).

```json
{ "models": ["qwen3:14b"], "default": "qwen3:14b", "tier": "pro" }
```

## Chat — streaming agent loop

```ts
const res = await fetch("https://voice.pinecall.io/api/llm/chat", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-API-Key": process.env.PINECALL_API_KEY!,
  },
  body: JSON.stringify({
    model: "qwen3:14b",
    system: "You are a concise assistant.",
    messages: [{ role: "user", content: "Summarize today's bookings." }],
    // think: true,  // ← opt into step-by-step reasoning for harder questions
  }),
});

const reader = res.body!.getReader();
const dec = new TextDecoder();
let buf = "";
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  for (const line of buf.split("\n\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6);
    if (data === "[DONE]") break;
    const evt = JSON.parse(data);
    if (evt.type === "token") process.stdout.write(evt.content);
  }
  buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
}
```

## Analysis — structured JSON (schema-enforced)

Set `mode: "analysis"` and pass a JSON **schema** in `format`. The gateway routes
analysis requests through a native path that constrains the output to your schema
(and forces thinking off) — ideal for recommendations and extraction.

```ts
const body = {
  model: "qwen3:14b",
  mode: "analysis",
  system: "You are a pricing engine. Return JSON only.",
  messages: [{ role: "user", content: "Service: deep-tissue massage, $80, 95% utilization, 60% margin. Recommend an optimal price." }],
  format: {
    type: "object",
    properties: {
      suggestedPrice: { type: "number" },
      confidence:     { type: "string", enum: ["low", "medium", "high"] },
      rationale:      { type: "string" },
    },
    required: ["suggestedPrice", "confidence", "rationale"],
  },
};
// POST as above, accumulate the `token` chunks into `text`, then:
const rec = JSON.parse(text); // { suggestedPrice, confidence, rationale }
```

> **Warning:** Pass a real JSON-schema **object**. The string `"json"` (OpenAI-style
> `response_format`) only nudges the model toward JSON — it does **not** enforce a shape.

> **Note:** This open model is for **in-app responders, analysis, and
> recommendations**. For **live voice / WhatsApp agents**, the Pinecall server-side
> LLM supports OpenAI / Mistral / Google / Anthropic — see
> [LLM Providers](/reference/llm-providers).

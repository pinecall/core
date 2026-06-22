---
title: "Skills"
description: "Bundle a prompt, tools and a knowledge base into a capability the agent loads on demand — progressive disclosure for voice & chat agents."
---

# Skills

A **skill** is a named capability: a bundle of `instructions` (a prompt
fragment), `tools`, and a `knowledgeBase`. The agent starts with only its global
tools visible; it **loads a skill on demand** to gain that skill's tools and
guidance, and **unloads** it when done. This keeps the prompt and tool list
small — better latency, less tool hallucination — while letting one agent cover
many verticals.

This is *progressive disclosure*: the model sees a short menu of skills, not the
full surface area of every tool at once.

## Defining a skill

```typescript
import { skill, tool } from "@pinecall/sdk";
import { z } from "zod";

const getAvailableSlots = tool({
  name: "getAvailableSlots",
  description: "Get available slots for a date.",
  schema: z.object({ date: z.string() }),
  execute: async ({ date }) => ({ slots: ["9:00 AM", "10:00 AM", "2:00 PM"] }),
});

const bookAppointment = tool({
  name: "bookAppointment",
  description: "Book an appointment.",
  schema: z.object({ datetime: z.string(), name: z.string() }),
  execute: async ({ datetime, name }) => ({ booked: true }),
});

const booking = skill({
  name: "booking",
  description: "Reserve, reschedule or cancel calendar appointments.",
  instructions: "Confirm date, time and name before booking. Never invent availability.",
  tools: [getAvailableSlots, bookAppointment],
  knowledgeBase: "kb_booking_policies",  // optional, scoped to this skill
});
```

## Attaching skills to an agent

Skills live alongside global `tools`:

```typescript
const agent = pc.agent("front-desk", {
  llm: "openai/gpt-5-chat-latest",
  voice: "elevenlabs/sarah",
  prompt: "You are the receptionist at Acme. Route the caller to the right skill.",

  tools: [transferToHuman, endCall],     // always visible
  skills: [booking, billing, techSupport], // loaded on demand
  knowledgeBase: "kb_company_general",   // global KB, always queried
  greeting: "Hi! How can I help?",
});
```

What the model sees and what it can run are deliberately different:

- **The LLM sees**: global tools + the `loadSkill` / `unloadSkill` meta-tools +
  the tools of skills that are *currently active*.
- **Your code can always run**: every tool of every declared skill — the SDK
  executes them regardless of visibility, so a freshly loaded tool never fails
  with "unknown tool".

## How loading works (model-driven)

By default (`activation: "model"`) the agent loads skills itself. Pinecall
auto-generates two meta-tools:

- **`loadSkill(name)`** — adds the skill's instructions as a prompt section,
  exposes its tools, and adds its knowledge base to retrieval. Takes effect on
  the next turn.
- **`unloadSkill(name)`** — the inverse, to free up context when the task is done.

A typical flow:

```
Caller: "I'd like to book an appointment."
  → model calls loadSkill("booking")
  → next turn the model can see getAvailableSlots + bookAppointment
  → model calls getAvailableSlots(...) and proceeds
```

The `loadSkill` menu lists each loadable skill's `description`, so write
descriptions that tell the model *when* to reach for the skill.

> By default the server also injects a short note into the prompt telling the
> model to use `loadSkill` / `unloadSkill` (and unload to free context). Set
> `rawPrompt: true` (see "Raw prompt & house style" below) to turn that — and
> all other house-style guidance — off.

## Loading from your code

Set `activation: "manual"` for skills only your code should load, or call these
on any active call regardless of activation:

```typescript
agent.on("call.started", async (call) => {
  const customer = await lookupCaller(call.from);
  if (customer.tier === "vip") await call.loadSkill("concierge");
});

agent.on("user.message", async (data, call) => {
  if (/invoice|billing/i.test(data.text)) call.loadSkill("billing");
});

call.activeSkills;          // → ["booking"]  (server-authoritative)
call.loadSkill("booking");
call.unloadSkill("booking");
```

## Activation modes

| Mode | Who loads it |
|---|---|
| `"model"` (default) | The LLM, via the `loadSkill` meta-tool |
| `"manual"` | Only your code (`call.loadSkill`) |
| `"always"` | Active from the start of every call (like grouped global tools) |

## Knowledge bases follow the conversation

Each active skill's `knowledgeBase` is added to RAG retrieval. Before each turn
the server retrieves from the **union** of the agent's global KB plus every
active skill's KB, and merges the chunks by score into `{{RAG_CONTEXT}}`. Unload
a skill and its KB stops being queried. So a receptionist grounded on
`kb_company_general` automatically also consults `kb_booking_policies` once
`booking` is active — and drops it again on `unloadSkill`.

See [Knowledge bases](/guides/knowledge-bases) for how `{{RAG_CONTEXT}}` works.

## Events

```typescript
agent.on("skill.loaded",   (e, call) => console.log("loaded", e.skill, "by", e.by));
agent.on("skill.unloaded", (e, call) => console.log("unloaded", e.skill));
```

`e.by` is `"model"` (loaded via the meta-tool) or `"manual"` (via `call.loadSkill`).
The same events fire on the call. They're also delivered over the WebRTC
DataChannel, so a browser widget can reflect which skill is active.

## Hot-reload

Skills are hot-reloadable like everything else. `agent.skill(config)` adds or
replaces a skill at runtime, and `agent.update({ skills: [...] })` /
`call.update({ skills: [...] })` apply changes — to future calls and to live
calls respectively. See [Hot-Reload](/concepts/hot-reload).

## Raw prompt & house style

By default (`rawPrompt: false`) the server augments your `prompt` with style
guidance tuned to the channel — so an agent behaves well without you spelling out
formatting rules:

| Channel | Injected style |
|---|---|
| **voice** (phone / WebRTC) | Answer like a spoken phone receptionist: natural short sentences, **no** markdown/emojis (everything is read aloud by TTS), numbers/codes written to be spoken. |
| **chat** | Clean common Markdown (`**bold**`, lists, `inline code`) + tasteful emojis. |
| **whatsapp** | WhatsApp's own formatting — `*bold*`, `_italic_`, `~strike~`, ` ```mono``` ` — **not** standard Markdown (no `#` headings or `[links](url)`). |

When the agent has `skills`, a short note on using `loadSkill` / `unloadSkill` is
injected too. To take full control and disable every injection, set `rawPrompt`:

```typescript
const agent = pc.agent("front-desk", {
  prompt: "…your fully self-contained prompt…",
  rawPrompt: true,   // use the prompt verbatim — no house style, no skill notes
});
```

Your skills' own `instructions` are still injected when a skill is active —
`rawPrompt` only disables the *house-style* and *skill-usage* guidance, not the
content of the skills you loaded.

## What's next

- [Tools and functions](/guides/tools-and-functions) — the tools a skill bundles
- [Knowledge bases](/guides/knowledge-bases) — RAG and `{{RAG_CONTEXT}}`
- [Hot-Reload](/concepts/hot-reload) — change tools, prompt and skills mid-call

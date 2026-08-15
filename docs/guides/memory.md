---
title: "Memory"
description: "Long-term memory per contact: facts learned across conversations, kept on the platform's semantic index, handed to you as they are learned."
---

# Memory

[Conversation history](/guides/conversation-history) remembers **conversations** — the transcript, saved on `call.ended`, restored on the next call. Memory remembers **facts**: what the agent has learned about a contact across every conversation, consolidated, and put back into the prompt.

> A caller says "I'm allergic to almond oil, and please don't phone me — WhatsApp only." Two facts. Next month, on a different channel, the agent already knows both — and your CRM learned them the moment they were said.

## Quick start

```typescript
import { Pinecall } from "@pinecall/sdk";
const pc = new Pinecall();

const agent = pc.agent("front-desk", {
  prompt: `You are Lucía, front desk of the spa.

## About this caller
{{MEMORY}}`,
  memory: {
    remember: [
      "the caller's name and how they like to be addressed",
      "services they book, and the professional they ask for",
      "allergies and anything staff must know before a treatment",
      "how they prefer to be contacted, and when NOT to contact them",
    ],
    forget: ["payment details"],
  },
});

// Every fact, the moment it is learned or revised
agent.on("memory.ops", (m) => {
  for (const op of m.ops) db.facts.apply(m.contact, op);   // add | update | delete
});
```

That is the whole integration. The server extracts, consolidates, stores, injects `{{MEMORY}}`, and tells you.

## How it works

```
turn ends ──▶ nano model reads {facts held, last exchange, remember/forget}
          ──▶ ops: add / update(supersedes) / delete
          ──▶ facts applied · memory.md regenerated · indexed
          ──▶ ONE memory.ops event → agent.on · the call log · the DataChannel
          ──▶ {{MEMORY}} refreshed for the next turn
```

- **After the reply, never on the turn.** Extraction runs once the bot has spoken, in parallel with playback. It adds nothing to latency.
- **Consolidation, not a pile.** The model sees the facts already held and answers with *changes*: a fact that moved is an `update` naming the fact it `supersedes`, not a second contradicting `add`. Nothing is erased: a superseded or deleted fact keeps its `valid_from`/`valid_to`, so "lived in Miraflores → moved to San Isidro" are two facts that were each true at some time.
- **One event, three places.** `memory.ops` reaches `agent.on(...)`, the [call log](/guides/call-log) (cursor-replayable — a consumer that was down catches up), and the browser's DataChannel. Same JSON in all three.
- **A nano model, on purpose.** Default `openrouter/qwen/qwen3-8b` on your org's OpenRouter key. Extraction is a schema-following job, ~3 s a pass, and it runs on every turn of every call.

## Identity — the precondition

A memory belongs to a **contact**. On phone and WhatsApp that is the caller's number. On WebRTC and chat there is no number: identity is whatever your backend **sealed into the token** ([token metadata](/guides/token-metadata)) — `contactId`, else `userId`, else `phone`, or the key you name in `contactKey`.

```typescript
// your token endpoint — the browser never chooses who it is
const token = await agent.createToken("chat", { contactId: req.user.id });
```

No identity → memory stays inert for that session and says so once in the server log. It does not guess: remembering the wrong person is worse than remembering nothing.

## The `memory.ops` payload

```json
{
  "contact": "+51987654321",
  "call_id": "CA89a64ad5",
  "turn": 7,
  "final": false,
  "ops": [
    { "op": "add", "id": "m_9f2a1c07", "kind": "preference", "text": "Prefers Valeria for facials", "confidence": 1, "valid_from": "2026-08-15", "evidence": "…con Valeria, la última vez fue genial" },
    { "op": "update", "id": "m_1c07b2e4", "supersedes": "m_0b44e1a9", "kind": "contact", "text": "Prefers WhatsApp; does not want to be called", "confidence": 1, "valid_from": "2026-08-15" },
    { "op": "delete", "id": "m_77e1d0f3", "reason": "no longer works Saturdays" }
  ],
  "memory": { "revision": 12, "path": "mem_<org>_<agent>/+51987654321.md" },
  "model": "openrouter/qwen/qwen3-8b",
  "latency_ms": 2969
}
```

`ops` is what was **applied** — final ids, validity — not what the model asked for. `final: true` marks the end-of-call pass. An empty pass emits nothing.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `remember` | identity, preferences, contact preferences | What is worth keeping, in the business's own words. This is the extractor's brief — write it like you would brief a receptionist. |
| `forget` | `[]` | What must never be stored. |
| `consolidate` | `"turn"` | `"turn"`: after every exchange. `"call.ended"`: one pass per call — cheapest, and the observer only hears at the end. |
| `model` | `openrouter/qwen/qwen3-8b` | Extractor model. Keep it small; it runs constantly. |
| `contactKey` | `["contactId","userId","phone"]` | Metadata key(s) that identify the contact on WebRTC/chat. |
| `enabled` | `true` | `false` switches memory off without removing the block. |

## `{{MEMORY}}` — what the prompt sees

The active facts of the contact, as markdown, one fact per section, seeded before the first turn and refreshed after every pass:

```md
# +51987654321

## preference · m_9f2a1c07
Prefers Valeria for facials  (since 2026-08-15)

## health · m_35004417
Allergic to almond oil  (since 2026-06-02)

## contact · m_1c07b2e4
Prefers WhatsApp; does not want to be called  (since 2026-08-15)
```

Put `{{MEMORY}}` where you want it in your prompt. Leave it out and the agent still learns (you still get `memory.ops`) — it just does not read.

## `agent.memory` — reading it back

Reads go over REST with your API key; the agent does not have to be online, which is what lets a back office ask questions long after the calls ended.

```typescript
// everything about one contact
const { facts, memoryMd } = await agent.memory.get("+51987654321");

// semantic + lexical search — one contact…
await agent.memory.search("who does she prefer for facials", { contact: "+51987654321", k: 3 });
// …or across every contact of the agent
await agent.memory.search("asked not to be called", { k: 20 });
// → [{ contact, id, kind, text, score }]

// the right to be forgotten: facts, memory.md and index entries, gone
await agent.memory.forget("+51987654321");
```

The same three calls exist as HTTP for dashboards without the SDK:

```
GET    /api/memory/search?agent=front-desk&q=…[&contact=…][&k=6]
GET    /api/memory/front-desk/<contact>
DELETE /api/memory/front-desk/<contact>
Authorization: Bearer <PINECALL_API_KEY>
```

## Giving the model more than the summary

`{{MEMORY}}` is the core memory — short, always in context. For long histories, let the model *ask*:

```typescript
const recall = tool({
  name: "recall",
  description: "Search everything known about this caller beyond the summary in context",
  schema: z.object({ query: z.string() }),
  execute: async ({ query }, call) =>
    agent.memory.search(query, { contact: call.metadata.contactId as string, k: 5 }),
});
```

## What it is not

- **Not a transcript store.** That is [`history`](/guides/conversation-history); use both — they answer different questions.
- **Not shared across agents.** Memory is keyed by `org:agent`; two agents of one org keep separate memories of the same person. Share it by giving both agents the same contact ids and querying across.
- **Not a place for what `forget` names.** The extractor is told; the store never sees it. Say what must not be kept.

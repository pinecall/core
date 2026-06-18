---
title: Knowledge bases (RAG)
description: Tutorial — ground a voice or chat agent on your own documents with retrieval-augmented generation.
---

# Knowledge bases (RAG)

A **knowledge base** is a set of documents your agent answers from. You upload the
documents once, attach the knowledge base to an agent, and on every turn the
server retrieves the most relevant chunks for what the user said and injects them
into the prompt — no fine-tuning, no vector database to run yourself.

It works the same for **voice** and **chat**.

This tutorial builds a support agent grounded in your help docs, end to end.

> **Paid feature.** Knowledge bases require a paid plan (**Starter** or higher). On
> a free trial, creating or using a knowledge base is blocked — both the dashboard
> and the CLI will prompt you to upgrade. Everything else below assumes a paid org.

---

## Step 1 — Create a knowledge base

You can do this in the dashboard or from the CLI. Either way you get a **knowledge
base id** (e.g. `kb_1a2b3c`) — you'll attach that to your agent.

### Option A — Dashboard

1. Open [platform.pinecall.io](https://platform.pinecall.io) → **Knowledge**.
2. Click **New knowledge base**, give it a name (e.g. "Help docs"), and create it.
3. The knowledge base page shows its **id** (copyable) — keep it for Step 3.

### Option B — CLI

```bash
pinecall knowledge create "Help docs"
#   ✓ Created knowledge base Help docs
#     id: kb_1a2b3c
```

---

## Step 2 — Add your documents

Upload Markdown or text files (`.md`, `.markdown`, `.txt`). Each upload re-trains
the index automatically.

### Dashboard

On the knowledge base page, drag files into the uploader (or paste text). You'll
see each document listed; click one to read it.

### CLI

```bash
# Upload local files — paths are kept, so re-pushing updates in place (idempotent)
pinecall knowledge push kb_1a2b3c ./help/*.md

# List what's in the knowledge base
pinecall knowledge docs kb_1a2b3c

# Check what the agent will retrieve for a question — retrieval only, no LLM
pinecall knowledge query kb_1a2b3c "how do I reset my password"
```

See the [CLI reference](/reference/cli) for every `pinecall knowledge` command.

---

## Step 3 — Build the agent

Pass the knowledge base id as `knowledgeBase`. Use the **`{{RAG_CONTEXT}}`** prompt
variable to control exactly where the retrieved documents are placed:

```ts
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall();

const agent = pc.agent("support", {
  voice: "elevenlabs/sarah",
  llm: "anthropic/claude-haiku-4-5",
  language: "en",

  // Attach the knowledge base from Step 1
  knowledgeBase: "kb_1a2b3c",

  prompt: `You are a friendly support agent for Acme.
Answer the customer using ONLY the help documentation below. If the answer
isn't there, say you're not sure and offer to create a ticket — never guess.

{{RAG_CONTEXT}}

Keep replies short and conversational.`,

  greeting: "Hi! You've reached Acme support — how can I help?",
  phoneNumber: "+14155551234", // omit for chat-only
});
```

That's the whole integration. Before each LLM turn, the server:

1. takes the user's latest message,
2. retrieves the top matching chunks from `kb_1a2b3c`,
3. substitutes them into `{{RAG_CONTEXT}}` (or appends them if you omit the
   variable), and
4. runs the LLM with that grounded prompt.

### Where the context goes — `{{RAG_CONTEXT}}`

- **Prompt contains `{{RAG_CONTEXT}}`** → retrieved docs are inserted exactly there.
- **Prompt omits `{{RAG_CONTEXT}}`** → retrieved docs are appended automatically, so
  a knowledge base works out of the box.
- **Nothing relevant / no knowledge base** → `{{RAG_CONTEXT}}` resolves to empty and
  the agent behaves like a normal agent.

---

## Step 4 — Run and test it

```bash
# Start the agent
pinecall run support.ts

# In another terminal, chat with it (text)
pinecall chat support
```

Ask it something covered by your docs — the answer should come straight from them.
Call the number to test the same behaviour by voice. To sanity-check retrieval
without spending an LLM call, use `pinecall knowledge query`.

---

## How it works

- **Retrieval is semantic** (embeddings), not keyword search — phrase questions
  naturally.
- **Documents are chunked by heading**, so well-structured Markdown retrieves best.
- **Sources event** — when retrieval runs, the server emits a `docs.sources` event
  on the data channel with the documents it used (title, heading, score), so a
  browser UI can show citations next to the answer.
- The retrieved context counts toward the LLM's context window — keep documents
  focused.

## Keeping the knowledge base in sync

Re-push whenever the source documents change — `push` upserts by path, so it's safe
to run repeatedly:

```bash
pinecall knowledge push kb_1a2b3c ./help/*.md   # updates changed docs, adds new ones
pinecall knowledge rm kb_1a2b3c <docId>         # remove one
pinecall knowledge reindex kb_1a2b3c            # force a rebuild
```

## Limits

- Paid plans only (Starter, Pro, Enterprise).
- Document formats: `.md`, `.markdown`, `.txt`. Convert PDFs/Docx to text first.
- A knowledge base belongs to your organization; attach it by id to any of your
  agents.

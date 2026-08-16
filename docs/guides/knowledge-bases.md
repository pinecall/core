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

### Grounding on several knowledge bases

`knowledgeBase` also accepts an **array** of ids. The server retrieves from every
listed knowledge base and **merges the top chunks across them by score** into one
`{{RAG_CONTEXT}}` block — so you can keep, say, product docs and billing FAQs as
separate knowledge bases and ground a single agent on both:

```ts
pc.agent("support", {
  llm: "anthropic/claude-haiku-4-5",
  knowledgeBase: ["kb_product", "kb_billing"],   // queried together, merged by score
  prompt: "Answer from the docs.\n\n{{RAG_CONTEXT}}",
});
```

> **Skills compose here too.** A [skill](/guides/skills) can carry its own
> `knowledgeBase`; while the skill is active, its knowledge base is added to the
> retrieval set alongside the agent's, and dropped again when the skill unloads.

---

## Programmatic API

Everything the dashboard and the CLI do is also a plain function on the package
root, so a build script — or an app that lets *its* users bring their own
documents — can create a knowledge base, keep it in sync and debug retrieval
without shelling out to the CLI.

These functions talk to the **Playground** (management) API, not to the voice
server, and they authenticate with your **org API key**. The base URL comes from
`playgroundUrl`, then `PINECALL_PLAYGROUND_URL`, then
`https://playground.pinecall.io`.

The whole path — create, push a folder of `.md` files, attach, query — end to end:

```ts
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  Pinecall,
  createKnowledgeBase,
  pushDocs,
  queryKnowledge,
  KnowledgeApiError,
  type KnowledgeDocInput,
} from "@pinecall/sdk";

const auth = { apiKey: process.env.PINECALL_API_KEY! };

// 1. Create the knowledge base
const kb = await createKnowledgeBase(auth, "Help docs", "Acme customer support");
console.log("knowledge base:", kb.id);

// 2. Push every .md file in ./help — `path` is the identity, so re-running
//    this script updates documents in place instead of duplicating them.
const dir = "./help";
const docs: KnowledgeDocInput[] = [];
for (const file of await readdir(dir)) {
  if (!file.endsWith(".md")) continue;
  docs.push({
    path: file,
    title: file.replace(/\.md$/, ""),
    text: await readFile(path.join(dir, file), "utf8"),
  });
}

const results = await pushDocs(auth, kb.id, docs);
for (const r of results) {
  console.log(r.ok ? `  ✓ ${r.path}` : `  ✗ ${r.path}: ${r.error?.message}`);
}

// 3. Attach it to an agent — same `knowledgeBase` field as Step 3
const pc = new Pinecall();
pc.agent("support", {
  llm: "anthropic/claude-haiku-4-5",
  knowledgeBase: kb.id,
  prompt: "Answer from the docs below.\n\n{{RAG_CONTEXT}}",
});

// 4. Debug retrieval — no LLM in the loop, just the chunks the agent would see
const hits = await queryKnowledge(auth, kb.id, "how do I reset my password", { k: 5 });
for (const hit of hits) {
  console.log(hit.score.toFixed(3), hit.doc_title, "—", hit.heading);
}
```

A batch push never aborts on one bad document: `pushDocs` returns one
`PushResult` per input, in order, each with its own `ok` / `error`.

### The rest of the surface

| function | does |
| --- | --- |
| `listKnowledgeBases(opts)` | every knowledge base in the org |
| `createKnowledgeBase(opts, name, description?)` | create one |
| `getKnowledgeBase(opts, kbId)` | the knowledge base plus its document listing |
| `deleteKnowledgeBase(opts, kbId)` | delete it and its documents |
| `reindexKnowledge(opts, kbId)` | force a rebuild of the index |
| `pushDoc(opts, kbId, doc)` | upsert one document, keyed on `path` |
| `pushDocs(opts, kbId, docs)` | upsert a batch, per-document results |
| `getDoc(opts, kbId, docId)` | one document, with its text |
| `deleteDoc(opts, kbId, docId)` | remove one document |
| `queryKnowledge(opts, kbId, query, { k })` | retrieval only — the top `k` chunks |

### Handling the paid-feature wall

An org without knowledge bases on its plan gets HTTP 402, and that arrives as a
typed `KnowledgeApiError` with `code === "UPGRADE_REQUIRED"` — catch it and offer
the upgrade instead of parsing a message:

```ts
try {
  await createKnowledgeBase(auth, "Help docs");
} catch (err) {
  if (err instanceof KnowledgeApiError && err.code === "UPGRADE_REQUIRED") {
    console.error("Knowledge bases need a Starter plan or higher.");
  } else {
    throw err;
  }
}
```

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

- **Retrieval is hybrid** — semantic embeddings *fused with* a keyword (BM25)
  lane. Phrase questions naturally, and exact terms or acronyms (e.g. `TTS` vs
  `STT`, a product name, an error code) still match precisely instead of blurring
  into similar wording.
- **Documents are chunked by heading** (section-aligned, never mid-section), so
  well-structured Markdown retrieves best.
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

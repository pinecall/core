---
title: "Project Structure"
description: "The recommended layout for a Pinecall app — one process per agent, token endpoints beside the agent, shared domain in packages/."
---

# Project Structure

There is one layout that keeps working as a Pinecall app grows, and this is it.
It is opinionated on purpose: **one process per agent**, the token endpoint next
to the agent that mints for, and everything your agent's tools actually *do*
extracted into a plain package with no Pinecall import in it.

```
my-app/
├── apps/
│   ├── agents/
│   │   ├── support/
│   │   │   ├── index.mjs          # pc.agent("support", {...}) — the whole agent
│   │   │   ├── tools.mjs          # tool() definitions, thin: they call packages/
│   │   │   ├── token.mjs          # GET /token — mints wrt_/cht_ for the browser
│   │   │   ├── specs/             # pinecall test specs (YAML)
│   │   │   │   ├── greeting.spec.yaml
│   │   │   │   └── refund.spec.yaml
│   │   │   ├── package.json       # start / dev / test
│   │   │   └── .env               # PINECALL_API_KEY — and nothing else
│   │   └── outbound/              # a second agent = a second folder, same shape
│   │       └── …
│   └── web/                       # your site or dashboard — separate deployable
│       └── …
├── packages/
│   └── domain/                    # orders, customers, the DB. No @pinecall import.
│       ├── src/
│       └── package.json
└── package.json                   # workspaces: ["apps/*/*", "packages/*"]
```

## The rules, and why

### One folder per agent, one process per agent

An agent is a Node process holding a WebSocket. Two agents in one process share
a crash, a deploy, and a restart. `apps/agents/<name>/` with its own
`package.json` means `npm start` runs exactly one agent and nothing else, and
you can move that folder to its own container the day traffic asks you to. This
is the **standalone** topology from
[Deployment Topologies](/concepts/deployment-topologies) — start here even when
you have one agent, because splitting later is a migration and starting split is
free.

### `.env` holds `PINECALL_API_KEY` and nothing else

Everything about the agent — model, voice, STT, phone number, greeting, prompt —
belongs in `index.mjs`, where it is diffable and reviewable. The env file exists
because a credential cannot be committed. If your `.env` grows a second row of
agent config, that config has escaped code review.

The one legitimate second variable is the **environment split**:

```js
// index.mjs
const slug = process.env.PINECALL_AGENT_SLUG
  ?? (process.env.PINECALL_MODE === "dev" ? "dev-support" : "support");

export const agent = pc.agent(slug, { /* … */ });
```

`pc.agent()` **hot-reloads the live agent**. Running the file locally with a
production key retargets production. The dev slug is what makes `npm run dev`
safe to hammer — see [Dev Mode](/guides/dev-mode).

```json
{
  "scripts": {
    "start": "node index.mjs",
    "dev": "PINECALL_MODE=dev pinecall run index.mjs",
    "test": "pinecall test specs --agent dev-support"
  }
}
```

### The token endpoint lives beside its agent

Browser channels (WebRTC, chat) connect **straight** to `voice.pinecall.io`; the
only thing your backend does is mint a short-lived token. Keep that route in the
agent folder — `token.mjs` — because it is the one piece of HTTP that must agree
with this agent's slug and metadata. Putting it in `apps/web/` means every slug
rename becomes a two-repo change, and the API key ends up in the web app's env
instead of the agent's.

See [WebRTC in the Browser](/guides/webrtc-browser) and
[Token Metadata](/guides/token-metadata) — sealed metadata is how the logged-in
user's identity reaches the agent without the browser being able to forge it.

### `specs/` next to the code it tests

`pinecall test specs/` is the regression suite for a prompt. Prompts drift the
way code drifts; the specs belong in the same folder and the same commit as the
prompt they pin. See [Testing Agents](/guides/testing-agents).

### `packages/` for the domain, and no Pinecall import in it

A tool should be five lines:

```js
// apps/agents/support/tools.mjs
import { tool } from "@pinecall/sdk";
import { z } from "zod";
import { findOrder } from "@my-app/domain";

export const lookupOrder = tool({
  name: "lookupOrder",
  description: "Look up an order by its number.",
  schema: z.object({ orderNumber: z.string() }),
  execute: ({ orderNumber }) => findOrder(orderNumber),
});
```

`findOrder` knows about your database. It does not know it is being called by a
voice agent, so `apps/web/` can call it too, and you can unit-test it without a
call in flight. When a tool's `execute` grows a query builder, that query builder
has landed in the wrong package.

### The web app is a separate deployable

`apps/web/` talks to the agent through the token endpoint and through your own
API — never by importing the agent module. That is what lets you deploy the site
without dropping calls in flight.

## Scaling this shape

- **A second agent** — a second folder under `apps/agents/`. Same shape, its own
  `.env`, its own process.
- **Many customers, one agent** — do *not* fork the folder per tenant. One agent,
  per-session identity via sealed token metadata:
  [Multi-Tenant Dashboards](/guides/multi-tenant).
- **A single-purpose phone or WhatsApp bot** — you can drop `apps/web/` entirely.
  That is the *headless* topology, and this layout collapses into it cleanly.
- **You need SSE dashboards from the agent process** — that is the *embedded*
  topology: the agent moves into `apps/web/`. It is the one case where merging
  the two is right, and the tradeoff is in
  [Deployment Topologies](/concepts/deployment-topologies).

## What's next

- [Quickstart](/quickstart) — the smallest working agent
- [Deployment Topologies](/concepts/deployment-topologies) — embedded vs standalone vs headless
- [Dev Mode](/guides/dev-mode) — prod and dev agents on the same number
- [Testing Agents](/guides/testing-agents) — the specs folder in anger

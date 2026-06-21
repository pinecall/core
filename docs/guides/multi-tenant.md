---
title: "Multi-Tenant Dashboards"
description: "Host many tenants on one Pinecall instance with scoped event streams."
---

# Multi-Tenant Dashboards

A common pattern: you're building a SaaS where each customer has their own agents, and each customer's dashboard should only show their own calls. Pinecall's SSE filtering handles this server-side — no data leakage between tenants.

This guide has two parts: **(1)** injecting the logged-in user's identity into the agent via **sealed token metadata** (the recommended multi-tenant pattern), and **(2)** scoping each tenant's dashboard event stream.

## One shared agent + per-user session (sealed token metadata) — recommended

You usually do **not** need a separate agent per tenant. Run **one shared agent** and
inject the logged-in user's session into each call as **sealed token metadata** — the
identity rides *inside the token*, signed by your server, so the browser can't forge or
alter it. This is the cleanest way to make a single agent multi-tenant + per-user.

### How it works
`createToken(channel, agentId, metadata)` bakes a `metadata` object into the token at
mint time (server-side, trusted). It arrives in your agent as **`call.metadata`** —
use it to scope every tool/query to that tenant and to fill the prompt with the user's
context. The browser never sees or sets it beyond the opaque token.

```typescript
// ── 1. SERVER: mint a token with the signed-in user's session sealed in ──
//    (behind your auth — the metadata comes from the SESSION, never the client)
app.post("/api/lumi/token", authMiddleware, async (req, res) => {
  const token = await pc.createToken("chat", "lumi", {   // ← 3rd arg = sealed metadata
    companyId: req.auth.companyId,
    userId:    req.auth.userId,
    role:      req.auth.role,
    userName:  req.auth.name,
    threadId:  req.body.threadId,        // e.g. to restore a conversation
  });
  res.json(token); // { token: "cht_..." }
});
```

```typescript
// ── 2. BROWSER: connect via tokenProvider — it returns the sealed token (voice/widget identical) ──
import { ChatSession } from "@pinecall/web/chat";
const chat = new ChatSession({
  agent: "lumi",
  tokenProvider: async () => {
    const res = await fetch("/api/lumi/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",                 // send your auth cookie/session
      body: JSON.stringify({ threadId }),
    });
    return res.json();                        // { token, server } — metadata is sealed inside
  },
});
await chat.connect();
```

```typescript
// ── 3. AGENT: read call.metadata → scope tools + inject the session ──
const pc = new Pinecall();
const agent = pc.agent("lumi", {
  prompt: `${SYSTEM}\n\n{{SESSION}}`,         // {{SESSION}} filled per call
  llm: "anthropic/claude-haiku-4-5",
  tools: [listAppointments, bookAppointment], // each reads call.metadata (below)
  history: myHistoryStore,                     // persist/restore per user+thread
});

// Fill per-session prompt vars from the sealed metadata before each turn.
const pushVars = (call) => {
  const m = call.metadata;                      // { companyId, userId, role, ... } — trusted
  call.setPromptVars({
    SESSION: `<session><user>${esc(m.userName)}</user><role>${esc(m.role)}</role></session>`,
  });
};
agent.on("call.preparing", pushVars);
agent.on("call.started", pushVars);
```

```typescript
// Tools scope by the SAME metadata — isolation lives in CODE, never the prompt.
const listAppointments = tool({
  name: "list_appointments",
  description: "List the tenant's appointments for a date.",
  schema: z.object({ date: z.string().optional() }),
  execute: async ({ date }, call) => {
    const { companyId } = call.metadata;        // sealed → trusted
    return db.scope(companyId).appointments.forDate(date);
  },
});
```

### Why metadata (not one-agent-per-tenant or the prompt)
- **Scales to N tenants with one agent** — no per-tenant agent registration; identity is per *call*, not per *agent*.
- **Trusted & unspoofable** — the metadata is signed into the token by your server; a malicious client can't change `companyId`/`role`.
- **Tenant isolation is enforced in code** (tools scope by `call.metadata.companyId`), **never** by trusting the prompt.
- **Prompt-injection safe** — treat everything from `call.metadata` (and any user text) as **data**: wrap it in clear tags (`<session>…</session>`), escape it, and tell the model in the system prompt to treat those tags as data, never instructions.

> **Sealed metadata works the same on every channel** — mint with `pc.createToken("webrtc"|"chat", agentId, metadata)` (or `agent.createToken(channel, metadata)`), then consume it in the browser via a `tokenProvider` on `new ChatSession({ agent, tokenProvider })` / `new VoiceSession({ agent, tokenProvider })`. It always surfaces as `call.metadata`. ⚠️ The `<VoiceWidget metadata={{...}} />` / `VoiceSession({ metadata })` prop is the **client-set, forgeable** variant — fine for UI hints, but seal anything you authorize on into the token. See [`createToken`](/api/pinecall) and [Conversation History](/guides/conversation-history) (persist/restore per user via metadata).

## The pattern

Each tenant owns one or more agents. When a tenant loads their dashboard, the SSE endpoint streams only events from their agents.

![Multi-tenant SSE scoping](/assets/diagrams/multi-tenant-sse.png)

## Building it

### 1. Store the agent-tenant mapping

In your existing app database, track which agents belong to which tenant:

```typescript
// e.g. in your tenants table
{
  id: "tenant_acme",
  name: "Acme Corp",
  agents: ["acme-support", "acme-sales"],
}
```

### 2. Spin up the agents

```typescript
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });

const tenants = await db.tenants.findAll();

for (const tenant of tenants) {
  for (const agentId of tenant.agents) {
    const config = await db.agentConfigs.findOne(agentId);
    pc.agent(agentId, {
      prompt: config.prompt,
      llm: config.llm,
      voice: config.voice,
      language: config.language,
      phoneNumber: config.phoneNumber,
    });
  }
}
```

### 3. Stream events scoped to the user's tenant

`pc.stream()` accepts an `agents` filter. Pass only the agents this user is allowed to see:

```typescript
app.get("/api/events", authMiddleware, (req, res) => {
  const userId = req.auth.userId;
  const tenantId = req.auth.tenantId;

  // Look up which agents this tenant owns
  const tenant = req.cache.tenants.get(tenantId);
  const allowedAgents = tenant?.agents ?? [];

  if (allowedAgents.length === 0) {
    res.status(403).end();
    return;
  }

  // Subscribe only to those agents — events from other tenants never reach the stream
  pc.stream(res, { agents: allowedAgents });
});
```

The filter is **server-side**. Events from agents the user doesn't own never touch the wire. There's no data leakage possible from the client.

### 4. Consume the stream in the browser

```javascript
const source = new EventSource("/api/events");

source.addEventListener("call.started", (e) => {
  const { agent, from, transport } = JSON.parse(e.data);
  showCallNotification(`[${agent}] Incoming from ${from}`);
});

source.addEventListener("user.message", (e) => {
  const { agent, callId, text } = JSON.parse(e.data);
  appendToTranscript(callId, "user", text);
});

source.addEventListener("bot.speaking", (e) => {
  const { agent, callId, text } = JSON.parse(e.data);
  appendToTranscript(callId, "bot", text);
});
```

## Per-tenant token endpoints

The same pattern applies to WebRTC and chat tokens. Each tenant can only mint tokens for their own agents:

```typescript
app.get("/api/token", authMiddleware, async (req, res) => {
  const { agentId, channel } = req.query;
  const tenant = req.cache.tenants.get(req.auth.tenantId);

  if (!tenant.agents.includes(agentId)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const agent = pc.getAgent(agentId);
  const token = await agent.createToken(channel);
  res.json(token);
});
```

## Per-tenant tool isolation

Tools also need to be tenant-aware. Since tools are registered per agent, build them with a factory that closes over the tenant — each agent gets its own tenant-scoped tool:

```typescript
import { tool } from "@pinecall/sdk";
import { z } from "zod";

function lookupOrderTool(tenantId) {
  const tenantDb = db.scope(tenantId);
  return tool({
    name: "lookupOrder",
    description: "Look up an order by ID",
    schema: z.object({ orderId: z.string() }),
    execute: async ({ orderId }) => {
      return await tenantDb.orders.findOne(orderId);
    },
  });
}

// When spinning up each agent, pass its tenant-scoped tools:
pc.agent(agentId, {
  prompt: config.prompt,
  tools: [lookupOrderTool(tenant.id)],
});
```

## Scaling considerations

A single `Pinecall` instance handles dozens to hundreds of agents on one WebSocket. For larger fleets:

- **Split by region** — run one `Pinecall` instance per geographic region, route tenants to the nearest
- **Split by tier** — separate processes for free/paid tiers to isolate resource limits
- **Split by capability** — one process for voice-only tenants, another for WhatsApp-heavy tenants

## What's next

- [Deployment topologies](/concepts/deployment-topologies) — embedded is required for SSE
- [Security](/security) — token model details
- [Events reference](/reference/events) — all events available over SSE

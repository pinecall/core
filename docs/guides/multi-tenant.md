---
title: "Multi-Tenant Dashboards"
description: "Host many tenants on one Pinecall instance with scoped event streams."
---

# Multi-Tenant Dashboards

A common pattern: you're building a SaaS where each customer has their own agents, and each customer's dashboard should only show their own calls. Pinecall's SSE filtering handles this server-side — no data leakage between tenants.

## The pattern

Each tenant owns one or more agents. When a tenant loads their dashboard, the SSE endpoint streams only events from their agents.

```
Tenant A's browser ──► /api/events ──► SSE: events from agent_a1, agent_a2 only
Tenant B's browser ──► /api/events ──► SSE: events from agent_b1 only
```

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
await pc.connect();

const tenants = await db.tenants.findAll();

for (const tenant of tenants) {
  for (const agentId of tenant.agents) {
    const config = await db.agentConfigs.findOne(agentId);
    pc.deploy(agentId, {
      prompt: config.prompt,
      model: config.model,
      voice: config.voice,
      language: config.language,
      channels: config.channels,
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

Tools also need to be tenant-aware. The cleanest way is to look up the tenant from the agent ID:

```typescript
function tenantForAgent(agentId) {
  return agentToTenant.get(agentId);
}

agent.on("llm.tool_call", async (data, call) => {
  const tenantId = tenantForAgent(call.agentId);
  const tenantDb = db.scope(tenantId); // your tenant-scoped DB connection

  const results = [];
  for (const tc of data.toolCalls) {
    const args = JSON.parse(tc.arguments);
    const result = await handleTool(tc.name, args, tenantDb);
    results.push({ toolCallId: tc.id, result });
  }
  call.toolResult(data.msgId, results);
});
```

## Scaling considerations

A single `Pinecall` instance handles dozens to hundreds of agents on one WebSocket. For larger fleets:

- **Split by region** — run one `Pinecall` instance per geographic region, route tenants to the nearest
- **Split by tier** — separate processes for free/paid tiers to isolate resource limits
- **Split by capability** — one process for voice-only tenants, another for WhatsApp-heavy tenants

The SDK has no hard limit, but standard Node.js performance considerations apply. Profile before scaling out.

## What's next

- [Deployment topologies](/concepts/deployment-topologies) — embedded is required for SSE
- [Security](/security) — token model details
- [Events reference](/reference/events) — all events available over SSE

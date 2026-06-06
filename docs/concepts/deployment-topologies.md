---
title: "Deployment Topologies"
description: "Embedded, standalone, or headless — pick the topology that fits your architecture."
---

# Deployment Topologies

Pinecall agents are just Node.js processes. Where you run them is your choice. There are three common topologies — each is valid, each has tradeoffs.

## The fundamental split

Before topology, understand the two communication patterns:

**1. Backend channels** — phone, SIP, WhatsApp. These talk to your Node.js process via the SDK's WebSocket. Your code receives events through an in-process EventEmitter.

```
Twilio / Meta ──► voice.pinecall.io ──► SDK WebSocket ──► Your Node.js
                                                              │
                                                         EventEmitter
                                                    agent.on("call.started")
                                                    agent.on("user.message")
                                                    agent.on("llm.tool_call")
```

**2. Browser channels** — WebRTC and chat. The browser connects **directly** to `voice.pinecall.io`. Your backend's only job is minting short-lived tokens.

```
Browser ──► your /api/token endpoint ──► token
        ──► voice.pinecall.io with token ──► live session
```

This split is why some topologies support SSE event streaming and others don't — SSE requires the agent to be in the same process as your web server.

## Topology 1: Embedded

Agent runs inside your existing web app (Express, Next.js, Hono, Remix). The web server and the agent share a Node.js process.

```
┌──────────────────────────────────────┐
│           Your Node process          │
│                                      │
│  ┌──────────┐     ┌──────────────┐   │
│  │ Web App  │     │ Agent (SDK)  │   │
│  │ Express  │◄────│ pc.agent()   │   │
│  │ /api/*   │     │ event bus    │   │
│  └──────────┘     └──────┬───────┘   │
│                          │           │
│    SSE ✅               WS          │
│    agent.stream()        │           │
│    pc.stream()           ▼           │
│                   voice.pinecall.io  │
└──────────────────────────────────────┘
```

**Pros:**
- SSE streaming works (you can build live dashboards)
- One deployment unit — easy ops
- Token endpoint is one route away from the agent

**Cons:**
- The agent process restarts every time you deploy the web app
- Web traffic and voice traffic share resources

**When to use:** small apps, dashboards that need live call event streaming, single-team projects.

## Topology 2: Standalone

Agent runs as a separate process from your web app. The web app handles HTTP, the agent process handles voice.

```
┌──────────────┐     ┌──────────────────┐
│  Web App     │     │  Agent Process   │
│  (Next.js)   │     │  node agent.js   │
│              │     │  pc.agent()      │
│  SSE ❌      │     │  WS → voice.io   │
└──────────────┘     └──────────────────┘
```

**Pros:**
- Independent deploys — restart the agent without touching the web app
- Independent scaling — give the agent its own resources
- Crash isolation — a web bug doesn't kill calls in flight

**Cons:**
- No SSE — the web app can't stream events from the agent process directly. If you need live dashboards, the agent has to expose its own SSE endpoint or push to a shared bus (Redis, NATS).
- Two deployments to manage

**When to use:** higher-traffic apps, when ops cares about independent scaling, when you want to avoid the "web deploy kills in-flight calls" problem.

## Topology 3: Headless

No web server at all. Just the agent. Use this when you only need phone/SIP/WhatsApp — no browser channels, no dashboards, no tokens to mint.

```typescript
// agent.js — a complete production agent, no web server needed
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY });
await pc.connect();

const agent = pc.agent("support", {
  prompt: "You are a support agent for an online store...",
  llm: "openai/gpt-4.1-mini",
  voice: "elevenlabs/sarah",
  language: "en",
  phoneNumbers: ["+13186330963"],
  tools: [lookupOrder, processReturn],
});

agent.on("call.started", (call) => call.say("Hi! How can I help?"));
console.log("Support agent is live. Ctrl+C to stop.");
```

**Pros:**
- Lowest possible complexity
- No HTTP surface to attack or maintain
- Easy to ship as a container, a systemd unit, or a serverless function

**Cons:**
- No browser channels (no WebRTC, no chat) unless someone else mints tokens
- No SSE
- No dashboards from this process

**When to use:** IoT devices, intercoms, single-purpose phone bots, WhatsApp-only bots, scheduled outbound campaigns.

## Comparison

| Feature | Embedded | Standalone | Headless |
|---|---|---|---|
| SSE (`agent.stream()`) | ✅ | ❌ | ❌ |
| WebRTC / Chat | ✅ | ✅ (token from web app) | ❌ (or you build it) |
| Phone / SIP | ✅ | ✅ | ✅ |
| WhatsApp | ✅ | ✅ | ✅ |
| Outbound calls | ✅ | ✅ | ✅ |
| Operational complexity | Medium | Medium | **Lowest** |
| Independent scaling | ❌ | ✅ | ✅ |
| Crash isolation | ❌ | ✅ | n/a |

## Which one should you pick?

- **Just starting out** — embedded. Get something running, split later if you need to.
- **You need browser channels and a dashboard** — embedded.
- **You're scaling and ops cares** — standalone.
- **You're shipping a fixed-purpose device or WhatsApp-only bot** — headless.

Migration between topologies is cheap. The agent code is the same in all three. You're just choosing where to run it.

## What's next

- [Multi-tenant dashboards](/guides/multi-tenant) — embed multiple agents, scope events per user
- [Dev mode](/guides/dev-mode) — run prod and dev agents on the same phone number
- [SSE streaming reference](/reference/events) — for embedded dashboards

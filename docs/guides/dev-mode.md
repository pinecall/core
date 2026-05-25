---
title: "Dev Mode"
description: "Run dev and production agents on the same phone number, with zero extra Twilio cost."
---

# Dev Mode

A common pain in voice AI: every developer needs their own phone number, every PR review needs another, and each costs you $1/month plus per-minute usage. Worse, you can't easily test "what if a real customer called this version" without disrupting prod.

Pinecall's dev mode solves both. **One phone number, many agents in parallel**, routed by the caller's phone number. Production handles all calls except yours; your calls go to your dev agent.

## How it works

Every agent has an ID — `florencia`, `mara`, `support`. In dev mode, you give your agent a unique slug — `dev-berna-florencia`, `dev-juan-florencia` — and tell Pinecall which phone numbers should route to that slug.

```
           Incoming call to +13186330963
                      │
             ┌────────┴────────┐
             │                 │
        Caller in          Caller NOT in
        DEV_CALLERS        DEV_CALLERS
             │                 │
   ┌─────────┴─────────┐  ┌───┴─────────┐
   │  dev-berna-       │  │             │
   │  florencia        │  │  florencia  │
   │  (your dev agent) │  │  (prod)     │
   └───────────────────┘  └─────────────┘
```

Zero extra cost. One number serves prod and every dev simultaneously.

## Setup

### 1. Make the agent ID environment-aware

```typescript
import { Pinecall } from "@pinecall/sdk";
import { userInfo } from "os";

const isDev = process.env.NODE_ENV === "development";
const agentId = isDev ? `dev-${userInfo().username}-florencia` : "florencia";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });
await pc.connect();

const agent = pc.deploy(agentId, {
  prompt: "...",
  model: "gpt-4.1-mini",
  voice: "elevenlabs:abc",
  channels: ["+13186330963"], // shared with prod!
});
```

`os.userInfo().username` gives you `berna` on Berna's machine, `juan` on Juan's, etc. Each dev automatically gets a unique slug.

### 2. Tell Pinecall which callers to route to dev

```typescript
if (isDev) {
  const callers = process.env.DEV_CALLERS;
  if (callers) {
    agent.routeCallers(callers.split(",").map((s) => s.trim()));
  }
}
```

### 3. Each dev gets their own `.env.local`

```bash
# .env.local — gitignored, each dev sets their own
DEV_CALLERS=+34607827824
```

Now when Berna calls `+13186330963` from her phone (`+34607827824`), the call routes to `dev-berna-florencia`. When anyone else calls, it goes to `florencia` (prod).

## Multiple devs at once

| Developer | Agent ID | Phone routing |
|---|---|---|
| Berna | `dev-berna-florencia` | Calls from `+34607...` → Berna's agent |
| Juan | `dev-juan-florencia` | Calls from `+34612...` → Juan's agent |
| Production | `florencia` | All other callers |

```
+13186330963 (shared Twilio number)
    │
    ├── Call from +34607... → dev-berna-florencia
    ├── Call from +34612... → dev-juan-florencia
    └── Call from anyone else → florencia (production)
```

## WhatsApp dev routing

WhatsApp uses the same sender-based routing. `routeCallers()` configures both phone and WhatsApp routing in one call:

```typescript
if (isDev) {
  agent.routeCallers(["+34607827824"]); // routes BOTH phone calls AND WhatsApp messages
}
```

When Berna sends a WhatsApp message from `+34607827824`, it lands on `dev-berna-florencia`. When anyone else sends a message, it lands on prod.

## WebRTC & chat dev routing

WebRTC and chat don't use caller-based routing — there's no "caller number" in a browser. Instead they use **slug-based isolation**: each browser requests a token for a specific agent ID.

```typescript
// Dev mode → agent registers as "dev-berna-florencia"
// The browser requests a token for "dev-berna-florencia" specifically
const token = await createToken({
  channel: "webrtc",
  agentId: "dev-berna-florencia",
  apiKey: process.env.PINECALL_API_KEY!,
});
```

Each dev gets their own slug, their own tokens, their own sessions. Nothing crosses over.

## Why this is better than per-dev phone numbers

| | Per-dev numbers | Pinecall dev mode |
|---|---|---|
| Cost | $1/month/dev + minutes | $0 extra |
| Setup per dev | Buy number, configure routing, share creds | Set `DEV_CALLERS=+...` |
| Realism | Different number = different call origin behavior | Same number, real routing |
| Cleanup when dev leaves | Cancel number, update routing | Delete from `.env.local` |
| Prod isolation | Manual — easy to leak | Automatic — only your number reaches your agent |

## What's next

- [Deployment topologies](/docs/concepts/deployment-topologies) — headless agents are common for dev
- [Multi-tenant](/docs/guides/multi-tenant) — similar isolation pattern for SaaS
- [`Agent.routeCallers`](/docs/api/agent) — the API reference

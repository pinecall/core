---
title: "Passing Metadata to Browser Tokens"
description: "Seal trusted per-user context into WebRTC & chat tokens with createToken — it arrives as call.metadata, unforgeable by the browser."
---

# Passing Metadata to Browser Tokens

When a browser connects over **WebRTC** or **chat**, it doesn't use your API key — it
uses a short-lived **token** that you mint on your server. You can **seal a `metadata`
object into that token**. It rides *inside the signed token*, so the browser can't read,
forge, or alter it, and it surfaces in your agent as [`call.metadata`](/api/call).

This is the mechanism behind per-user and multi-tenant agents: the logged-in user's
identity (user id, role, tenant/company, a thread id to restore) travels with every
connection, **trusted**, so your tools can authorize on it.

> **TL;DR** — mint on the server with `pc.createToken(channel, agentId, metadata)`
> (or `agent.createToken(channel, metadata)`), hand the token to the browser, read it
> back as `call.metadata` in your agent. Works identically for `"webrtc"` and `"chat"`.

## Two kinds of metadata — don't confuse them

| | **Sealed token metadata** ✅ | **Client-set metadata** ⚠️ |
|---|---|---|
| Where it's set | Your **server**, inside `createToken(...)` | The **browser** (`<VoiceWidget metadata>`, `new VoiceSession({ metadata })`, `setContext()`) |
| Can the user forge it? | **No** — signed into the token | **Yes** — it's plain client input |
| Use it for | Identity, role, tenant id, plan — anything you **authorize** on | Live UI hints (current page, cart contents) |
| Arrives as | `call.metadata` | `call.metadata` (merged) / UI context |

**Rule:** anything used for authorization or tenant scoping must be **sealed in the token**.
Never trust client-set metadata for that.

## The flow

```
┌─ Browser ──────────┐      ┌─ Your server (auth'd) ──────────┐      ┌─ Pinecall agent ─────┐
│ tokenProvider()    │ ───▶ │ pc.createToken(channel, agent,  │ ───▶ │ call.metadata        │
│  → fetch /token    │      │   { userId, role, tenantId })   │      │  (trusted, sealed)   │
│ connect with token │ ◀─── │  → { token, server }            │      │ tools scope by it    │
└────────────────────┘      └─────────────────────────────────┘      └──────────────────────┘
```

1. **Browser** asks **your** backend for a token (via `tokenProvider`) — no API key in the browser.
2. **Your server** (behind auth) calls `createToken(channel, agentId, metadata)` — the metadata comes from the **session**, never the request body.
3. **Agent** reads it as `call.metadata` in `call.started` / `call.preparing`, and tools scope by it.

## 1. Server — mint the token with sealed metadata

The metadata must come from the **authenticated session**, not from anything the client sent.

```typescript
import { Pinecall } from "@pinecall/sdk";
const pc = new Pinecall(); // PINECALL_API_KEY from env

// Behind your auth (cookie / JWT / OAuth — whatever you already use)
app.post("/api/token", authMiddleware, async (req, res) => {
  const token = await pc.createToken("chat", "lumi", {
    // ↑ channel    ↑ agentId   ↑ sealed metadata (3rd arg)
    userId:    req.auth.userId,     // from the SESSION — trusted
    role:      req.auth.role,
    companyId: req.auth.companyId,
    userName:  req.auth.name,
    threadId:  req.body.threadId,   // optional: restore a conversation
  });
  res.json(token); // { token, server, expiresIn }
});
```

**Two equivalent ways to mint** — pick by what you have in scope:

```typescript
// A) You only have the Pinecall client → pass agentId explicitly (metadata is the 3rd arg)
const token = await pc.createToken("webrtc", "lumi", { userId: "u_123", role: "admin" });

// B) You have the Agent instance → agentId is implicit (metadata is the 2nd arg)
const agent = pc.agent("lumi", { /* ... */ });
const token = await agent.createToken("webrtc", { userId: "u_123", role: "admin" });
```

> ⚠️ **Watch the arg position.** `pc.createToken(channel, agentId, metadata)` — metadata is
> **3rd**. `agent.createToken(channel, metadata)` — metadata is **2nd** (the agent id is
> already known). Mixing them up silently passes your metadata as an `agentId`.

## 2. Browser — connect with the token

The browser never builds the metadata. It just fetches the opaque token from your endpoint
via `tokenProvider` and connects. Same shape for chat and voice.

### Chat — `ChatSession`

```typescript
import { ChatSession } from "@pinecall/web/chat";

const chat = new ChatSession({
  agent: "lumi",
  tokenProvider: async () => {
    const res = await fetch("/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",              // send your auth cookie
      body: JSON.stringify({ threadId }),
    });
    return res.json();                     // { token, server } — metadata sealed inside
  },
});
await chat.connect();
```

### Voice — `VoiceSession`

```typescript
import { VoiceSession } from "@pinecall/web/core";

const voice = new VoiceSession({
  agent: "lumi",
  tokenProvider: async () => {
    const res = await fetch("/api/token", { method: "POST", credentials: "include" });
    return res.json();                     // { token, server }
  },
});
await voice.connect();
```

### Voice — React `<VoiceWidget>`

```tsx
import { VoiceWidget } from "@pinecall/web";

<VoiceWidget
  agent="lumi"
  tokenProvider={async () => {
    const res = await fetch("/api/token", { method: "POST", credentials: "include" });
    return res.json();
  }}
/>
```

> The `tokenProvider` keeps your API key on the server. Direct token fetch
> (`GET /webrtc/token` / `GET /chat/token`) is only for **public** agents using
> `allowedOrigins` — and that path can't carry sealed metadata. To attach metadata,
> you **must** mint through your own backend with `tokenProvider`.

## 3. Agent — read `call.metadata`

The sealed metadata arrives as `call.metadata`. Use it to fill per-session prompt vars and
to scope every tool — **isolation lives in code, never in the prompt.**

```typescript
const agent = pc.agent("lumi", {
  prompt: `${SYSTEM}\n\n{{SESSION}}`,        // {{SESSION}} filled per call
  llm: "anthropic/claude-haiku-4-5",
  tools: [listAppointments],
  history: myHistoryStore,                    // persist/restore per user+thread
});

// Fill prompt vars from the trusted metadata before each turn
const pushVars = (call) => {
  const m = call.metadata;                    // { userId, role, companyId, ... } — trusted
  call.setPromptVars({
    SESSION: `<session><user>${esc(m.userName)}</user><role>${esc(m.role)}</role></session>`,
  });
};
agent.on("call.preparing", pushVars);
agent.on("call.started", pushVars);

// Tools authorize on the SAME metadata
const listAppointments = tool({
  name: "list_appointments",
  schema: z.object({ date: z.string().optional() }),
  execute: async ({ date }, call) => {
    const { companyId } = call.metadata;      // sealed → safe to authorize on
    return db.scope(companyId).appointments.forDate(date);
  },
});
```

## Restoring conversations with a `threadId`

Seal a `threadId` (or any conversation key) into the token and your history store can
restore the right thread per user:

```typescript
// Server: include the thread the user opened
await pc.createToken("chat", "lumi", { userId, threadId: req.body.threadId });

// Agent: load that thread's history on connect
agent.on("chat.started", async (call) => {
  const { userId, threadId } = call.metadata;
  await myHistoryStore.restore(call, `${userId}:${threadId}`);
});
```

See [Conversation History](/guides/conversation-history) for the full history pattern.

## Security checklist

- ✅ Mint tokens **only on your server, behind auth.** The metadata comes from the session.
- ✅ Treat `call.metadata` (and all user text) as **data**: wrap in tags (`<session>…</session>`), escape it, and tell the model those tags are data, not instructions.
- ✅ Authorize in **code** (tools scope by `call.metadata.companyId`), never by trusting the prompt.
- ❌ Never put secrets you don't want the *agent process* to see in metadata — it's readable server-side by your agent (it's just not forgeable by the browser).
- ❌ Never use the client-set `metadata` prop / `setContext()` for authorization.

## Reference & related

- [`pc.createToken(channel, agentId, metadata?)`](/api/pinecall#createtokenchannel-agentid-metadata) — full signature
- [`agent.createToken(channel, metadata?)`](/api/agent#createtokenchannel-metadata) — agent-form shortcut
- [`call.metadata`](/api/call) — where it surfaces
- [Multi-Tenant Dashboards](/guides/multi-tenant) — one shared agent for every tenant
- [WebRTC in the Browser](/guides/webrtc-browser) — the token endpoint pattern
- [`ChatSession` API](/web/chat/chat-session) — `tokenProvider` option
- [Security](/security) — the full token model

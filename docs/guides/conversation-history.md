---
title: "Conversation History"
description: "Save and restore conversations across calls so your agent remembers returning contacts."
---

# Conversation History

Every call's conversation (transcript + LLM messages) is available when the call ends. The `HistoryStore` interface lets you **persist** conversations automatically and **restore** them on subsequent calls — so your agent remembers what was discussed before.

## Quick start

```typescript
import { Pinecall, JsonFileHistory } from "@pinecall/sdk";

const history = new JsonFileHistory("./data/calls.json");

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });

const agent = pc.agent("my-agent", {
  llm: "openai/gpt-5-chat-latest",
  voice: "elevenlabs/sarah",
  stt: "deepgram/flux",
  prompt: "You are a helpful assistant with memory of past conversations.",
  phoneNumber: "+13186330963",
  history, // ← auto-saves AND auto-restores
});

agent.on("call.started", (call) => {
  call.say("Hello! How can I help?");
});
```

That's it. Every call is auto-saved when it ends, and returning callers get their prior context restored automatically — no extra code needed.

## How it works

### Auto-save on `call.ended`

When `history` is set in the agent config, the SDK automatically saves a `ConversationRecord` when each call ends:

```
call.ended → HistoryStore.save({
    callId, agentId, channel, direction,
    from, to, startedAt, endedAt, duration,
    reason, transcript, messages, metadata
})
```

You never need to write a `call.ended` handler for saving — it happens automatically.

### What gets saved

| Field | Type | Description |
|---|---|---|
| `callId` | string | Unique call ID |
| `agentId` | string | Agent that handled the call |
| `channel` | string | `"phone"`, `"webrtc"`, `"chat"` |
| `direction` | string | `"inbound"` or `"outbound"` |
| `from` | string | Caller identifier (phone number, userId, etc.) |
| `to` | string | Callee identifier |
| `startedAt` | number | Epoch seconds |
| `endedAt` | number | Epoch seconds |
| `duration` | number | Call duration in seconds |
| `reason` | string | Why the call ended (hangup, timeout, etc.) |
| `status` | string | `"active"` while in progress, `"ended"` after `call.ended` |
| `transcript` | array | User/assistant messages (clean text) |
| `messages` | array | Full LLM messages (including tool calls, system prompt) |
| `metadata` | object | Any metadata attached to the call |

### Auto-restore

When your `HistoryStore` implements `findByContact()`, the SDK **automatically restores** prior conversations for returning contacts — for all channels (voice, WebRTC, chat, and WhatsApp).

On each new call or WhatsApp session, the SDK:
1. Calls `findByContact(contactId, 5)` to load the last 5 conversations
2. Merges all messages and keeps the most recent 20 user/assistant messages
3. Injects them into the server-side LLM via `setHistory()`

This happens in the background — no code needed. The `JsonFileHistory` built-in store implements `findByContact()`, so auto-restore works out of the box.

### Manual override

If you need custom restore logic (e.g., different message limits, conditional restore), handle it yourself in the event handler. The auto-restore fires in the background, but your manual `setHistory()` call will override it:

```typescript
agent.on("call.started", async (call) => {
  // Custom: only restore if the last call was within 24 hours
  const prior = await history.findByContact(call.from, 1);
  if (prior.length > 0 && Date.now() / 1000 - prior[0].endedAt < 86400) {
    await call.setHistory(prior[0].messages);
  }
});
```

## Channel support

| Channel | Auto-save? | Restore? | Contact ID | Notes |
|---|---|---|---|---|
| **Phone (Twilio)** | ✅ | ✅ `call.setHistory()` | `call.from` (E.164 number) | Saved on `call.ended` |
| **WebRTC** | ✅ | ✅ `call.setHistory()` | `call.metadata.userId` | Pass userId from browser |
| **Chat** | ✅ | ✅ `call.setHistory()` | `call.metadata.userId` | Same as WebRTC |
| **WhatsApp** | ✅ | ✅ `session.setHistory()` | `session.contactPhone` | Uses `WhatsAppSession` object |

### WebRTC / Chat: identifying contacts

Browser sessions don't have phone numbers, so pass a `userId` in metadata when creating the token:

```typescript
// Browser-side: pass userId when getting a token
const token = await fetch("/api/token", {
  body: JSON.stringify({ userId: "user-123" }),
});
```

Then in `call.started`:

```typescript
agent.on("call.started", async (call) => {
  const contactId = call.from !== "webrtc"
    ? call.from                          // Phone number
    : call.metadata?.userId              // WebRTC/Chat userId
      ? String(call.metadata.userId)
      : null;

  if (contactId) {
    const prior = await history.findByContact(contactId, 1);
    if (prior.length > 0) {
      await call.setHistory(prior[0].messages);
    }
  }
});
```

### WhatsApp: how it works

WhatsApp sessions are different from voice calls — they're **long-lived text conversations** managed server-side. But `HistoryStore` handles them the same way:

1. Contact sends a WhatsApp message → server creates a `WhatsAppSession`
2. Messages flow back and forth, all tracked in the server's LLM history
3. When the session ends (24h window expires or 2h idle), the server emits `whatsapp.sessionEnded` with the full conversation
4. The SDK's `HistoryStore` auto-saves it — same `ConversationRecord` as voice

**Session end triggers:**
- **24h window expiry** — Meta's service window closes (no inbound message for 24h)
- **Idle timeout** — no messages for 2 hours

The saved record has `channel: "whatsapp"` and includes `metadata.contactName` and `metadata.messageCount`.

```typescript
agent.on("whatsapp.sessionEnded", (event) => {
  console.log(`WhatsApp session ended: ${event.contactPhone} (${event.reason})`);
  // Already auto-saved by HistoryStore — no manual save needed
});
```

> WhatsApp uses `contact_phone` (e.g. `"5491155551234"`) as the `from` field. Use `findByContact()` with this number to restore prior conversations.

### WhatsApp: restoring conversations

`whatsapp.sessionStarted` passes a `WhatsAppSession` object with the same history methods as `Call`:

```typescript
agent.on("whatsapp.sessionStarted", async (session) => {
  const prior = await history.findByContact(session.contactPhone, 1);
  if (prior.length > 0) {
    await session.setHistory(prior[0].messages);
  }
});
```

`WhatsAppSession` methods:

| Method | Description |
|---|---|
| `session.setHistory(messages)` | Replace server-side LLM history |
| `session.addHistory(messages)` | Append messages to history |
| `session.getHistory()` | Read current LLM history |
| `session.clearHistory()` | Clear all history |
| `session.setPrompt(text)` | Replace the system prompt |
| `session.setPromptVars(vars)` | Set `{{variable}}` values |
| `session.addContext(text)` | Append context after prompt |

## Built-in: `JsonFileHistory`

The SDK ships with `JsonFileHistory` — a file-based store good for prototyping and small projects:

```typescript
import { JsonFileHistory } from "@pinecall/sdk";

const history = new JsonFileHistory("./data/calls.json");
```

It stores all conversations in a single JSON file, upserts by `callId`, and supports all `HistoryStore` methods:

| Method | Description |
|---|---|
| `save(record)` | Save/upsert a conversation |
| `findByContact(id, limit?)` | Find conversations by caller (searches `from` field) |
| `list(agentId, limit?)` | List conversations for an agent |
| `get(callId)` | Get a single conversation |
| `delete(callId)` | Delete a conversation |

## Custom stores

For production, implement the `HistoryStore` interface with your database of choice. Only `save()` is required — everything else is optional.

### Interface

```typescript
interface HistoryStore {
  // Required — called automatically on call.ended
  save(record: ConversationRecord): Promise<void>;

  // Optional — for restoring prior conversations
  findByContact?(contactId: string, limit?: number): Promise<ConversationRecord[]>;

  // Optional — for admin/dashboard features
  list?(agentId: string, limit?: number): Promise<ConversationRecord[]>;
  get?(callId: string): Promise<ConversationRecord | null>;
  delete?(callId: string): Promise<boolean>;
}
```

### MongoDB example

```typescript
import type { HistoryStore, ConversationRecord } from "@pinecall/sdk";
import { MongoClient } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URI!);
const db = client.db("myapp");
const conversations = db.collection<ConversationRecord>("conversations");

class MongoHistory implements HistoryStore {
  async save(record: ConversationRecord): Promise<void> {
    await conversations.updateOne(
      { callId: record.callId },
      { $set: record },
      { upsert: true },
    );
  }

  async findByContact(contactId: string, limit = 5): Promise<ConversationRecord[]> {
    return conversations
      .find({ from: contactId })
      .sort({ endedAt: -1 })
      .limit(limit)
      .toArray();
  }

  async list(agentId: string, limit = 50): Promise<ConversationRecord[]> {
    return conversations
      .find({ agentId })
      .sort({ endedAt: -1 })
      .limit(limit)
      .toArray();
  }

  async get(callId: string): Promise<ConversationRecord | null> {
    return conversations.findOne({ callId });
  }

  async delete(callId: string): Promise<boolean> {
    const result = await conversations.deleteOne({ callId });
    return result.deletedCount > 0;
  }
}

// Usage
const agent = pc.agent("my-agent", {
  history: new MongoHistory(),
});
```

### PostgreSQL example

```typescript
import type { HistoryStore, ConversationRecord } from "@pinecall/sdk";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

class PostgresHistory implements HistoryStore {
  async save(record: ConversationRecord): Promise<void> {
    await pool.query(
      `INSERT INTO conversations (call_id, agent_id, channel, direction, caller, callee,
        started_at, ended_at, duration, reason, transcript, messages, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (call_id) DO UPDATE SET
        transcript = $11, messages = $12, ended_at = $8, duration = $9`,
      [
        record.callId, record.agentId, record.channel, record.direction,
        record.from, record.to, record.startedAt, record.endedAt,
        record.duration, record.reason,
        JSON.stringify(record.transcript),
        JSON.stringify(record.messages),
        JSON.stringify(record.metadata),
      ],
    );
  }

  async findByContact(contactId: string, limit = 5): Promise<ConversationRecord[]> {
    const { rows } = await pool.query(
      `SELECT * FROM conversations WHERE caller = $1 ORDER BY ended_at DESC LIMIT $2`,
      [contactId, limit],
    );
    return rows.map(this.#fromRow);
  }

  #fromRow(row: any): ConversationRecord {
    return {
      callId: row.call_id,
      agentId: row.agent_id,
      channel: row.channel,
      direction: row.direction,
      from: row.caller,
      to: row.callee,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      duration: row.duration,
      reason: row.reason,
      transcript: row.transcript,
      messages: row.messages,
      metadata: row.metadata,
    };
  }
}
```

### REST API example

```typescript
import type { HistoryStore, ConversationRecord } from "@pinecall/sdk";

class APIHistory implements HistoryStore {
  constructor(private baseUrl: string, private token: string) {}

  async save(record: ConversationRecord): Promise<void> {
    await fetch(`${this.baseUrl}/conversations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.token}`,
      },
      body: JSON.stringify(record),
    });
  }

  async findByContact(contactId: string, limit = 5): Promise<ConversationRecord[]> {
    const res = await fetch(
      `${this.baseUrl}/conversations?from=${encodeURIComponent(contactId)}&limit=${limit}`,
      { headers: { Authorization: `Bearer ${this.token}` } },
    );
    return res.json();
  }
}
```

## History API (runtime)

Beyond auto-save/restore, you can manipulate the LLM history during an active call:

| Method | What it does |
|---|---|
| `call.setHistory(messages)` | **Replace** the entire LLM conversation history |
| `call.addHistory(messages)` | **Append** messages to the existing history |
| `call.getHistory()` | **Read** the current LLM history from the server |
| `call.clearHistory()` | **Clear** all LLM history |

These work during active voice calls (Twilio, WebRTC, Chat) and WhatsApp sessions (via `WhatsAppSession`). They modify the server-side LLM context in real-time.

## What's next

- [Tools and Functions](/guides/tools-and-functions) — let the agent take actions
- [WebRTC Browser](/guides/webrtc-browser) — build browser voice widgets
- [WhatsApp](/guides/whatsapp) — text-based messaging agents
- [`Call` API reference](/api/call) — full method reference

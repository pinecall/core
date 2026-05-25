---
title: "REST API"
description: "Static helpers for the Pinecall management API. No WebSocket needed."
---

# REST API

The SDK ships with static REST helpers for management tasks: list voices, list phone numbers, mint tokens, check Twilio balance. These don't require an active WebSocket — you can call them from any process with an API key.

```typescript
import {
  fetchVoices,
  fetchPhones,
  createToken,
  fetchTwilioBalance,
} from "@pinecall/sdk";
```

## `fetchVoices(opts?)`

List available TTS voices. Filter by provider and language.

```typescript
import { fetchVoices } from "@pinecall/sdk";

// All voices
const voices = await fetchVoices();

// Spanish Cartesia voices only
const es = await fetchVoices({ provider: "cartesia", language: "es" });

voices.forEach((v) => console.log(`${v.name} (${v.provider}:${v.id})`));
// → "Rachel (elevenlabs:21m00Tcm4TlvDq8ikWAM)"
```

**Returns:** `Voice[]` — each voice has `id`, `name`, `provider`, `gender`, `style`, `languages[]`, `previewUrl`.

| Option | Type | Description |
|---|---|---|
| `provider` | `string` | Filter by provider name |
| `language` | `string` | Filter by language (BCP-47) |
| `apiUrl` | `string` | Custom server URL |

## `fetchPhones(opts)`

List phone numbers on your Pinecall account.

```typescript
const phones = await fetchPhones({ apiKey: "pk_..." });
phones.forEach((p) => console.log(`${p.name} → ${p.number}`));
// → "(318) 633-0963 → +13186330963"
```

**Returns:** `Phone[]` — each phone has `number` (E.164), `name`, `sid`, `isSdk`.

| Option | Type | Required | Description |
|---|---|---|---|
| `apiKey` | `string` | ✅ | Your Pinecall API key |
| `apiUrl` | `string` | — | Custom server URL |

## `createToken(opts)`

Generate a short-lived, single-use token for browser WebRTC or chat connections. **Requires API key** — call from your backend, never the browser.

```typescript
import { createToken } from "@pinecall/sdk";

const token = await createToken({
  channel: "webrtc",
  agentId: "florencia",
  apiKey: process.env.PINECALL_API_KEY!,
});
```

Or via instance methods (preferred when you have a `Pinecall` or `Agent` instance):

```typescript
const token = await pc.createToken("webrtc", "florencia");
const token = await agent.createToken("webrtc");
```

**Returns:** `{ token: string, server: string, expiresIn: number }`.

| Option | Type | Required | Description |
|---|---|---|---|
| `channel` | `"webrtc" \| "chat"` | ✅ | Token type |
| `agentId` | `string` | ✅ | Agent slug |
| `apiKey` | `string` | ✅ | API key for authentication |
| `apiUrl` | `string` | — | Custom server URL |

See [Security](/docs/security) for the full token security model.

## `fetchTwilioBalance(opts?)`

Check your Twilio account balance.

```typescript
const balance = await fetchTwilioBalance({ apiKey: "pk_..." });
if (balance) console.log(`$${balance.balance} ${balance.currency}`);
```

**Returns:** `{ balance: string, currency: string } | null`.

| Option | Type | Required | Description |
|---|---|---|---|
| `apiKey` | `string` | ✅ | API key |
| `apiUrl` | `string` | — | Custom server URL |

## Custom server URL

All helpers accept an `apiUrl` option for self-hosted or staging servers:

```typescript
fetchVoices({ apiUrl: "http://localhost:1337" });
fetchPhones({ apiKey: "pk_...", apiUrl: "http://localhost:1337" });
```

## What's next

- [`Pinecall.createToken`](/docs/api/pinecall) — instance method form
- [Security](/docs/security) — token security model
- [TTS Providers](/docs/reference/tts-providers) — discovering voices

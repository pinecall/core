<h1 align="center">@pinecall/sdk</h1>

<p align="center">
  <strong>Build real-time voice & messaging AI agents in TypeScript.</strong><br/>
  WebSocket client for Pinecall Voice — ~80 KB, one dependency.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#api-reference">API</a> ·
  <a href="#whatsapp">WhatsApp</a> ·
  <a href="#events">Events</a> ·
  <a href="#hot-reload-live-configuration">Hot-Reload</a> ·
  <a href="#multi-environment">Environments</a> ·
  <a href="#rest-api">REST API</a> ·
  <a href="#configuration-reference">Config Reference</a>
</p>

---

## Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
  - [Server-side LLM](#server-side-llm-recommended)
  - [Deploy (one-liner)](#deploy-one-liner)
  - [Client-side LLM](#client-side-llm-bring-your-own)
- [API Reference](#api-reference)
  - [Pinecall (client)](#pinecall-client)
  - [Agent](#agent)
    - [Agent Methods](#agent-methods)
    - [agent.configure()](#agentconfigure--hot-reload)
    - [agent.dial()](#agentdial--outbound-calls)
  - [Call](#call)
  - [ReplyStream](#replystream)
- [Events](#events)
  - [Event Table](#agent-events)
  - [Transcript Flow](#real-time-transcript-flow)
- [Hot-Reload](#hot-reload-live-configuration)
  - [Configuration Scopes](#three-configuration-scopes)
  - [Prompt Template Variables](#prompt-template-variables)
  - [Mid-Call Context](#adding-context-mid-call)
  - [Switching Voice / Language](#switching-voice-or-language-mid-call)
- [Configuration Shortcuts](#configuration-shortcuts)
- [REST API](#rest-api)
  - [createToken](#createtokenopts)
  - [fetchVoices](#fetchvoicesopts)
  - [fetchPhones](#fetchphonesopts)
  - [fetchWebRTCToken](#fetchwebrtctokenopts) _(deprecated)_
  - [fetchTwilioBalance](#fetchtwiliobalanceopts)
- [SSE Streaming](#sse-streaming)
  - [Single Agent](#single-agent-stream)
  - [Multi-Agent](#multi-agent-stream)
  - [Filtering (Multi-Tenant)](#filtering--multi-tenant-example)
  - [Events](#streamed-events)
- [WhatsApp](#whatsapp)
  - [Setup](#whatsapp-setup)
  - [Usage](#whatsapp-usage)
  - [Events](#whatsapp-events)
  - [Voice Notes](#voice-notes)
  - [24h Service Window](#24h-service-window)
- [Configuration Reference](#configuration-reference)
  - [STT Providers](#stt-providers)
  - [TTS Providers](#tts-providers)
  - [LLM Providers](#llm-providers)
  - [Interruption](#interruption)
  - [Session Limits](#session-limits)
  - [Audio Metrics](#analysis--audio-metrics)
- [Multi-Environment](#multi-environment)
  - [How It Works](#how-it-works)
  - [Setup (.env.local)](#setup)
  - [Multi-Developer Isolation](#multi-developer-isolation)
  - [Phone Routing](#phone-routing)
    - [Multi-Developer Strategies](#multi-developer-strategies)
  - [WhatsApp Dev Routing](#whatsapp-dev-routing)
  - [WebRTC & Chat Dev Routing](#webrtc--chat-dev-routing)
  - [Staging](#staging)
  - [Environment Variables](#environment-variables-1)
  - [Vite Integration](#vite-integration)
  - [Deployment Topologies](#deployment-topologies)
    - [Observe vs Interact](#observe-vs-interact)
    - [Embedded Agent (same process)](#embedded-agent-same-process)
    - [Standalone Agent (separate process)](#standalone-agent-separate-process)
    - [Headless Agent (no web server)](#headless-agent-no-web-server)
    - [Comparison](#comparison)
- [Philosophy](#philosophy)
- [Security](#security)
  - [Token Security Model](#token-security-model)
  - [Why Tokens Are Safe](#why-tokens-are-safe)
  - [allowedOrigins (convenience mode)](#allowedorigins-convenience-mode)


---

## Install

```bash
npm install @pinecall/sdk
```

> **Node.js ≥ 18** required. Only runtime dependency: `ws`.

---

## Quick Start

### Server-side LLM (recommended)

The Pinecall server runs the LLM and handles STT/TTS. You configure the agent and handle tool calls locally.

```typescript
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });
await pc.connect();

const agent = pc.agent("receptionist", {
  voice: "elevenlabs:h2cd3gvcqTp3m65Dysk7",
  language: "es",
  stt: "deepgram-flux",
  llm: {
    provider: "openai",
    model: "gpt-4.1-mini",
    enabled: true,
    prompt: "You are a helpful receptionist. Be concise.",
  },
  tools: [
    {
      type: "function",
      function: {
        name: "lookupOrder",
        description: "Look up an order by ID",
        parameters: {
          type: "object",
          properties: {
            orderId: { type: "string", description: "The order ID" },
          },
          required: ["orderId"],
        },
      },
    },
  ],
});

agent.addChannel("phone", "+18045551234");
agent.addChannel("phone", "sip:receptionist@trunk.twilio.com");
agent.addChannel("webrtc");

// Per-channel overrides: different voice/language per number
agent.addChannel("phone", "+34911234567", {
  voice: "elevenlabs:spanishVoiceId",
  language: "es",
  stt: "deepgram-flux",
});

// Greet on call start
agent.on("call.started", (call) => {
  if (call.direction === "inbound") {
    call.say("Hello! How can I help you today?");
  }
});

// Handle tool calls from the server-side LLM
agent.on("llm.tool_call", async (data, call) => {
  const results = [];
  for (const tc of data.toolCalls) {
    const args = JSON.parse(tc.arguments);
    const result = await myToolHandler(tc.name, args);
    results.push({ toolCallId: tc.id, result });
  }
  call.toolResult(data.msgId, results);
});

agent.on("call.ended", (call, reason) => {
  console.log(`Call ended: ${reason} (${call.duration}s)`);
});
```

### Client-side LLM (bring your own)

You run the LLM yourself. The server handles STT → text and text → TTS.

```typescript
import { Pinecall } from "@pinecall/sdk";
import OpenAI from "openai";

const pc = new Pinecall({ apiKey: "pk_..." });
await pc.connect();
const openai = new OpenAI();

const agent = pc.agent("my-bot", { voice: "cartesia:abc", language: "en" });
agent.addChannel("phone", "+13186330963");

agent.on("call.started", (call) => call.say("Hi there!"));

agent.on("turn.end", async (turn, call) => {
  const stream = call.replyStream(turn);

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: "You are helpful. Be concise." },
      { role: "user", content: turn.text },
    ],
    stream: true,
  });

  for await (const chunk of completion) {
    if (stream.aborted) break;
    const token = chunk.choices[0]?.delta?.content;
    if (token) stream.write(token);
  }
  stream.end();
});
```

### Deploy (one-liner)

The fastest way to get an agent running. `pc.deploy()` combines agent creation, LLM config, and channel registration in a single call:

```typescript
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });
await pc.connect();

const mara = pc.deploy("mara", {
  prompt: "You are Mara, a friendly voice assistant. Be concise.",
  model: "gpt-4.1-mini",
  voice: "elevenlabs:EXAVITQu4vr4xnSDxMaL",
  language: "es",
  channels: ["webrtc", "+13186330963"],
});

mara.on("call.started", (call) => {
  console.log(`📞 Call from ${call.from}`);
});

mara.on("call.ended", (call, reason) => {
  console.log(`Call ended: ${reason} (${call.duration}s)`);
});
```

**DeployConfig fields:**

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | `string` | System prompt for the LLM |
| `model` | `string` | LLM model (default: `gpt-4.1-mini`) |
| `voice` | `string` | TTS voice shortcut (e.g. `elevenlabs:voiceId`) |
| `language` | `string` | BCP-47 language code |
| `stt` | `string` | STT provider (default: `deepgram-flux`) |
| `tools` | `array` | OpenAI function-calling tool definitions |
| `channels` | `string[]` | Channels to register: `"webrtc"`, `"chat"`, or phone numbers |
| `sessionLimits` | `object` | Session timeout config (see [Session Limits](#session-limits)) |
| `allowedOrigins` | `string[]` | Allowed origins for public browser token access (see [Security](#allowedorigins-convenience-mode)) |

`deploy()` returns an `Agent` — you can attach event handlers, add more channels, or hot-reload config.

> **Greeting:** Use `call.say()` in `call.started` to speak a greeting:
> ```typescript
> mara.on("call.started", (call) => call.say("¡Hola! ¿En qué puedo ayudarte?"));
> ```

---

## API Reference

### Pinecall (client)

WebSocket client. Manages auth, reconnection, and agent multiplexing.

```typescript
const pc = new Pinecall({
  apiKey: "pk_...",                        // required
  url: "wss://voice.pinecall.io/client",  // default
  reconnect: true,                         // auto-reconnect (default: true)
  pingInterval: 30000,                     // keepalive ms (default: 30000)
});

await pc.connect();                // resolves on auth success
await pc.disconnect();             // graceful close

pc.on("connected", () => {});
pc.on("disconnected", (reason) => {});
pc.on("reconnecting", (attempt) => {});
pc.on("error", (err) => {});
```

### Agent

Created via `pc.agent(id, config?)` or `pc.deploy(id, config)`. Owns channels, routes call events, and stores defaults.

#### Creation

```typescript
const agent = pc.agent("my-agent", {
  voice: "elevenlabs:abc",
  language: "es",
  stt: "deepgram-flux",
  llm: {
    provider: "openai",
    model: "gpt-4.1-mini",
    enabled: true,
    prompt: "System prompt with {{template_vars}}.",
  },
  tools: [/* OpenAI function-calling format */],
});
```

#### Channels

```typescript
agent.addChannel("phone", "+18045551234");
agent.addChannel("phone", "sip:bot@trunk.twilio.com");
agent.addChannel("webrtc");

// Per-channel config overrides
agent.addChannel("phone", "+34911234567", {
  voice: "elevenlabs:spanishVoiceId",
  language: "es",
});

// WhatsApp channel (see WhatsApp section for full setup)
agent.addChannel("whatsapp", {
  phoneNumberId: "123456789012345",
  accessToken: "EAABx...",
  verifyToken: "my-secret",
  appSecret: "abc123...",
});

// Update a channel's config at runtime
agent.configureChannel("+34911234567", { voice: "cartesia:newVoice" });

// Remove a channel
agent.removeChannel("+34911234567");
```

#### Agent Methods

| Method | Description |
|--------|-------------|
| `agent.addChannel(type, ref?, config?)` | Register a phone, webrtc, mic, chat, or whatsapp channel |
| `agent.removeChannel(ref)` | Unregister a channel |
| `agent.configure(opts)` | Hot-reload agent defaults (voice, language, STT, LLM) — affects all future calls |
| `agent.configureChannel(ref, config)` | Update a specific channel's config |
| `agent.configureSession(callId, opts)` | Update config for a live call (equivalent to `call.configure`) |
| `agent.dial(opts)` | Make an outbound call — returns `Promise<Call>` |
| `agent.call(callId)` | Get a `Call` object by ID (`undefined` if not found) |
| `agent.getConfig()` | Returns the current `AgentConfig` |
| `agent.stream()` | SSE stream of this agent's events (see [SSE](#sse-streaming)) |
| `agent.setDevCallers(numbers)` | Set dev caller whitelist for multi-env routing |
| `agent.send(data)` | Escape hatch — send a raw protocol message |

#### `agent.configure()` — Hot-Reload

Update the agent's defaults at runtime. Changes take effect on **all future calls** — existing calls are not affected. Sends an `agent.configure` command over the WebSocket.

```typescript
// Switch to French voice
agent.configure({ voice: "elevenlabs:frenchVoiceId", language: "fr" });

// Update LLM model
agent.configure({
  llm: { provider: "openai", model: "gpt-4.1", enabled: true,
         prompt: "Updated prompt." },
});

// Swap STT provider
agent.configure({ stt: "gladia" });
```

> **No REST call needed.** `agent.configure()` uses the existing WebSocket — changes propagate instantly to the server.

#### `agent.dial()` — Outbound Calls

```typescript
const call = await agent.dial({
  to: "+14155551234",
  from: "+13186330963",
  greeting: "Hi! This is a follow-up call.",  // server speaks via TTS
  metadata: { appointmentId: "appt_001" },
  config: { voice: "cartesia:uuid", language: "ar" }, // per-call override
});

call.on("call.ended", (_, reason) => console.log(`Done: ${reason}`));
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | `string` | ✅ | Destination number (E.164) |
| `from` | `string` | ✅ | Caller ID (must be a registered number) |
| `greeting` | `string` | — | Text the server speaks when callee picks up |
| `metadata` | `object` | — | Custom data attached to the call |
| `config` | `object` | — | Per-call config override (voice, STT, language) |

### Pinecall (client) — Additional Methods

```typescript
// Agent management
const agent = pc.getAgent("mara");       // get by ID (undefined if not found)
const removed = pc.removeAgent("mara");  // unregister agent (returns boolean)

// Token generation (for browser WebRTC/Chat connections)
const token = await pc.createToken("webrtc", "mara");
const token = await agent.createToken("chat");

// REST helpers (no WebSocket needed)
const voices = await pc.fetchVoices({ provider: "elevenlabs" });
const phones = await pc.fetchPhones();
```

### Call

Per-session handle. Created automatically on `call.started`.

#### Speech

| Method | Description |
|--------|-------------|
| `call.say(text)` | Speak text immediately (standalone, no `in_reply_to`) |
| `call.reply(text)` | Reply to the latest user message (auto-tracks `in_reply_to`) |
| `call.replyStream(turn?)` | Open a token stream → returns [`ReplyStream`](#replystream) |
| `call.toolResult(msgId, results)` | Respond to a server-side LLM tool call |
| `call.cancel(msgId?)` | Cancel a specific or the current message |
| `call.clear()` | Flush all queued TTS audio |

**Greeting pattern:** Use `call.say()` on `call.started` for inbound greetings. For outbound calls, pass `greeting` in `agent.dial()` — the server speaks it via TTS automatically.

```typescript
// Inbound — SDK speaks the greeting
agent.on("call.started", (call) => {
  if (call.direction === "inbound") {
    call.say("Hello! How can I help you today?");
  }
});

// Outbound — server speaks the greeting
const call = await agent.dial({
  to: "+14155551234",
  from: "+13186330963",
  greeting: "Hi! This is a follow-up call.",
});
```

#### Call Control

| Method | Description |
|--------|-------------|
| `call.hangup()` | End the call |
| `call.forward(to, opts?)` | Transfer to another number |
| `call.sendDTMF(digits)` | Send DTMF tones (e.g. `"1234#"`) |
| `call.hold()` | Put on hold (plays hold music, mutes mic) |
| `call.unhold()` | Resume from hold |
| `call.mute()` | Mute mic (transcripts buffered) |
| `call.unmute()` | Unmute (emits `call.unmuted` with buffered transcript) |

#### Mid-Call Configuration

| Method | Description |
|--------|-------------|
| `call.configure(opts)` | Change voice, STT, language — takes effect immediately |
| `call.setPrompt(text)` | Replace the system prompt for this call |
| `call.setPromptVars(vars)` | Set `{{variable}}` values in the prompt template |
| `call.addContext(text)` | Append extra context after the system prompt |
| `call.setPromptFile(path)` | Load a prompt file and set it |

#### Conversation History

| Method | Description |
|--------|-------------|
| `call.getHistory()` | Fetch conversation messages (OpenAI format) |
| `call.addHistory(msgs)` | Inject messages into history (e.g. CRM context) |
| `call.setHistory(msgs)` | Replace entire conversation history |
| `call.clearHistory()` | Clear history (system prompt preserved) |

#### Properties

```typescript
call.id          // "CA7ec979f5..." — unique call ID
call.from        // "+13186330963" or "sip:..."
call.to          // destination number/URI
call.direction   // "inbound" | "outbound"
call.transport   // "phone" | "webrtc" | "unknown"
call.metadata    // custom metadata from the channel
call.transcript  // [{ role: "user", content: "..." }, ...] — user + assistant only
call.messages    // full LLM history (populated on call.ended)
call.duration    // seconds (populated on call.ended)
call.startedAt   // epoch seconds
call.endedAt     // epoch seconds
call.reason      // "hangup" | "timeout" | ...
```

### ReplyStream

Token-by-token streaming for LLM responses. TTS starts as soon as a sentence boundary is detected.

```typescript
const stream = call.replyStream(turn);

for await (const token of llm.stream(prompt)) {
  if (stream.aborted) break;   // user interrupted
  stream.write(token);
}
stream.end();
```

---

## Events

### Agent Events

Subscribe via `agent.on(event, handler)`. All call-scoped events include `call` as the last argument.

| Event | Signature | When |
|-------|-----------|------|
| **Lifecycle** | | |
| `call.started` | `(call)` | New call connected |
| `call.ended` | `(call, reason)` | Call disconnected |
| **User speech** | | |
| `speech.started` | `(event, call)` | User began speaking (VAD) |
| `speech.ended` | `(event, call)` | User stopped speaking (VAD) |
| `user.speaking` | `(event, call)` | Interim STT transcript (updates live) |
| `user.message` | `(event, call)` | Final confirmed user text |
| **Turns** | | |
| `eager.turn` | `(turn, call)` | Early turn signal (low-latency response) |
| `turn.end` | `(turn, call)` | Final turn signal |
| `turn.continued` | `(event, call)` | User kept talking (auto-aborts active streams) |
| **Bot speech** | | |
| `bot.speaking` | `(event, call)` | Bot started speaking a message |
| `bot.word` | `(event, call)` | Individual word as TTS plays it |
| `bot.finished` | `(event, call)` | Bot finished speaking a message |
| `bot.interrupted` | `(event, call)` | Bot was cut off by user |
| **Protocol** | | |
| `message.confirmed` | `(event, call)` | Server acknowledged bot message |
| `llm.tool_call` | `(data, call)` | Server-side LLM requests a tool call |
| `session.idle_warning` | `(event, call)` | Idle warning — user hasn't spoken, call will timeout soon |
| `session.timeout` | `(event, call)` | Session timeout warning (max duration / idle) |
| **WhatsApp** | | |
| `whatsapp.session_started` | `(event)` | New WhatsApp conversation started |
| `whatsapp.message` | `(event)` | Incoming WhatsApp message received |
| `whatsapp.response` | `(event)` | Agent sent a WhatsApp response |
| `whatsapp.status` | `(event)` | Message delivery status (sent/delivered/read) |

### Real-Time Transcript Flow

```
User speaks    →  speech.started
               →  user.speaking  (interim, fires multiple times)
               →  speech.ended
               →  user.message   (final confirmed text)
               →  eager.turn / turn.end

Bot responds   →  bot.speaking   (message ID assigned)
               →  bot.word       (word-by-word as TTS plays)
               →  bot.finished   (done speaking)

Interruption   →  bot.interrupted
               →  turn.continued (active ReplyStreams auto-aborted)
```

### `bot.word` Event

Build live transcripts word-by-word:

```typescript
let currentMessage = "";
agent.on("bot.speaking", () => { currentMessage = ""; });
agent.on("bot.word", (event) => {
  currentMessage += event.word + " ";
  process.stdout.write(`\r🤖 ${currentMessage}`);
});
agent.on("bot.finished", () => console.log());
```

---

## Hot-Reload: Live Configuration

Everything is hot-reloadable. Voice, language, STT, prompt, tools — all can change **during an active call**. The server applies changes on the next LLM turn.

### Three Configuration Scopes

| Scope | Method | Affects |
|-------|--------|---------|
| **Agent defaults** | `pc.agent("id", config)` | All future calls |
| **Agent hot-reload** | `agent.configure(updates)` | Updates defaults, future calls |
| **Session (mid-call)** | `call.configure(opts)` | This call only |
| **Prompt (mid-call)** | `call.setPrompt(text)` | This call's system prompt |
| **Template vars** | `call.setPromptVars(vars)` | This call's `{{var}}` values |
| **Context** | `call.addContext(text)` | Appended after prompt |

### Prompt Template Variables

Define a prompt with `{{placeholders}}`. The server resolves them before each LLM request. Built-in variables: `{{date}}`, `{{time}}`.

```typescript
const agent = pc.agent("support", {
  llm: {
    provider: "openai",
    model: "gpt-4.1-mini",
    enabled: true,
    prompt: `You are {{agent_name}}, support agent at {{company}}.
Today is {{date}}, {{time}}.
Customer: {{customer_name}} ({{tier}} tier).`,
  },
});

agent.on("call.started", async (call) => {
  const customer = await lookupCaller(call.from);
  await call.setPromptVars({
    agent_name: "Nova",
    company: "Acme Corp",
    customer_name: customer.name,
    tier: customer.tier,
  });
  call.say(`Hi ${customer.name}! How can I help?`);
});
```

### Adding Context Mid-Call

Append dynamic context without replacing the prompt:

```typescript
agent.on("call.started", async (call) => {
  const orders = await getRecentOrders(call.from);
  await call.addContext(
    `Recent orders:\n${orders.map(o => `- ${o.id}: ${o.status}`).join("\n")}`
  );
});
```

### Switching Voice or Language Mid-Call

```typescript
// User asks for Spanish
call.configure({ voice: "elevenlabs:spanishVoiceId", language: "es" });
call.reply("¡Claro! Ahora hablo en español.");
```

---

## Configuration Shortcuts

Voice and STT accept string shortcuts or full config objects:

```typescript
// Shortcuts
{ voice: "elevenlabs:voiceId" }
{ stt: "deepgram-flux" }
{ stt: "deepgram:nova-3:fr" }         // provider:model:language

// Full config objects
{
  voice: { provider: "cartesia", voice_id: "abc", speed: 1.1 },
  stt: { provider: "deepgram", model: "nova-3", language: "fr" },
}
```

> **Note:** Turn detection and VAD are auto-derived from the STT provider. `deepgram-flux` → native turn detection + native VAD. All others → smart_turn + silero VAD.

---

## REST API

Static helpers for the Pinecall management API. No WebSocket connection needed.

### `fetchVoices(opts?)`

List available TTS voices. Filter by provider and language.

```typescript
import { fetchVoices } from "@pinecall/sdk";

// All ElevenLabs voices
const voices = await fetchVoices();

// Spanish Cartesia voices only
const esVoices = await fetchVoices({ provider: "cartesia", language: "es" });

voices.forEach(v => console.log(`${v.name} (${v.provider}:${v.id})`));
// → "Rachel (elevenlabs:21m00Tcm4TlvDq8ikWAM)"
```

**Returns:** `Voice[]` — each voice has `id`, `name`, `provider`, `gender`, `style`, `languages[]`, `previewUrl`.

### `fetchPhones(opts)`

List phone numbers on your Pinecall account.

```typescript
import { fetchPhones } from "@pinecall/sdk";

const phones = await fetchPhones({ apiKey: "pk_..." });
phones.forEach(p => console.log(`${p.name} → ${p.number}`));
// → "(318) 633-0963 → +13186330963"
```

**Returns:** `Phone[]` — each phone has `number` (E.164), `name`, `sid`, `isSdk`.

### `createToken(opts)`

Generate a short-lived, single-use token for browser WebRTC or Chat connections. **Requires API key** — call this from your backend.

```typescript
import { createToken } from "@pinecall/sdk";

// From your backend endpoint (API key stays server-side)
const token = await createToken({
  channel: "webrtc",      // "webrtc" or "chat"
  agentId: "florencia",
  apiKey: process.env.PINECALL_API_KEY!,
});

// Or via instance methods:
const token = await pc.createToken("webrtc", "florencia");
const token = await agent.createToken("webrtc");
```

**Returns:** `{ token: string, server: string, expiresIn: number }`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channel` | `"webrtc"` \| `"chat"` | ✅ | Token type |
| `agentId` | `string` | ✅ | Agent slug (wire ID) |
| `apiKey` | `string` | ✅ | API key for authentication |
| `apiUrl` | `string` | — | Custom server URL |

> See [Security](#security) for the full token security model.

### `fetchWebRTCToken(opts)` _(deprecated)_

> **⚠️ Deprecated.** Use [`createToken()`](#createtokenopts) instead. `fetchWebRTCToken` only works when the agent has `allowedOrigins` configured.

Legacy helper — fetches a token from the public endpoint (requires `allowedOrigins` on the agent).

```typescript
import { fetchWebRTCToken } from "@pinecall/sdk";

const { token, server } = await fetchWebRTCToken({
  agentId: "my-agent",
  apiKey: "pk_...",  // optional: authenticates the request
});
```

**Returns:** `{ token: string, server?: string }`.

### `fetchTwilioBalance(opts?)`

Check your Twilio account balance.

```typescript
import { fetchTwilioBalance } from "@pinecall/sdk";

const balance = await fetchTwilioBalance({ apiKey: "pk_..." });
if (balance) console.log(`$${balance.balance} ${balance.currency}`);
```

**Returns:** `{ balance: string, currency: string } | null`.

### Options

All REST helpers accept an `apiUrl` option to point to a custom server:

```typescript
fetchVoices({ apiUrl: "http://localhost:1337" });
fetchPhones({ apiKey: "pk_...", apiUrl: "http://localhost:1337" });
```

---

## SSE Streaming

Stream real-time agent events over HTTP using [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events). Works with any framework — returns a Web API `Response` or writes to a Node.js `ServerResponse`.

> **WebRTC vs SSE:** If your frontend uses `@pinecall/voice-widget` or `@pinecall/voice-core`, events already arrive through the **WebRTC DataChannel** — you don't need SSE. SSE is for **server-side dashboards, monitoring UIs, or backends** that need to observe calls without being in the WebRTC session.

### Single Agent Stream

```typescript
// Web API (Remix, Next.js, Hono, Bun)
app.get("/events", () => agent.stream());

// Express / Node.js
app.get("/events", (req, res) => agent.stream(res));
```

### Multi-Agent Stream

Stream events from all agents via `pc.stream()`, or filter to specific ones:

```typescript
// All agents
app.get("/events", () => pc.stream());

// Filtered to specific agents
app.get("/events", () => pc.stream({ agents: ["mara", "julia"] }));

// Express
app.get("/events", (req, res) => pc.stream(res));
app.get("/events", (req, res) => pc.stream(res, { agents: ["mara"] }));
```

### Filtering — Multi-Tenant Example

The `agents` filter lets you build **per-user dashboards** where each user only sees their own agents:

```typescript
// Each user owns specific agents
const userAgents = {
  "user_1": ["mara", "julia"],
  "user_2": ["nova", "receptionist"],
};

// User-scoped SSE endpoint
app.get("/api/events", (req, res) => {
  const userId = req.auth.userId;              // from your auth middleware
  const allowed = userAgents[userId] || [];

  // Only streams events from agents this user owns
  pc.stream(res, { agents: allowed });
});
```

The filter works by subscribing only to the specified agents' event emitters — events from other agents never reach the stream. This is purely **server-side filtering**, so there's no data leakage.

```
Browser A (user_1)                Browser B (user_2)
    │                                  │
    └── EventSource("/api/events") ──► SSE: mara, julia events only
                                       │
                                       └── EventSource("/api/events") ──► SSE: nova, receptionist only
```

### Streamed Events

Each SSE message has an `event:` field and a JSON `data:` body with `agent` ID:

| Event | Data Fields | When |
|-------|------------|------|
| `connected` | `agent` or `agents` | Stream established |
| `call.started` | `callId`, `from`, `to`, `direction`, `transport` | Call begins |
| `call.ended` | `callId`, `reason`, `duration` | Call ends |
| `user.speaking` | `callId`, `text` | Interim STT transcript |
| `user.message` | `callId`, `text`, `messageId` | Final user text |
| `turn.end` | `callId`, `text`, `probability` | User turn ended |
| `turn.pause` | `callId`, `probability` | Turn pause detected |
| `speech.started` | `callId` | User began speaking |
| `speech.ended` | `callId` | User stopped speaking |
| `bot.speaking` | `callId`, `messageId`, `text` | Bot started speaking |
| `bot.word` | `callId`, `messageId`, `word` | Word-by-word playback |
| `bot.finished` | `callId`, `messageId` | Bot done speaking |
| `bot.interrupted` | `callId`, `messageId` | Bot cut off by user |

**Wire format:**
```
event: user.message
data: {"callId":"CA123","text":"Hello","messageId":"msg_abc","agent":"mara"}

event: bot.speaking
data: {"callId":"CA123","messageId":"msg_def","text":"Hi!","agent":"mara"}
```

A `:ping` comment is sent every 30s as keepalive.

### Client Example

```javascript
const source = new EventSource("/api/events");

source.addEventListener("call.started", (e) => {
  const { agent, from, transport } = JSON.parse(e.data);
  console.log(`📞 [${agent}] Call from ${from} via ${transport}`);
});

source.addEventListener("user.message", (e) => {
  const { agent, text } = JSON.parse(e.data);
  console.log(`[${agent}] User: ${text}`);
});

source.addEventListener("bot.speaking", (e) => {
  const { agent, text } = JSON.parse(e.data);
  console.log(`[${agent}] Bot: ${text}`);
});
```

---

## WhatsApp

WhatsApp is a text-based channel — no STT/TTS/VAD pipeline. Messages route directly to the server-side LLM. The agent receives text, generates a response, and sends it back as a WhatsApp message.

> **Requires server-side LLM.** WhatsApp channels use the same `llm` config as voice channels. Client-side LLM (bring your own) is not supported for WhatsApp.

### WhatsApp Setup

1. **Create a Meta Business App** at [developers.facebook.com](https://developers.facebook.com)
2. **Add the WhatsApp product** to your app
3. **Get your credentials** from the API Setup page:
   - **Phone Number ID** — numeric string (e.g. `123456789012345`)
   - **Permanent Access Token** — generate a system user token with `whatsapp_business_messaging` permission
   - **App Secret** — from App Settings → Basic (for webhook signature verification)
4. **Configure the webhook URL** in your Meta app:
   ```
   https://voice.pinecall.io/whatsapp/webhook
   ```
   Verification token: set to match your `verifyToken` (default: `pinecall-wa-verify`)
5. **Subscribe to messages** — check `messages` in the webhook fields

### WhatsApp Usage

```typescript
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });
await pc.connect();

const agent = pc.agent("support", {
  language: "en",
  llm: {
    provider: "openai",
    model: "gpt-4.1-mini",
    enabled: true,
    prompt: "You are a helpful support agent on WhatsApp. Be concise.",
  },
  tools: [
    {
      type: "function",
      function: {
        name: "lookupOrder",
        description: "Look up an order by ID",
        parameters: {
          type: "object",
          properties: { orderId: { type: "string" } },
          required: ["orderId"],
        },
      },
    },
  ],
});

// Register WhatsApp channel
agent.addChannel("whatsapp", {
  phoneNumberId: "123456789012345",      // From Meta API Setup
  accessToken: process.env.WA_TOKEN!,    // Permanent Graph API token
  verifyToken: "my-verify-token",        // Must match Meta webhook config
  appSecret: process.env.WA_APP_SECRET!, // HMAC verification (recommended)
});

// Also register voice channels on the same agent
agent.addChannel("phone", "+13186330963");
agent.addChannel("webrtc");

// Voice greeting (WhatsApp doesn't use this)
agent.on("call.started", (call) => call.say("Hello!"));

// WhatsApp events
agent.on("whatsapp.session_started", (event) => {
  console.log(`💬 New WhatsApp chat: ${event.contactName} (${event.contactPhone})`);
});

agent.on("whatsapp.message", (event) => {
  console.log(`📩 ${event.name}: ${event.text}`);
});

agent.on("whatsapp.status", (event) => {
  console.log(`✓ ${event.status} → ${event.recipient}`);
});

// Handle tool calls (works for both voice AND WhatsApp)
agent.on("llm.tool_call", async (data, call) => {
  const results = [];
  for (const tc of data.toolCalls) {
    const args = JSON.parse(tc.arguments);
    const result = await myToolHandler(tc.name, args);
    results.push({ toolCallId: tc.id, result });
  }
  call.toolResult(data.msgId, results);
});
```

> **Multi-channel agent:** The same agent can handle voice calls AND WhatsApp messages simultaneously. The LLM config, tools, and prompt are shared — only the transport differs.

### WhatsApp Events

| Event | Data Fields | When |
|-------|------------|------|
| `whatsapp.session_started` | `sessionId`, `contactPhone`, `contactName` | First message from a new contact |
| `whatsapp.message` | `sessionId`, `from`, `name`, `type`, `text`, `messageId` | Incoming message received |
| `whatsapp.response` | `sessionId`, `to`, `text` | Agent sent a response |
| `whatsapp.status` | `status`, `recipient`, `messageId` | Delivery status update |

**Status values:** `sent` → `delivered` → `read`

### `WhatsAppChannelConfig`

```typescript
import type { WhatsAppChannelConfig } from "@pinecall/sdk";
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `phoneNumberId` | `string` | ✅ | Meta Phone Number ID from API Setup |
| `accessToken` | `string` | ✅ | Permanent Graph API access token |
| `verifyToken` | `string` | — | Webhook verification token (default: `pinecall-wa-verify`) |
| `appSecret` | `string` | — | Meta App Secret for HMAC signature verification |

### Voice Notes

When a user sends a voice note on WhatsApp, the server automatically:

1. Downloads the audio (OGG/Opus format) via the Cloud API
2. Transcribes it using Deepgram Nova-3
3. Feeds the transcript to the LLM as text

The agent sees voice notes as regular text messages — no special handling needed.

> **Requires `DEEPGRAM_API_KEY`** environment variable on the voice server.

### 24h Service Window

Meta enforces a **24-hour service window** for free-form messaging:

- **Inside window:** The agent can send any text message. Window refreshes on each inbound message.
- **Outside window:** Only pre-approved **template messages** can be sent.

The SDK tracks this automatically. If the window is closed, the server logs a warning. Template message support is planned for a future release.

### Environment Variables

Set these on the voice server (`sdk-server`):

| Variable | Required | Description |
|----------|----------|-------------|
| `WHATSAPP_VERIFY_TOKEN` | No | Hub verification token (default: `pinecall-wa-verify`) |
| `WHATSAPP_APP_SECRET` | No | Meta App Secret for webhook HMAC verification |
| `DEEPGRAM_API_KEY` | For voice notes | Required if you want audio message transcription |

---

## Configuration Reference

> **Naming convention:** Top-level SDK fields use **camelCase** (`sessionLimits`, `toolCalls`, `msgId`).
> Configuration objects that pass through to providers or to the server pipeline keep **snake_case** to mirror what the receiving side expects — `idle_timeout_seconds`, `similarity_boost`, `max_tokens`, `energy_threshold_db`, etc.
> This avoids an unnecessary translation layer and lets you copy-paste values from provider docs or server config directly.

### STT Providers

#### Deepgram Flux (recommended)

Best for real-time voice agents. Turn detection and VAD are **auto-derived** — no configuration needed.

```typescript
stt: {
  provider: "deepgram-flux",
  keyterms: ["pinecall"],      // boost recognition for specific terms
  eot_threshold: 0.5,          // end-of-turn sensitivity (0-1)
  eager_eot_threshold: 0.7,    // eager turn threshold
  eot_timeout_ms: 2000,
}

// Shortcut: "deepgram-flux"
```

> **Auto-derived:** Flux → native turn detection + native VAD. No need to specify `turnDetection`.

#### Deepgram Nova

Classic STT — turn detection and VAD auto-derived (smart_turn + silero).

```typescript
stt: {
  provider: "deepgram",
  model: "nova-3",
  language: "en",
  interim_results: true,
  smart_format: true,
  punctuate: true,
  profanity_filter: false,
  endpointing_ms: 300,
  utterance_end_ms: 1000,
  keywords: ["pinecall"],
}

// Shortcut: "deepgram" or "deepgram:nova-3" or "deepgram:nova-3:es"
```

#### Gladia

```typescript
stt: {
  provider: "gladia",
  model: "accurate",
  language: "en",
  endpointing: 300,
  speech_threshold: 0.8,
  code_switching: false,
  audio_enhancer: true,
}

// Shortcut: "gladia"
```

#### AWS Transcribe

```typescript
stt: { provider: "transcribe", language: "en-US" }

// Shortcut: "transcribe"
```

---

### TTS Providers

#### ElevenLabs

```typescript
voice: {
  provider: "elevenlabs",
  voice_id: "JBFqnCBsd6RMkjVDRZzb",
  model: "eleven_flash_v2_5",
  speed: 1.0,
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
}

// Shortcut: "elevenlabs:JBFqnCBsd6RMkjVDRZzb"
```

#### Cartesia

```typescript
voice: {
  provider: "cartesia",
  voice_id: "a0e99841-438c-4a64-b679-ae501e7d6091",
  model: "sonic",
  speed: 1.0,
  volume: 1.0,
  emotion: null,
  language: "en",
}

// Shortcut: "cartesia:a0e99841-438c-4a64-b679-ae501e7d6091"
```

#### AWS Polly

```typescript
voice: {
  provider: "polly",
  voice_id: "Joanna",
  engine: "neural",
  language: "en-US",
}

// Shortcut: "polly:Joanna"
```

---

### LLM Providers

#### OpenAI

```typescript
llm: {
  provider: "openai",
  model: "gpt-4.1-mini",     // or "gpt-4.1", "gpt-4.1-nano"
  enabled: true,
  prompt: "System prompt here.",
  temperature: 0.7,
  max_tokens: 1024,
}
```

#### Mistral

```typescript
llm: {
  provider: "mistral",
  model: "mistral-medium",
  enabled: true,
  prompt: "System prompt here.",
}
```

> **LLM shortcut:** `llm: "openai:gpt-4.1-mini"` expands to `{ provider: "openai", model: "gpt-4.1-mini", enabled: true }`.

---

### Session Limits

Calls have built-in safety limits to prevent runaway sessions. The server enforces these defaults:

| Setting | Default | Description |
|---------|---------|-------------|
| `max_duration_seconds` | `600` (10 min) | Hard cap on total call length. Call is terminated after this time regardless of activity. |
| `idle_timeout_seconds` | `60` | Auto-hangup after this many seconds of no user speech. |
| `idle_warning_seconds` | `15` | Emit `session.idle_warning` event this many seconds **before** idle timeout. Use it to prompt the user or change the UI. `0` = no warning. |
| `idle_grace_seconds` | `10` | After idle timeout fires, the agent gets this many seconds to prompt the user before force-hangup. |

**Override per-agent:**

```typescript
const agent = pc.agent("receptionist", {
  voice: "elevenlabs:abc",
  stt: "deepgram-flux",
  llm: { provider: "openai", model: "gpt-4.1-mini", enabled: true, prompt: "..." },
  sessionLimits: {
    max_duration_seconds: 1800,  // 30 minutes
    idle_timeout_seconds: 120,   // 2 minutes of silence
    idle_warning_seconds: 30,    // warn 30s before timeout
    idle_grace_seconds: 15,
  },
});
```

**Disable limits (not recommended):**

```typescript
sessionLimits: {
  max_duration_seconds: 0,  // 0 = unlimited
  idle_timeout_seconds: 0,  // 0 = disabled
}
```

**How it works:**

1. The server starts two watchdog tasks when a call begins.
2. The **max-duration watchdog** fires after `max_duration_seconds` — emits `session.timeout` then hangs up.
3. The **idle watchdog** tracks user activity. When the user hasn't spoken for `idle_timeout_seconds`, it emits `session.idle_warning` (if configured), waits a grace period, then emits `session.timeout` and hangs up. Any user speech during the grace period resets the timer.
4. The `session.timeout` event fires before the actual hangup, giving you a chance to warn the user:

```typescript
agent.on("session.idle_warning", (event, call) => {
  // event.remainingSeconds: seconds until timeout
  // event.idleTimeoutSeconds: the configured idle timeout
  call.say("Are you still there?");
});

agent.on("session.timeout", (event, call) => {
  // event.reason: "max_duration" | "idle_timeout"
  call.say("Goodbye! The call is ending due to inactivity.");
});
```

**Timeline:**
```
[silence starts] ──── idle_warning fires ──── idle_timeout fires ──── hangup
     0s              (timeout - warning)s         timeout s
```

> **Note:** Bot speech (e.g. "Are you still there?") **pauses** the idle counter but does **not** reset it. Only real user speech resets the timer. This prevents infinite warning loops.

**WebRTC widget integration:** The `@pinecall/voice-widget` automatically responds to `session.idle_warning` by switching the orb to a blinking amber state (`.idle-warning` CSS class, configurable via `colorWarning` theme prop). On `session.timeout`, the widget auto-disconnects.

---

### Interruption

Controls whether users can interrupt the bot mid-speech.

```typescript
interruption: {
  enabled: true,
  energy_threshold_db: -40,   // min energy to trigger interrupt
  min_duration_ms: 200,       // min speech duration to trigger
}

// Shortcut: false (disables interruption entirely)
```

---

### Analysis & Audio Metrics

Real-time audio metrics for waveform visualization and energy monitoring.

```typescript
config: {
  analysis: {
    send_audio_metrics: true,
    audio_metrics_interval_ms: 100,
    send_turn_audio: false,
    send_bot_audio: false,
  }
}
```

#### `audio.metrics` Event

Emitted per interval — one for **user** (mic) and one for **bot** (TTS):

```typescript
agent.on("audio.metrics", (evt, call) => {
  // evt.source: "user" | "bot"
  // evt.energyDb: -60 to 0 (higher = louder)
  // evt.rms: 0 to 1 (normalized amplitude)
  // evt.peak: 0 to 1
  // evt.isSpeech: boolean (VAD state)
  // evt.vadProb: 0 to 1
});
```

| Field | Type | Description |
|-------|------|-------------|
| `source` | `"user"` \| `"bot"` | Audio source |
| `energyDb` | `number` | Energy in decibels (-60 to 0) |
| `rms` | `number` | Root mean square amplitude (0–1) |
| `peak` | `number` | Peak amplitude (0–1) |
| `isSpeech` | `boolean` | VAD speech detection state |
| `vadProb` | `number` | VAD probability (0–1) |

---

## Multi-Environment

Run dev, staging, and production agents **simultaneously** on the same voice server, sharing the same phone numbers. No extra Twilio costs. Each developer gets their own isolated agent instance.

### How It Works

The SDK reads `PINECALL_MODE` from the environment and prefixes agent IDs automatically:

| `PINECALL_MODE` | Wire slug | Notes |
|-----------------|-----------|-------|
| _(empty/unset)_ | `florencia` | Production — all callers |
| `dev` | `dev-berna-florencia` | Dev — includes developer ID for isolation |
| `staging` | `staging-florencia` | Staging — shared environment, no dev ID |

The server routes phone calls based on the **caller's phone number**:

```
            Incoming call to +13186330963
                       │
              ┌────────┴────────┐
              │                 │
         Caller in          Caller NOT in
         DEV_CALLERS        DEV_CALLERS
              │                 │
    ┌─────────┴─────────┐  ┌───┴───┐
    │  dev-berna-        │  │       │
    │  florencia         │  │ florencia │
    │  (your dev agent)  │  │ (prod)    │
    └───────────────────┘  └───────┘
```

Dev and prod coexist on the **same phone number**. The server's caller-based routing handles the split.

### Setup

Set `PINECALL_MODE` **before** importing `@pinecall/sdk`. The SDK reads it at initialization time.

```javascript
// agent/index.js — set mode before SDK import
const ENV = process.env.NODE_ENV || "production";
if (ENV === "development") process.env.PINECALL_MODE = "dev";
else if (ENV === "staging") process.env.PINECALL_MODE = "staging";

import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY });
await pc.connect();

const agent = pc.deploy("florencia", { /* config */ });
// In dev: registers as "dev-berna-florencia"
// In prod: registers as "florencia"

// Configure caller-based routing for dev/staging
if (pc.mode) {
  const callers = process.env.DEV_CALLERS;
  if (callers) {
    agent.setDevCallers(callers.split(",").map(s => s.trim()));
  }
}
```

Each developer creates a `.env.local` file (gitignored) with their personal config:

```bash
# .env.local — each developer sets their own
PINECALL_DEV_ID=berna
DEV_CALLERS=+34607827824
```

### Multi-Developer Isolation

In dev mode, the SDK includes a **developer identity** in the agent slug to prevent collisions:

```
dev-{PINECALL_DEV_ID}-{agentName}
```

The developer ID is resolved in order:

1. `PINECALL_DEV_ID` environment variable
2. OS username (automatic fallback)

This means multiple developers can run the same agent simultaneously without interfering:

| Developer | `.env.local` | Wire Slug | Phone Routing |
|-----------|-------------|-----------|---------------|
| Berna | `PINECALL_DEV_ID=berna` | `dev-berna-florencia` | Calls from +34607... → Berna's agent |
| Juan | `PINECALL_DEV_ID=juan` | `dev-juan-florencia` | Calls from +34612... → Juan's agent |
| Production | _(none)_ | `florencia` | All other callers |

### Phone Routing

The voice server supports **caller-based routing** for non-production agents:

1. **Production agent** registers `+13186330963` → stored in the main phone map
2. **Dev agent** registers the **same number** → stored in the dev override map
3. On incoming call:
   - If the **caller** is in the dev callers list → routes to the dev agent
   - Otherwise → routes to the production agent

To set your dev callers:

```typescript
if (pc.mode) {
  agent.setDevCallers(["+34607827824"]);
}
```

#### Multi-Developer Strategies

When multiple developers work on the same agent, there are two approaches for phone testing:

**Option A: Shared number + caller override (recommended)**

All developers share the same Twilio number. Each developer configures their personal phone number in `DEV_CALLERS`. The server routes based on who's calling:

```
+13186330963 (shared Twilio number)
    │
    ├── Call from +34607... → dev-berna-florencia
    ├── Call from +34612... → dev-juan-florencia
    ├── Call from +34699... → dev-flor-florencia
    └── Call from anyone else → florencia (production)
```

```bash
# Berna's .env.local
PINECALL_DEV_ID=berna
DEV_CALLERS=+34607827824

# Juan's .env.local
PINECALL_DEV_ID=juan
DEV_CALLERS=+34612345678

# Flor's .env.local
PINECALL_DEV_ID=flor
DEV_CALLERS=+34699887766
```

Zero extra Twilio cost. One number serves all environments simultaneously.

**Option B: Dedicated number per developer**

Each developer uses their own Twilio number. No caller override needed — all calls to that number go to the dev agent:

```typescript
// Berna uses a dedicated dev number
agent.addChannel("phone", "+18005551001");  // Berna's dev number

// Production uses the main number
agent.addChannel("phone", "+13186330963");
```

Simpler routing, but requires extra Twilio numbers ($1/month each).

**Comparison:**

| | Shared + Override | Dedicated Numbers |
|---|---|---|
| Cost | No extra | $1/month per dev |
| Setup | `DEV_CALLERS` in `.env.local` | Separate Twilio number per dev |
| Routing | Caller-based | Number-based |
| External callers | Can't reach dev agent | Can reach dev agent |
| Best for | Internal testing | External/client testing |

### WhatsApp Dev Routing

WhatsApp uses the same **sender-based routing** pattern as phone calls. Multiple developers can share the same WhatsApp Business number, with messages routed to dev agents based on the sender's phone number.

```
Meta WhatsApp Business Number (phone_number_id: 123456)
    │
    ├── Message from +34607... → dev-berna-florencia
    ├── Message from +34612... → dev-juan-florencia
    └── Message from anyone else → florencia (production)
```

`setDevCallers()` configures both phone and WhatsApp routing in one call:

```typescript
if (pc.mode) {
  agent.setDevCallers(["+34607827824"]);  // routes BOTH phone calls AND WhatsApp messages
}
```

> **Same `DEV_CALLERS`, both channels.** When your phone number sends a WhatsApp message to the business number, it routes to your dev agent. When your phone number calls the Twilio number, it also routes to your dev agent. One config, all channels.

Alternatively, each developer can register a separate Meta test number (from the Meta API console), avoiding the need for caller-based routing on WhatsApp.

### WebRTC & Chat Dev Routing

WebRTC and Chat channels don't need caller-based routing — they use **slug-based isolation** automatically:

```typescript
// Dev mode → agent registers as "dev-berna-florencia"
// The browser requests a token for "dev-berna-florencia" specifically
const token = await createToken({
  channel: "webrtc",
  agentId: "dev-berna-florencia",
  apiKey: process.env.PINECALL_API_KEY!,
});
```

Each developer gets their own slug, their own tokens, their own sessions. Multiple developers can test simultaneously without interference.

> **Any web app can connect.** WebRTC and Chat connections go **directly** to `voice.pinecall.io` via DataChannel (audio) or WebSocket (text). The browser never needs access to the agent process. This means any number of web apps, mobile apps, or third-party integrations can connect to the same agent using tokens — without the developer exposing SSE endpoints, webhook URLs, or the agent's Node.js process. The voice server is the relay.

### Staging

Staging uses a simple prefix without developer ID — it's a **shared environment**:

```bash
NODE_ENV=staging node agent/index.js
# → Agent slug: "staging-florencia"
```

Staging agents use the same caller-based override map. Useful for pre-production testing on a staging server.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PINECALL_MODE` | `""` | `"dev"`, `"staging"`, or empty for production |
| `PINECALL_DEV_ID` | OS username | Developer identity for slug isolation |
| `DEV_CALLERS` | — | Comma-separated phone numbers for caller-based routing |

### Vite Integration

When using Vite as your dev server, agents can be embedded in the same process via a plugin:

```javascript
// vite-agent-plugin.mjs
export default function agentPlugin() {
  return {
    name: "my-agent",
    async configureServer() {
      const { startAgent } = await import("./agent/index.js");
      await startAgent();
    },
  };
}
```

```javascript
// vite.config.js
import agentPlugin from "./vite-agent-plugin.mjs";

export default defineConfig({
  plugins: [react(), agentPlugin()],
});
```

`npm run dev` starts both the web server and the voice agent in a single process. Vite sets `NODE_ENV=development` automatically, so the agent runs in dev mode with no extra configuration.

```
npm run dev
  🟢 SDK connected
  🔧 DEV mode [berna] — calls from +34607827824 → dev-berna-florencia
  🌸 Florencia agent ready (Phone + WebRTC + WhatsApp) [dev]
  ➜  Local: http://localhost:5173/
```

### Public API

```typescript
const pc = new Pinecall({ apiKey: "pk_..." });

pc.mode;     // "dev" | "staging" | ""  — current environment mode
pc.devId;    // "berna" — developer identity for slug isolation
```

### Deployment Topologies

Pinecall uses **two fundamentally different communication patterns**. Understanding this distinction is key to choosing the right deployment topology.

#### Observe vs Interact

There are **three communication patterns** in Pinecall. Which one you use depends on the channel and your use case.

**1. Phone calls (inbound + outbound) — Backend only, EventEmitter**

Phone calls are inherently backend-side. Registering an agent with `pc.agent()` requires a `PINECALL_API_KEY` — this must **never** be exposed in frontend code. The agent runs in your Node.js process and receives all call events via the SDK's WebSocket → in-memory EventEmitter.

```
         Twilio ──► voice.pinecall.io ──► SDK WebSocket ──► Your Node.js
                                                               │
                                                          EventEmitter
                                                      agent.on("call.started")
                                                      agent.on("user.message")
                                                      agent.on("llm.tool_call")
```

There is no browser involvement. The entire call lifecycle (STT → LLM → TTS → tool calls) happens server-side. If your agent is phone-only, your architecture is simple: a single Node.js process with the SDK.

**2. Browser interaction (WebRTC / Chat) — Direct to voice server**

When users interact from a web app (voice widget, chatbox), the browser connects **directly** to `voice.pinecall.io` — it never touches your backend:

```
Browser ──► GET  /webrtc/token?agent_id=mara   (public, no API key)
        ──► POST /webrtc/offer  { sdp, token }  → audio via DataChannel

Browser ──► GET  /chat/token?agent_id=mara     (public, no API key)
        ──► WS   /chat/ws?token=cht_xxx        → text via WebSocket
```

The token endpoints are public because they only verify that the agent is online — no secrets are exchanged. The browser gets a short-lived signed token, then opens a direct connection to the voice server. Your agent process can run anywhere.

> **🔒 Origin restriction (recommended):** By default, any website can request a token for your agent. To restrict which domains can embed your voice widget or chatbox, configure `allowedOrigins`:
>
> ```typescript
> const agent = pc.agent("mara", {
>   allowedOrigins: ["https://yourdomain.com", "http://localhost:*"],
>   // ...config
> });
> ```
>
> When set, the server validates the `Origin` header and rejects requests from unlisted domains. For maximum security (mobile apps, multi-tenant platforms), proxy token requests through your own backend with API key authentication.

**3. SSE — Observe events for dashboards and panels**

SSE is for **observing** agent events from a web frontend — call center panels, admin dashboards, monitoring UIs. It requires the agent to run in the same Node.js process as your web server (embedded topology):

```
Browser ←── SSE ←── Your Express/Remix ←── agent.stream() ←── EventEmitter
```

This is how you build a **call center panel** without exposing API keys:

```typescript
// Your backend — agent + SSE in the same process
const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });
await pc.connect();

const agent = pc.agent("support", { /* config */ });
agent.addChannel("phone", "+13186330963");

// SSE endpoint — filter by user role, no API key to the browser
app.get("/api/events", (req, res) => {
  const userId = req.auth.userId;
  const allowed = getUserAgents(userId);  // your auth logic
  pc.stream(res, { agents: allowed });    // only their agents
});
```

The browser sees real-time call events (who's calling, transcripts, tool calls) but has **zero access** to the API key or agent internals. You control exactly which events reach which user.

**Summary:**

| Channel | Who initiates | Where it runs | How events flow | API key exposed? |
|---------|--------------|---------------|----------------|-----------------|
| **Phone** (inbound) | Twilio | Backend only | EventEmitter → SDK WebSocket | ❌ Server-side only |
| **Phone** (outbound) | `agent.dial()` | Backend only | EventEmitter → SDK WebSocket | ❌ Server-side only |
| **WebRTC** | Browser user | Browser → voice server | DataChannel (direct) | ❌ Token-based |
| **Chat** | Browser user | Browser → voice server | WebSocket (direct) | ❌ Token-based |
| **WhatsApp** | Meta webhook | voice server | SDK WebSocket → EventEmitter | ❌ Server-side only |
| **SSE** | Browser (observe) | Your backend → browser | EventEmitter → `agent.stream()` | ❌ Your auth controls access |

> **Key insight:** API keys never leave your backend. Phone calls and tool execution happen server-side. Browser users connect via tokens. SSE lets you build dashboards with your own auth layer on top.

---

With this in mind, your agent can run **embedded** inside your web server or as a **standalone** process:

#### Embedded Agent (same process)

The agent runs inside your web server (Express, Remix, Hono, etc.) or via a Vite plugin. Both the web app and the agent share the same Node.js process.

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

**What works:**
- ✅ **SSE Streaming** — `agent.stream()` and `pc.stream()` pipe events directly from the in-memory `EventEmitter`
- ✅ **REST endpoints** — `req.app.agent` or module-level reference
- ✅ **Hot-reload** — file watchers, Vite HMR
- ✅ **Single `npm run dev`** — Vite plugin boots the agent automatically

**Example (Vite plugin — recommended for dev):**

```javascript
// vite-agent-plugin.mjs
export default function agentPlugin() {
  return {
    name: "my-agent",
    async configureServer() {
      const { startAgent } = await import("./agent/index.js");
      await startAgent();
    },
  };
}
```

**Example (Express):**

```typescript
import express from "express";
import { Pinecall } from "@pinecall/sdk";

const app = express();
const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });
await pc.connect();

const agent = pc.agent("receptionist", { /* config */ });
agent.addChannel("phone", "+13186330963");
agent.addChannel("webrtc");
agent.addChannel("chat");

// SSE endpoint — works because agent is in the same process
app.get("/api/events", (req, res) => agent.stream(res));

// Custom API that reads agent state
app.get("/api/calls", (req, res) => {
  res.json({ activeCalls: agent.calls.size });
});

app.listen(3000);
```

#### Standalone Agent (separate process)

The agent runs as its own Node process, alongside a separate web server. Both connect to `voice.pinecall.io` independently.

```
┌──────────────┐     ┌──────────────────┐
│  Web App     │     │  Agent Process   │
│  (Next.js,   │     │  node agent.js   │
│  Remix, etc) │     │  pc.agent()      │
│              │     │                  │
│  SSE ❌      │     │  WS ────────►    │
│  No agent    │     │  voice.pinecall  │
│  reference   │     │  .io             │
└──────────────┘     └──────────────────┘
        │                     │
        │    ┌────────────────┘
        ▼    ▼
   voice.pinecall.io
```

Browser users (WebRTC, chat) connect directly to the voice server via tokens — they don't care where the agent process lives. SSE is the only thing that breaks because it needs in-process access to the EventEmitter.

#### Headless Agent (no web server)

The agent doesn't need a web server at all. Many agents are **pure phone/SIP agents** — they answer calls, run tools, and hang up. No frontend, no API, no UI. Just a Node process running 24/7.

```
┌─────────────────────────┐
│  node agent.js          │
│                         │
│  pc.agent("julia")      │
│  addChannel("phone")    │
│  addChannel("sip:...")  │
│                         │
│  WS ────────────────►   │
│  voice.pinecall.io      │
└─────────────────────────┘
       That's it.
```

```typescript
// agent.js — a complete production agent, no web server needed
import { Pinecall } from "@pinecall/sdk";
import { openDoor, identifyVisitor } from "./tools.js";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });
await pc.connect();

const julia = pc.deploy("julia", {
  prompt: "You are Julia, the intercom concierge...",
  model: "gpt-4.1-mini",
  voice: "elevenlabs:abc",
  language: "es",
  channels: ["phone:+13186330963", "sip:julia@trunk.twilio.com"],
  tools: [openDoor, identifyVisitor],
});

julia.on("call.started", (call) => call.say("¿Quién es?"));

julia.on("llm.tool_call", async (data, call) => {
  // Tools run locally — no webhooks, no exposed APIs
  for (const tc of data.toolCalls) {
    const result = await handleTool(tc.name, JSON.parse(tc.arguments));
    call.toolResult(data.msgId, [{ toolCallId: tc.id, result }]);
  }
});

console.log("Julia is live. Ctrl+C to stop.");
// Runs forever — PM2, Docker, systemd, whatever.
```

This is the simplest possible deployment. Deploy it with PM2, Docker, systemd — it connects to the voice server and waits for calls. The tool handlers (`openDoor`, `identifyVisitor`) call your internal APIs, databases, or hardware directly from the same process. No webhook URLs, no public endpoints, no attack surface.

#### Comparison

| Feature | Embedded | Standalone | Headless |
|---------|----------|------------|----------|
| Web server | ✅ Same process | Separate process | ❌ None |
| SSE (`agent.stream()`) | ✅ Works | ❌ Not available | ❌ N/A |
| WebRTC (browser voice) | ✅ Via DataChannel | ✅ Via DataChannel | ✅ Via DataChannel |
| Chat (browser text) | ✅ Via `/chat/ws` | ✅ Via `/chat/ws` | ✅ Via `/chat/ws` |
| Phone / SIP | ✅ | ✅ | ✅ |
| WhatsApp | ✅ | ✅ | ✅ |
| Tool calls | ✅ In-process | ✅ In-process | ✅ In-process |
| Agent state in web API | ✅ Direct reference | ❌ No shared memory | ❌ N/A |
| Complexity | Medium | Medium | **Lowest** |
| Best for | Dev + dashboards | Web app + agent | Phone/SIP agents |

**Recommendation:**
- **Embedded** for development (Vite plugin) and apps that need SSE dashboards
- **Standalone** for production web apps where the agent and web server scale independently
- **Headless** for phone/SIP agents, IoT, background services — anything without a UI

---

## Philosophy

Pinecall SDK is designed around one idea: **any existing app can add a voice agent without changing its architecture.**

Traditional voice AI platforms (Vapi, Retell, Bland) are **platform-first** — you configure agents in their dashboard, define tools as JSON schemas, and expose webhook URLs for the platform to call. Your app adapts to the platform.

Pinecall is **code-first** — the agent is your code. It runs inside your app, uses your database, calls your internal APIs, and handles tool calls locally. The platform adapts to your app.

```
Platform-first (Vapi):
  Your App ──webhook──► Vapi Dashboard ──POST──► Your Webhook URL
                         (config UI)              (exposed endpoint)

Code-first (Pinecall):
  ┌─── Your App ──────────────────────┐
  │  your code + pc.agent() + tools   │──WS──► voice.pinecall.io
  │  everything runs here             │        (audio pipeline only)
  └───────────────────────────────────┘
```

This matters because:

- **Existing chatbots** (Langchain, LlamaIndex, custom LLM pipelines) can become voice agents by hooking into `turn.end` and streaming to `call.replyStream()`. No rewrite needed.
- **Tool calls are local functions**, not webhook URLs. Your agent can call `db.query()`, `redis.get()`, `hardware.openDoor()` — anything your process can reach. No exposed endpoints, no public API surface.
- **Multi-channel is native.** The same agent instance handles phone calls, SIP intercoms, WebRTC voice widgets, text chat, and WhatsApp. One codebase, all channels.
- **No vendor lock-in on the LLM.** Use server-side LLM (we run it) or bring your own (OpenAI, Anthropic, local Ollama). Switch mid-call if you want.

The voice server (`voice.pinecall.io`) handles the hard real-time parts — audio transport, STT, TTS, VAD, turn detection. Your code handles everything else — business logic, tools, prompts, history, state. Each side does what it's good at.


---

## Security

### Token Security Model

Browser connections (WebRTC and Chat) use **short-lived tokens** generated by the voice server. The recommended model: **your backend generates tokens using your API key, and distributes them to browsers through your own auth layer.**

This is the same model used by LiveKit, Twilio, Daily.co, and every major real-time platform.

```
Browser → Your Backend (your auth: session, JWT, OAuth)
              ↓
         pc.createToken("webrtc", "florencia")
              ↓  (API key in Authorization header)
         voice.pinecall.io → { token, server, expiresIn }
              ↓
         Your Backend returns token to browser
              ↓
         Browser connects to voice.pinecall.io with token
```

**Backend (Express, Next.js, Hono, etc.):**

```typescript
import { Pinecall } from "@pinecall/sdk";
const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });
await pc.connect();

const agent = pc.agent("florencia", { /* config */ });

// Token endpoint — protected by YOUR auth
app.get("/api/token", authMiddleware, async (req, res) => {
  const channel = req.query.channel as "webrtc" | "chat";
  const token = await agent.createToken(channel);
  res.json(token);
});

// Or if agent is in a separate process:
app.get("/api/token", authMiddleware, async (req, res) => {
  const token = await pc.createToken("webrtc", "florencia");
  res.json(token);
});
```

**Frontend (VoiceWidget):**

```tsx
<VoiceWidget
  agent="florencia"
  tokenProvider={async () => {
    const res = await fetch("/api/token?channel=webrtc", {
      credentials: "include",  // send your session cookie
    });
    return res.json();
  }}
/>
```

### Why Tokens Are Safe

Tokens have three security properties that make them safe to pass to browsers:

| Property | Value | Effect |
|----------|-------|--------|
| **Single-use** | Consumed on first connection | Can't be reused by an attacker |
| **Short-lived** | 60 second TTL | Expires before anyone can steal it |
| **Scoped** | Locked to agent + org | Can't be used for a different agent |

The token is **not** the security boundary — **your backend is**. The token is a short-lived capability that proves "someone authorized gave me permission to connect." The security question is: who can call your `/api/token` endpoint?

- **Requires login** → only authenticated users get tokens
- **Rate limited** → can't bulk-generate tokens
- **Permission-checked** → only authorized users connect

This is like a movie ticket: the theater (your backend) verifies your identity and gives you a ticket. The ticket works once, for one screen, for a limited time. Even if someone steals the ticket, they get one session — and they'd need to break HTTPS (TLS) to intercept it.

### allowedOrigins (convenience mode)

For simple deployments without a backend (demos, prototypes, CodePen), you can opt-in to public token access by configuring `allowedOrigins`:

```typescript
const agent = pc.agent("demo-bot", {
  allowedOrigins: [
    "https://demo.mysite.com",      // exact match
    "https://*.mysite.com",          // subdomain wildcard
    "http://localhost:*",            // any port (dev)
  ],
});
```

When `allowedOrigins` is set, the token endpoint accepts browser requests from matching origins **without** an API key. The `Origin` header is browser-enforced (can't be spoofed in a real browser).

> **⚠️ Warning:** `allowedOrigins` protects against casual embedding but NOT against a determined attacker (Origin headers can be spoofed from scripts/curl). For production, always use `tokenProvider` with your backend auth.

| Mode | Security Level | Use Case |
|------|---------------|----------|
| `tokenProvider` (backend) | ✅ Full auth control | Production apps |
| `allowedOrigins` (public) | ⚠️ Origin-based only | Demos, prototypes |
| Neither (default) | ❌ Rejected | — |

---

## License

MIT © [Pinecall](https://pinecall.io)

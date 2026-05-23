<h1 align="center">@pinecall/sdk</h1>

<p align="center">
  <strong>Build real-time voice AI agents in TypeScript.</strong><br/>
  WebSocket client for Pinecall Voice — 49 KB, one dependency.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#api-reference">API</a> ·
  <a href="#events">Events</a> ·
  <a href="#hot-reload-live-configuration">Hot-Reload</a> ·
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
  - [fetchVoices](#fetchvoicesopts)
  - [fetchPhones](#fetchphonesopts)
  - [fetchWebRTCToken](#fetchwebrtctokenopts)
  - [fetchTwilioBalance](#fetchtwiliobalanceopts)
- [SSE Streaming](#sse-streaming)
  - [Single Agent](#single-agent-stream)
  - [Multi-Agent](#multi-agent-stream)
  - [Filtering (Multi-Tenant)](#filtering--multi-tenant-example)
  - [Events](#streamed-events)
- [Configuration Reference](#configuration-reference)
  - [STT Providers](#stt-providers)
  - [TTS Providers](#tts-providers)
  - [LLM Providers](#llm-providers)
  - [Interruption](#interruption)
  - [Audio Metrics](#analysis--audio-metrics)


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
    engine: "openai",
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
agent.on("llm.tool_call", async (call, data) => {
  if (!data.tool_calls) return; // skip re-emissions
  const results = [];
  for (const tc of data.tool_calls) {
    const args = JSON.parse(tc.arguments);
    const result = await myToolHandler(tc.name, args);
    results.push({ tool_call_id: tc.id, result });
  }
  agent.send({
    event: "llm.tool_result",
    call_id: call.id,
    msg_id: data.msg_id,
    results,
  });
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
| `channels` | `array` | `"webrtc"`, `"mic"`, `"chat"`, or phone numbers |
| `phones` | `string[]` | Phone numbers (legacy, prefer `channels`) |

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
    engine: "openai",
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

// Update a channel's config at runtime
agent.configureChannel("+34911234567", { voice: "cartesia:newVoice" });

// Remove a channel
agent.removeChannel("+34911234567");
```

#### Agent Methods

| Method | Description |
|--------|-------------|
| `agent.addChannel(type, ref?, config?)` | Register a phone, webrtc, mic, or chat channel |
| `agent.removeChannel(ref)` | Unregister a channel |
| `agent.configure(opts)` | Hot-reload agent defaults (voice, language, STT, LLM) — affects all future calls |
| `agent.configureChannel(ref, config)` | Update a specific channel's config |
| `agent.configureSession(callId, opts)` | Update config for a live call (equivalent to `call.configure`) |
| `agent.dial(opts)` | Make an outbound call — returns `Promise<Call>` |
| `agent.call(callId)` | Get a `Call` object by ID (`undefined` if not found) |
| `agent.getConfig()` | Returns the current `AgentConfig` |
| `agent.stream()` | SSE stream of this agent's events (see [SSE](#sse-streaming)) |
| `agent.send(data)` | Send a raw protocol message (low-level) |

#### `agent.configure()` — Hot-Reload

Update the agent's defaults at runtime. Changes take effect on **all future calls** — existing calls are not affected. Sends an `agent.configure` command over the WebSocket.

```typescript
// Switch to French voice
agent.configure({ voice: "elevenlabs:frenchVoiceId", language: "fr" });

// Update LLM model
agent.configure({
  llm: { engine: "openai", model: "gpt-4.1", enabled: true,
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

// REST helpers (no WebSocket needed)
const voices = await pc.fetchVoices({ provider: "elevenlabs" });
const phones = await pc.fetchPhones();
const token = await pc.getWebRTCToken("mara");
```

### Call

Per-session handle. Created automatically on `call.started`.

#### Speech

| Method | Description |
|--------|-------------|
| `call.say(text)` | Speak text immediately (standalone, no `in_reply_to`) |
| `call.reply(text)` | Reply to the latest user message (auto-tracks `in_reply_to`) |
| `call.replyStream(turn?)` | Open a token stream → returns [`ReplyStream`](#replystream) |
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
| `llm.tool_call` | `(call, data)` | Server-side LLM requests a tool call |
| `session.timeout` | `(event, call)` | Session timeout warning (max duration / idle) |

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
    engine: "openai",
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
  voice: { engine: "cartesia", voiceId: "abc", speed: 1.1 },
  stt: { engine: "deepgram", model: "nova-3", language: "fr" },
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

**Returns:** `Voice[]` — each voice has `id`, `name`, `provider`, `gender`, `style`, `languages[]`, `preview_url`.

### `fetchPhones(opts)`

List phone numbers on your Pinecall account.

```typescript
import { fetchPhones } from "@pinecall/sdk";

const phones = await fetchPhones({ apiKey: "pk_..." });
phones.forEach(p => console.log(`${p.name} → ${p.number}`));
// → "(318) 633-0963 → +13186330963"
```

**Returns:** `Phone[]` — each phone has `number` (E.164), `name`, `sid`, `isSdk`.

### `fetchWebRTCToken(opts)`

Get a signed token for browser WebRTC connections. **Public endpoint** — no API key required. The agent must be online.

```typescript
import { fetchWebRTCToken } from "@pinecall/sdk";

// Works from browser or server — no API key needed
const { token, server } = await fetchWebRTCToken({ agentId: "my-agent" });

// Use the token in the /webrtc/offer POST body
const res = await fetch(`${server}/webrtc/offer`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sdp: offer.sdp, type: "offer", token }),
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

## Configuration Reference

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
  model: "eleven_turbo_v2_5",
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
  engine: "openai",
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
  engine: "mistral",
  model: "mistral-medium",
  enabled: true,
  prompt: "System prompt here.",
}
```

> **LLM shortcut:** `llm: "openai:gpt-4.1-mini"` expands to `{ engine: "openai", model: "gpt-4.1-mini", enabled: true }`.

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
  // evt.energy_db: -60 to 0 (higher = louder)
  // evt.rms: 0 to 1 (normalized amplitude)
  // evt.peak: 0 to 1
  // evt.is_speech: boolean (VAD state)
  // evt.vad_prob: 0 to 1
});
```

| Field | Type | Description |
|-------|------|-------------|
| `source` | `"user"` \| `"bot"` | Audio source |
| `energy_db` | `number` | Energy in decibels (-60 to 0) |
| `rms` | `number` | Root mean square amplitude (0–1) |
| `peak` | `number` | Peak amplitude (0–1) |
| `is_speech` | `boolean` | VAD speech detection state |
| `vad_prob` | `number` | VAD probability (0–1) |

---

## License

MIT © [Pinecall](https://pinecall.io)

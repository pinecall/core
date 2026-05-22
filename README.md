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
  - [Client-side LLM](#client-side-llm-bring-your-own)
- [API Reference](#api-reference)
  - [Pinecall (client)](#pinecall-client)
  - [Agent](#agent)
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
  - [fetchBalance](#fetchbalanceopts-1)
- [Configuration Reference](#configuration-reference)
  - [STT Providers](#stt-providers)
  - [TTS Providers](#tts-providers)
  - [LLM Providers](#llm-providers)
  - [Turn Detection](#turn-detection)
  - [VAD Config](#vad-config)
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
  turnDetection: "native",
  llm: {
    engine: "openai",
    model: "gpt-4.1-mini",
    enabled: true,
    instructions: "You are a helpful receptionist. Be concise.",
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

Created via `pc.agent(id, config?)`. Owns channels, routes call events, and stores defaults.

```typescript
const agent = pc.agent("my-agent", {
  // Audio
  voice: "elevenlabs:abc",          // TTS voice (shortcut or full config)
  language: "es",                    // BCP-47 language code
  stt: "deepgram-flux",             // STT engine
  turnDetection: "native",          // turn detection mode

  // Server-side LLM (optional)
  llm: {
    engine: "openai",
    model: "gpt-4.1-mini",
    enabled: true,
    instructions: "System prompt with {{template_vars}}.",
  },
  tools: [/* OpenAI function-calling format */],
  greeting: "Hello!",               // server-side greeting config
});

// Update any config later (hot-reload, affects future calls)
agent.configure({ voice: "cartesia:xyz", language: "fr" });

// Channels — each can override agent defaults with per-channel config
agent.addChannel("phone", "+18045551234");
agent.addChannel("phone", "sip:bot@trunk.twilio.com");
agent.addChannel("webrtc");

// Per-channel config: different voice/language/STT per number
agent.addChannel("phone", "+34911234567", {
  voice: "elevenlabs:spanishVoiceId",
  language: "es",
  stt: "deepgram-flux",
});

agent.addChannel("phone", "+442012345678", {
  voice: "cartesia:britishVoiceId",
  language: "en-GB",
  llm: { engine: "openai", model: "gpt-4.1-mini", enabled: true,
         instructions: "You are a UK support agent. Use British English." },
});

// Update a channel's config at runtime
agent.configureChannel("+34911234567", { voice: "cartesia:newSpanishVoice" });

// Remove a channel
agent.removeChannel("+442012345678");

// Outbound calls
const call = await agent.dial({ to: "+15551234", from: "+13186330963" });

// Low-level protocol access
agent.send({ event: "llm.tool_result", call_id: "...", msg_id: "...", results: [] });
```

### Call

Per-session handle. Created automatically on `call.started`.

#### Speech

| Method | Description |
|--------|-------------|
| `call.say(text)` | Speak text immediately (greeting — no `in_reply_to`) |
| `call.reply(text)` | Reply to the latest user message (auto-tracks `in_reply_to`) |
| `call.replyStream(turn?)` | Open a token stream → returns [`ReplyStream`](#replystream) |
| `call.cancel(msgId?)` | Cancel a specific or the current message |
| `call.clear()` | Flush all queued TTS audio |

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
| `call.configure(opts)` | Change voice, STT, language, turn detection — takes effect immediately |
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
| **Context** | `call.addContext(text)` | Appended after instructions |

### Prompt Template Variables

Define a prompt with `{{placeholders}}`. The server resolves them before each LLM request. Built-in variables: `{{date}}`, `{{time}}`.

```typescript
const agent = pc.agent("support", {
  llm: {
    engine: "openai",
    model: "gpt-4.1-mini",
    enabled: true,
    instructions: `You are {{agent_name}}, support agent at {{company}}.
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

Voice, STT, and turn detection accept string shortcuts or full config objects:

```typescript
// Shortcuts
{ voice: "elevenlabs:voiceId" }
{ stt: "deepgram-flux" }
{ stt: "deepgram:nova-3:fr" }         // provider:model:language
{ turnDetection: "native" }

// Full config objects
{
  voice: { engine: "cartesia", voiceId: "abc", speed: 1.1 },
  stt: { engine: "deepgram", model: "nova-3", language: "fr" },
  turnDetection: { mode: "smart_turn", silenceMs: 600 },
}
```

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

### `fetchBalance(opts)`

Fetch the Pinecall account balance.

```typescript
import { fetchBalance } from "@pinecall/sdk";

const balance = await fetchBalance({ apiKey: "pk_..." });
console.log(`$${balance.balance} ${balance.currency}`);
```

**Returns:** `{ balance: string, currency: string } | null`.

### Options

All REST helpers accept an `apiUrl` option to point to a custom server:

```typescript
fetchVoices({ apiUrl: "http://localhost:1337" });
fetchPhones({ apiKey: "pk_...", apiUrl: "http://localhost:1337" });
```

---

## Configuration Reference

### STT Providers

#### Deepgram Flux (recommended)

Best for multilingual, handles turn detection natively. Use `turnDetection: "native"` with Flux.

```typescript
stt: {
  provider: "deepgram-flux",
  language: "multi",         // auto-detect language
  eot_threshold: 0.5,        // end-of-turn sensitivity (0-1)
  eager_eot_threshold: 0.7,  // eager turn threshold
  eot_timeout_ms: 2000,
  keyterms: ["pinecall"],
  min_confidence: null,
}

// Shortcut: "deepgram-flux" or "flux"
```

> **Flux + Native:** Flux handles turn detection internally — always pair with `turnDetection: "native"`. Using `smart_turn` with Flux causes unstable `eager.turn` signals since Flux transcripts update continuously.

#### Deepgram Nova

Classic STT. Pair with `turnDetection: "smart_turn"` for best results — Nova's `is_final` fires `eager.turn`, then smart_turn confirms in ~300ms.

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
  instructions: "System prompt here.",
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
  instructions: "System prompt here.",
}
```

> **LLM shortcut:** `llm: "openai:gpt-4.1-mini"` expands to `{ engine: "openai", model: "gpt-4.1-mini", enabled: true }`.

---

### Turn Detection

| Mode | Best With | Description |
|------|-----------|-------------|
| `native` | **Flux** | Delegates to the STT provider's built-in endpointing. Required for Flux. |
| `smart_turn` | **Nova**, Gladia | AI-powered turn detection. Uses `is_final` + confirmation window. |
| `silence` | Any | Simple silence timer. Fastest but least accurate. |

```typescript
turnDetection: {
  mode: "smart_turn",
  smart_turn_threshold: 0.5,  // 0-1, lower = faster response
  native_silence_ms: 500,     // for native mode
  max_silence_seconds: 2,     // for silence mode
}

// Shortcuts: "smart_turn", "native", "silence"
```

**Recommended pairings:**
```typescript
// Flux: always native
{ stt: "deepgram-flux", turnDetection: "native" }

// Nova: smart_turn for best latency
{ stt: "deepgram:nova-3", turnDetection: "smart_turn" }

// AWS Transcribe: native (no smart_turn support)
{ stt: "transcribe", turnDetection: "native" }
```

---

### VAD Config

Voice Activity Detection — controls when speech starts/stops being processed.

```typescript
config: {
  vad: {
    provider: "silero",        // or "native"
    threshold: 0.5,
    min_speech_ms: 250,
    min_silence_ms: 200,
    speech_end_delay_ms: 400,
  }
}
```

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

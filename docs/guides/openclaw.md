---
title: "OpenClaw & OpenAI-compatible LLMs"
description: "Give any /v1/chat/completions endpoint a voice — phone, WebRTC or chat — with the @pinecall/openclaw plugin."
---

# OpenClaw & OpenAI-compatible LLMs

`@pinecall/openclaw` puts a voice in front of an LLM you already run. It talks to any
`/v1/chat/completions` endpoint with plain `fetch` — **zero dependencies** — so it works
with a local [OpenClaw](https://openclaw.ai) gateway, OpenAI, or any provider that speaks
the same wire format.

> **This is the client-side LLM path.** The plugin runs the model in *your* process: it owns the
> history, the streaming and the tool loop, and the voice server only does STT, TTS and turn
> detection. If you want the server to run the model instead, set `llm` on the agent and read
> [Server vs client LLM](/concepts/server-vs-client-llm).

## Quick start

It is its own package, on top of the SDK:

```bash
npm i @pinecall/openclaw
```

```typescript
import { PinecallOpenClaw } from "@pinecall/openclaw";

const voice = new PinecallOpenClaw({
    apiKey: process.env.PINECALL_API_KEY!,
    llm: { model: "gpt-4.1-mini" },            // defaults to OpenAI + OPENAI_API_KEY
    phone: "+13186330963",
    voice: "elevenlabs/sarah",
    greeting: "Hey! How can I help?",
    prompt: "You are a helpful voice assistant.",
});

await voice.start();
```

That is the whole program. `start()` registers the phone number (plus the WebRTC and chat
channels, unless you turn them off), connects, and from then on every user turn goes to the
model and streams back as speech.

## Point it at a local OpenClaw gateway

`openclawGateway()` resolves the URL, the token and the model for you — no hand-written
config block:

```typescript
import { PinecallOpenClaw, openclawGateway } from "@pinecall/openclaw";

const voice = new PinecallOpenClaw({
    apiKey: process.env.PINECALL_API_KEY!,
    llm: openclawGateway(),
    phone: "+13186330963",
    voice: "elevenlabs/sarah",
});

await voice.start();
```

Each field is resolved independently, first hit wins:

| Order | Source |
|---|---|
| 1 | The argument — `openclawGateway({ url, key, model })` |
| 2 | The environment — `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_MODEL` |
| 3 | The config file — `$OPENCLAW_CONFIG`, else `~/.openclaw/openclaw.json` (`gateway.port`, `gateway.auth.token`, `agents.defaults.model.primary`) |
| 4 | The defaults — `http://127.0.0.1:18789/v1`, no token, `openclaw/default` |

> **A missing or malformed config file is not an error.** The file is read lazily, inside the
> call, and any problem reading or parsing it falls straight through to the next source. The
> token is never logged and never appears in an error message.

It throws in exactly two cases, both with the fix in the message: when no token could be found
**and** the resolved URL is not loopback (a tokenless gateway on a public address is an open LLM),
and when the config file explicitly says `gateway.http.endpoints.chatCompletions.enabled: false`
— better a clear error at startup than a 404 mid-call.

```typescript
// Overrides compose with the resolution — everything else still comes from the file.
llm: openclawGateway({ model: "openai/gpt-5.4" }),
```

## The proxy assistant — a fast voice, a slow brain

The pattern that makes this worth doing: a small fast model does the talking, and hands the
genuinely hard turns to a slower, smarter backend while the caller hears hold music. Declare it
with `proxy` and the plugin wires the tool, the hold and the timeout for you:

```typescript
const voice = new PinecallOpenClaw({
    apiKey: process.env.PINECALL_API_KEY!,
    llm: openclawGateway(),                    // fast model that talks
    phone: "+13186330963",
    voice: "elevenlabs/sarah",
    greeting: "Hey! How can I help?",
    proxy: {
        ask: async (task, call, signal) => {
            const answer = await myBackendAI(task, { signal });   // slow but smart
            return answer;
        },
        name: "ask_backend",                   // optional — this is the default
        description: "Delegate anything that needs real thinking.",
        hold: true,                            // hold music while it thinks (default)
        timeoutMs: 30_000,
    },
});

await voice.start();
```

What happens on a delegated turn:

```
User speaks → Pinecall STT → fast model (streaming, <1s)
                                 │ simple → answers straight away
                                 │ hard   → calls ask_backend
                                          → call.hold()      🎵
                                          → your backend
                                          → call.unhold()    🔊
                                          → fast model speaks the summary
```

Nothing new goes on the wire — the proxy is an ordinary tool in the same OpenAI tool list.
Three guarantees are worth knowing:

- **The hold always lifts.** `unhold()` runs in a `finally`, so a backend that throws, times
  out or gets aborted can never leave a caller stranded on hold music.
- **A barge-in kills the backend call.** The `signal` handed to `ask` aborts with the turn, so
  the moment the caller talks over the agent, the pending request is cancelled.
- **A timeout still speaks.** On timeout the model receives `timeoutMessage` as the tool result
  and apologizes in its own words, instead of leaving a dead line.

It composes with your own tools: the proxy tool is appended to `tools`, and a name collision
with one of them is refused at construction time rather than silently overriding it.

## Your own tools

Tools are plain OpenAI function definitions, executed by `onToolCall`:

```typescript
const voice = new PinecallOpenClaw({
    apiKey: process.env.PINECALL_API_KEY!,
    llm: { model: "gpt-4.1-mini" },
    phone: "+13186330963",
    prompt: "You are a helpful assistant.",
    tools: [{
        name: "lookup",
        description: "Look up an order by id.",
        parameters: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
        },
    }],
    onToolCall: async (name, args, call) => {
        call.hold();
        const result = await fetchFromBackend(String(args.id));
        call.unhold();
        return result;                          // string or object — objects are JSON.stringify'd
    },
    on: {
        onCallStarted: (call) => console.log(`📞 ${call.from}`),
        onCallEnded: (_call, reason) => console.log(`📴 ${reason}`),
    },
});
```

The loop runs until the model answers in words, or `maxToolLoops` (default 5) is spent.

## Take the whole turn

`onTurn` switches the plugin off: no prompt, no history, no tool loop. You get the turn, the
call, a [`ReplyStream`](/api/reply-stream) and an `AbortSignal` that fires when the caller
interrupts.

```typescript
const voice = new PinecallOpenClaw({
    apiKey: process.env.PINECALL_API_KEY!,
    phone: "+13186330963",
    onTurn: async (turn, call, stream, signal) => {
        for await (const token of myCustomPipeline(turn.text, { signal })) {
            if (stream.aborted) break;
            stream.write(token);
        }
        stream.end();
    },
});
```

Forgetting `stream.end()` is safe — the plugin ends the stream when your handler returns.

## Options

| Option | Type | Default | What it does |
|---|---|---|---|
| `apiKey` | `string` | — | Pinecall API key |
| `url` | `string` | `wss://voice.pinecall.io` | Voice server override |
| `llm.url` | `string` | `https://api.openai.com/v1` | LLM base URL |
| `llm.key` | `string` | `OPENAI_API_KEY` | LLM API key |
| `llm.model` | `string` | `gpt-4.1-mini` | Model name |
| `prompt` | `string` | a concise voice-assistant prompt | System prompt |
| `phone` | `string \| string[]` | — | Phone number(s) to answer on |
| `webrtc` | `boolean` | `true` | Register the WebRTC channel |
| `chat` | `boolean` | `true` | Register the chat channel |
| `voice` | `VoiceShortcut` | — | TTS voice, e.g. `"elevenlabs/sarah"` |
| `language` | `string` | — | Language code |
| `stt` | `STTShortcut` | — | STT override |
| `interruption` | `InterruptionShortcut` | — | Barge-in config |
| `greeting` | `string` | — | Spoken by the server on call start |
| `name` | `string` | `"openclaw-voice"` | Agent id |
| `tools` | `ToolDef[]` | — | Tool definitions (OpenAI format) |
| `onToolCall` | `function` | — | Tool executor |
| `maxToolLoops` | `number` | `5` | Max tool iterations per turn |
| `proxy` | `ProxyConfig` | — | The slow, smart backend (see above) |
| `onTurn` | `function` | — | Take over the turn entirely |
| `maxHistory` | `number` | `50` | Max history messages per call |
| `on` | `OpenClawEventHandlers` | — | `onCallStarted`, `onCallEnded`, `onTurnCompleted`, `onError` |

## Surface

| Member | What |
|---|---|
| `start()` | Register channels and connect |
| `stop()` | Disconnect |
| `dial(to, from, greeting?)` | Place an outbound call (starts first if needed) |
| `agent` | The underlying [`Agent`](/api/agent) — add events, tools, channels |
| `pinecall` | The underlying [`Pinecall`](/api/pinecall) client |

> **History is per call and lives in memory.** It is seeded with the system prompt (and the
> greeting, so the model does not greet twice), trimmed to `maxHistory` with the system message
> always preserved, and dropped when the call ends. For history that outlives a call, use
> [conversation history](/guides/conversation-history) on the agent itself.

## Errors never take the call down

An HTTP failure from the LLM is reported to `on.onError` and the caller hears a short apology
instead of dead air — the call stays up and the next turn goes out normally. Same for a tool
that throws: the error text goes back to the model as the tool result, and the model explains
itself.

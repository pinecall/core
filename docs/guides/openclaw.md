---
title: "OpenClaw"
description: "Give the agent running on your own machine a phone number, with @pinecall/openclaw."
---

# OpenClaw

[OpenClaw](https://openclaw.ai) is an agent runtime you host yourself. It can hold several
agents at once, and each one has its own workspace, identity, memory, tools and session
store — it is somebody, not an endpoint.

**`@pinecall/openclaw` gives one of them a phone number.** Somebody calls, and *your* agent,
on *your* computer, answers.

```bash
npm i @pinecall/openclaw
```

```
   caller ──📞── Pinecall cloud ──ws── your machine
                 (telephony,            ├── the SDK client (@pinecall/openclaw)
                  STT, TTS)             └── OpenClaw gateway  127.0.0.1:18789
                                             └── agent "voice"  ← the brain
```

Pinecall does only the parts that have to live in a datacentre: the phone line,
speech-to-text, text-to-speech, turn detection. **The thinking never leaves your machine** —
the gateway is on loopback and the plugin talks to it from the same computer.

## The whole program

```typescript
import { PinecallOpenClaw, openclawGateway } from "@pinecall/openclaw";

const voice = new PinecallOpenClaw({
    gateway: openclawGateway({ agent: "voice" }),   // which agent answers
    phone: "+13186330963",
    voice: "elevenlabs/sarah",
    language: "es",
});

await voice.start();
```

That is all of it. **There is no prompt, no model and no tools in this config, and that is
the point** — your agent already has all three. See [What it never
sends](#what-it-never-sends).

## Which agent answers

OpenClaw treats the OpenAI `model` field as an **agent target**, not a provider model id:

| value | who answers |
|---|---|
| `openclaw` · `openclaw/default` | the gateway's default agent |
| `openclaw/<agentId>` | that agent, by its id in `agents.list` |

`openclawGateway()` builds it from `~/.openclaw/openclaw.json`, so you name the agent and
nothing else:

```typescript
openclawGateway({ agent: "voice" })   // → { url, key, model: "openclaw/voice" }
```

It resolves each field independently — argument, then environment
(`OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_AGENT`), then the config file,
then the documented defaults. An agent id the config does not declare is refused at startup,
naming the ones it does — a typo you want to hear about now, not mid-call.

> **It never reads `agents.defaults.model.primary`.** That is the provider model an agent
> runs on. Sending it as `model` asks the gateway for an agent by that name, and there is no
> such agent. The model an agent runs on is **its** business; to override it per request use
> `backendModel`, which becomes the `x-openclaw-model` header.

## What it never sends

This package is a **voice transport**. Per turn it sends exactly one thing — what the caller
just said — and streams back whatever the agent answers. Three things it deliberately does
not send, because your agent already has them:

| not sent | why |
|---|---|
| **A system prompt** | The agent's prompt is built from its own workspace — `SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `MEMORY.md`. Measured against a real gateway that is ~19,000 tokens of who it is. A "you are a helpful voice assistant" from us would arrive as a second system message fighting all of it: overwriting a personality with a worse one. |
| **Conversation history** | The agent keeps the thread itself. Each call is pinned to one OpenClaw session with the `x-openclaw-session-key` header (the call id), so it keeps context across the turns of a call and two simultaneous callers never share one. Re-sending our own transcript would give it two sources of truth for one conversation. |
| **Tools** | The agent has its own, from `TOOLS.md` and its tools profile. A second, parallel tool system it knows nothing about is not help. |

If you want the agent to behave differently on the phone — shorter answers, no markdown,
because a list read aloud by TTS is noise — **put that in the agent's own workspace**, where
the rest of its instructions live. That is the honest place for it. For a quick test there is
an opt-in `voiceStyle` string that prepends one system line, but it is off by default on
purpose.

## Try it in 60 seconds

**1. Run the gateway.** OpenClaw needs Node `>=22.22.3 <23`, `>=24.15.0 <25`, or `>=25.9.0`
— v24.14 is rejected, `nvm use 24` fixes it.

```bash
openclaw gateway run
```

**2. See your agents.**

```bash
openclaw agents list
#  Agents:
#  - voice (default)
```

**3. Point the plugin at one** — the program above, with `agent: "voice"`.

**4. Call it.** With `phone` set, from a phone. Without one, from the browser: mint a WebRTC
token with `voice.agent.createToken("webrtc")` and connect with
[`@pinecall/web`](/web/core/overview).

## How a turn flows

1. The caller speaks. Pinecall's STT turns it into text and its turn detector decides they
   have finished.
2. The SDK hands you `turn.end` — this is the
   [client-side LLM](/concepts/server-vs-client-llm) path, which is why the agent is created
   with **no `llm`**: with one, the voice server would answer instead of your agent.
3. The plugin POSTs one user message to `http://127.0.0.1:18789/v1/chat/completions` with
   `model: "openclaw/voice"` and the session-key header.
4. Tokens stream back into `call.replyStream(turn)`, and Pinecall speaks them as they
   arrive.

If the caller talks over the answer, the in-flight request to the gateway is aborted with the
turn. If the gateway is down or returns an error, the caller hears a short apology instead of
dead air — a silent line reads as a dropped call.

## Known limits

**The text chat channel cannot work.** Pinecall resolves text chat with its **own
server-side LLM**: it never emits `turn.end` to the SDK, so this plugin never sees the
message and your OpenClaw agent never answers it. (Verified: a chat message to an agent
configured this way came back as *"Soy ChatGPT"*.) `chat` therefore defaults to `false`. The
client-side path this package lives on is voice — phone and WebRTC.

**The greeting is spoken by the server**, not by your agent. It is a string in the config, it
goes out the moment the call connects, and the agent is not told it happened.

## What's next

- [Server-side vs client-side LLM](/concepts/server-vs-client-llm) — the decision this
  package is one side of
- [Inbound voice](/guides/inbound-voice) — phone numbers, greetings, call lifecycle
- The package itself: [github.com/pinecall/openclaw](https://github.com/pinecall/openclaw)

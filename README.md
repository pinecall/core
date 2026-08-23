<div align="center">

# @pinecall/sdk

**Build real-time voice & messaging AI agents in TypeScript.**

WebSocket client for Pinecall Voice — ~80 KB, one dependency.

[![npm](https://img.shields.io/npm/v/@pinecall/sdk.svg?style=flat-square)](https://www.npmjs.com/package/@pinecall/sdk)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)

[**Docs**](https://docs.pinecall.io) · [**Quickstart**](https://docs.pinecall.io/quickstart) · [**API Reference**](https://docs.pinecall.io/api/pinecall) · [**Examples**](https://docs.pinecall.io/examples/headless-agent)

</div>

---

## Install

```bash
npm install @pinecall/sdk
```

> Node.js ≥ 18. Only runtime dependency: `ws`.

## 30-second example

```typescript
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall();
await pc.connect();

const mara = pc.agent("mara", {
  prompt: "You are Mara, a friendly voice assistant. Be concise.",
  llm: "openai/gpt-4.1-mini",
  voice: "elevenlabs/sarah",
  language: "es",
  phoneNumber: "+13186330963",
  greeting: "¡Hola! ¿En qué puedo ayudarte?",
});

mara.on("call.ended", (call, reason) =>
  console.log(`Call ended: ${reason} (${call.duration}s)`),
);
```

That's a production-ready voice agent. It answers calls on a phone number, speaks a greeting, runs an LLM, and talks back. No webhooks, no platform dashboard, no infra.

## Why Pinecall

Most voice AI platforms are **platform-first**: you configure agents in their dashboard, define tools as JSON schemas, and expose webhook URLs for the platform to call. Your app adapts to the platform.

Pinecall is **code-first**: the agent is your code. It runs inside your app, uses your database, calls your internal APIs, and handles tool calls as local functions. The platform adapts to your app.

- ✅ **One agent, many channels** — phone, SIP, WebRTC, chat, WhatsApp from the same instance
- ✅ **Hot-reload everything** — change voice, language, prompt, tools mid-call
- ✅ **Skills** — bundle prompt + tools + knowledge base into a capability the agent [loads on demand](https://docs.pinecall.io/guides/skills) (`loadSkill`/`unloadSkill`) — keeps the tool list small
- ✅ **Knowledge bases** — ground answers on your docs (RAG); one KB or several merged by score
- ✅ **Bring your own LLM** — or use the server-side LLM and skip the plumbing
- ✅ **Local tool calls** — no public endpoints, no webhook URLs to expose
- ✅ **Dev mode** — share a phone number between prod and any number of devs

## The Pinecall ecosystem

This package is the **server-side SDK**. The full picture includes three browser-side packages too:

| Package | What it is | When to use |
|---|---|---|
| **[`@pinecall/sdk`](https://npmjs.com/package/@pinecall/sdk)** | Server-side SDK (this repo) | Build agents in Node.js — voice, WhatsApp, phone, SIP, outbound |
| **[`@pinecall/voice-core`](https://npmjs.com/package/@pinecall/voice-core)** | WebRTC client (framework-agnostic) | Browser voice in vanilla JS, Vue, Svelte, or any framework |
| **[`@pinecall/voice-widget`](https://npmjs.com/package/@pinecall/voice-widget)** | React voice widget | Drop-in animated orb UI with multi-language + interactive tools API |
| **[`@pinecall/chat-core`](https://npmjs.com/package/@pinecall/chat-core)** | Text chat client | Browser chat over WebSocket — vanilla JS + React hook |

All four packages talk to the same Pinecall voice server. The same agent (`pc.agent("mara", ...)`) can be reached over phone, WebRTC, chat, or WhatsApp — without changing your agent code.

## Documentation

| | |
|---|---|
| 🚀 [**Quickstart**](https://docs.pinecall.io/quickstart) | Zero to first call in 5 minutes |
| 📘 [**Concepts**](https://docs.pinecall.io/concepts/agents-and-channels) | How agents, channels, and sessions fit together |
| 🛠 [**Guides**](https://docs.pinecall.io/guides/inbound-voice) | Build phone agents, WhatsApp bots, browser widgets |
| 📚 [**Server SDK API**](https://docs.pinecall.io/api/pinecall) | `@pinecall/sdk` — every class, method, event |
| 🌐 [**Voice Core**](https://docs.pinecall.io/voice-core/overview) | `@pinecall/voice-core` browser WebRTC client |
| ⚛️ [**Voice Widget**](https://docs.pinecall.io/voice-widget/overview) | `@pinecall/voice-widget` React widget + Tools API |
| 💬 [**Chat Core**](https://docs.pinecall.io/chat-core/overview) | `@pinecall/chat-core` browser chat client |
| ⚙️ [**Configuration**](https://docs.pinecall.io/reference/stt-providers) | STT, TTS, LLM providers and tuning |
| 🔒 [**Security**](https://docs.pinecall.io/security) | Token model and best practices |

## Examples

Runnable examples in [`examples/`](./examples) — `npm install`, `cp .env.example .env`, `npm start`.

> **One feature, one file.** Each folder shows ONE thing, in a single `server.mjs`, against this checkout of the SDK. Whole apps — storage, deploys, two processes — live in [`pinecall/examples`](https://github.com/pinecall/examples).

| Example | What it shows |
|---|---|
| **[`simple/`](./examples/simple)** | The smallest agent worth running — prompt, voice, calls saved to a file |
| **[`ringing/`](./examples/ringing)** | Accept or reject an inbound call before it is ever answered |
| **[`history/`](./examples/history)** | A returning caller's previous conversation, restored into the live one |
| **[`turn-detection/`](./examples/turn-detection)** | Turn events as a state machine: Flux (native) vs Nova-3 (SmartTurn + Silero) |
| **[`tools/`](./examples/tools)** | One `tool()`, and a return value that proves the model actually called it |
| **[`skills/`](./examples/skills)** | `skill()` — tools that stay latent until the model loads them |
| **[`reservations/`](./examples/reservations)** | Three tools in a fixed order: check, then confirm, then book |
| **[`phone-line/`](./examples/phone-line)** | `pc.line()` — a keypad menu decided by `if`, with no model in it |
| **[`outbound-dispatch/`](./examples/outbound-dispatch)** | `DispatchHub` — a CSV of people to ring, paced, with results written back |
| **[`whatsapp-dashboard/`](./examples/whatsapp-dashboard)** | WhatsApp with human takeover — pause the agent, answer yourself, resume |
| **[`agent-tests/`](./examples/agent-tests)** | `pinecall test` specs — chat and real voice |

📖 More in the [Examples Guide](https://docs.pinecall.io/examples).

## Browse the docs offline

All docs live in [`docs/`](./docs) as plain markdown — readable on GitHub, rendered on [docs.pinecall.io](https://docs.pinecall.io) via Mintlify.

```
docs/
├── quickstart.md
├── concepts/        # agents, channels, hot-reload, deployment
├── guides/          # how to build X (phone, WhatsApp, browser)
├── api/             # @pinecall/sdk class reference
├── voice-core/      # @pinecall/voice-core (browser WebRTC)
├── voice-widget/    # @pinecall/voice-widget (React UI)
├── chat-core/       # @pinecall/chat-core (browser chat)
├── reference/       # config tables (STT, TTS, LLM, events)
└── examples/        # complete runnable snippets
```

## Status

Pinecall SDK is used in production today. The API surface is stable; breaking changes follow semver and ship with migration notes in the changelog.

## License

MIT © [Pinecall](https://pinecall.io)

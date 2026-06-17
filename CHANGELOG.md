# Changelog

All notable changes to `@pinecall/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- **`dial({ detectTurnEnd })`** — when `true`, the server also detects the OTHER party's end-of-turn and emits `turn.end` to the initiating side. Default `false`. Enables automated callers (e.g. a test/judge agent talking to another agent) to know when to speak. Server-side: emitted on `bot.finished` with `source: "bot"`.
- **`pinecall test` voice mode** — run specs as a **real voice call** instead of text chat. New spec fields (`mode: voice`, `voice`, `stt`, `greeting`, `detectTurnEnd`, `language`) and CLI flags (`--voice <p/v>`, `--stt <prov>`, `--record <file>`, `--no-listen`, `--lang`). The judge speaks via ElevenLabs TTS over WebRTC, the call plays live on the speakers and is recorded to WAV. Needs `ELEVENLABS_API_KEY`; optional native deps `@roamhq/wrtc` + `speaker`.

## [0.2.11] — 2026-06-12

### Added

- **`pinecall kick <agent>`** — CLI command to force-disconnect an agent by slug. Calls `DELETE /api/sdk/agents/{slug}`. Use when a stale registration blocks new connections.
- **Agent conflict protection** — the server now **rejects** new connections if an agent with the same slug already has a live WebSocket (instead of silently kicking the old one). The SDK displays a clear error message: `Agent "pines" is already connected. Run pinecall kick pines to force disconnect.`
- **`AGENT_CONFLICT` error code** — new wire error code emitted when registration is rejected due to a duplicate live agent. Handled in `ErrorHandler` with a user-friendly message.
- **`agent.ws(socket)`** — WebSocket equivalent of `agent.stream()`. Pipes agent events as JSON to any WebSocket connection. Supports session scoping (`{ sessionId }`) and tool results (`{ toolResults: true }`).
- **`createEventStream(opts)`** — browser/Node.js client for consuming WebSocket event streams. Auto-reconnect, typed event handlers (`on`/`off`/`*`), and bidirectional messaging (`send()`). Supports direct URL mode (`{ url }`) for your own server or token-based mode for remote connections.
- **`"stream"` channel type** — `createToken("stream", agentId)` now accepted alongside `"webrtc"` and `"chat"`.

### Changed

- **Stale displacement preserved** — if the old agent's WebSocket is dead (failed ping probe), displacement still works automatically. Only live agents are protected.

---

## [0.2.10] — 2026-06-11

### Added

- **Auto-connect** — `new Pinecall()` now calls `connect()` internally on instantiation. The `connect()` method remains public for backward compatibility.
- **`pinecall run`** — CLI command to boot an agent from a TypeScript file. Resolves `dotenv/config`, watches for `export const agent`, and connects automatically.
- **`greeting` config** — `pc.agent()` accepts `greeting` as a string, object `{ text, addToHistory }`, or async callback `(call) => string`. Greeting is spoken on every inbound call and added to LLM history by default.
- **CLI reference docs** — `docs/reference/cli.md` documenting `pinecall run`.

### Changed

- **Docs refresh** — updated quickstart, agent API, examples index, and deployment topologies to reflect auto-connect, `pinecall run`, and greeting config.
- **`simple` example** — simplified to use `pinecall run` instead of manual server setup.

---

## [0.2.9] — 2026-06-08

### Fixed

- **Outbound call rejection** — `dial()` now properly rejects with `"busy"`, `"no-answer"`, `"failed"`, or `"canceled"` instead of timing out after 30s. Previously, calls that were rejected before connecting (no `call.started`) had their `call.ended` event silently swallowed by the lifecycle handler.

---

## [0.2.8] — 2026-06-07

### Added

- **`bot.word` event** — fires on each TTS word synchronized with audio playback. Enables live text preview.
- **`call.currentBotText`** — auto-accumulated bot text from `bot.word` events, reset on each new bot turn.
- **`bot.preview`** pattern — `bot.word` + `call.currentBotText` for real-time word-by-word display.
- **WhatsApp session** (`wa-session.ts`) — dedicated session class for WhatsApp conversations.
- **Transport types** — `call.transport` now includes `"chat"` and `"whatsapp"` in addition to `"phone"`, `"webrtc"`, `"unknown"`.
- **`greeting` config** — `pc.agent()` accepts `greeting` as string, object, or async callback.
- **Examples:**
  - `turn-detection` — per-turn bordered containers with state machine visualization and interruption highlighting.
  - `sse` — Express + React + SSE dashboard with live call cards, chat-bubble transcript, outbound dialer.
- **Docs:**
  - Turn detection guide with full state machine documentation.
  - Advanced usage section (dynamic greetings, `call.say()`, `phoneNumbers`).
  - Examples index page, STT language coverage tables.

### Changed

- **Human-in-the-loop**: `agent.pause()`, `agent.resume()`, `agent.sendMessage()` — pause the AI so a human can take over conversations.
- New events: `session.paused`, `session.resumed`.
- `whatsapp.message` event now includes `paused: boolean` field.
- `whatsapp.response` event now includes `source?: "human"` field.
- Unified LLM registry for all transports (voice, chat, WhatsApp).

### Removed

- **`pc.deploy()`** — removed entirely. Use `pc.agent()` with `channels` instead.
- `DeployConfig` type — merged into `AgentConfig`.
- `model` field — use `llm: "openai/gpt-4.1-mini"` instead.

---

## [0.2.7] — 2026-06-01

### Fixed

- Auto-reconnect no longer triggers on displacement (close code 4001). Prevents infinite reconnection loop when two instances of the same agent compete for the same slot.

---

## [0.2.3] — 2026-05-25

### Fixed

- Chat `call.toolResult()` was silently dropped — chat Calls were created with a noop send function instead of routing through the WebSocket. Tool results now reach the server correctly.

---

## [0.2.2] — 2026-05-25

### Added

- Documentation: Philosophy page, SSE Event Streaming guide, Chat Bot example.
- New docs sections: `@pinecall/voice-core`, `@pinecall/voice-widget`, `@pinecall/chat-core`.

### Changed

- Examples: simplified tool handlers from switch/case to object map pattern.
- README: minor updates.

---

## [0.2.1] — 2026-05-25

### Fixed

- WebSocket polyfill for Node.js < 22 — auto-imports `ws` when the native `WebSocket` global is missing.

---

## [0.2.0] — 2026-05-25

### Changed

- **Hexagonal architecture rewrite** — internal reorganization into Kernel, Protocol, Transport, Domain, and Dispatch layers. Zero public API changes; all 71 tests pass unchanged.
- **API consistency pass** — camelCase event names, `engine` → `provider` in LLM config, `call.toolResult()` replaces `call.sendToolResult()`, `agent.setDevCallers()` replaces `agent.setDevMode()`.

---

## [0.1.3] — 2026-05-24

### Added

- `createToken()` — REST helper for generating short-lived WebRTC/Chat tokens from your backend.
- `agent.createToken(channel)` — instance method shorthand.
- `pc.createToken(channel, agentId)` — client-level shorthand.
- `allowedOrigins` config — opt-in public token access for matching browser origins.
- `tokenProvider` support in `@pinecall/voice-widget`.

### Fixed

- `PINECALL_DEV_ID` resolution in ESM modules.
- WhatsApp channel re-registration on reconnect.

---

## [0.1.2] — 2026-05-23

### Fixed

- `session.idle_warning` emit order — now emits `(event, call)` consistently.
- `session.*` events properly routed to agent event handlers.
- `session_limits` correctly passed through `buildShortcutPayload`.
- `session.*` events no longer auto-create ghost calls.

---

## [0.1.1] — 2026-05-22

### Added

- Session Limits: `idle_timeout_seconds`, `idle_warning_seconds`, `idle_grace_seconds`, `max_duration_seconds`.
- `session.idle_warning` and `session.timeout` events.
- `booking-tools` example with Tools API + context injection demo.

### Changed

- Greeting removed from config — use `call.say()` in `call.started` handler instead.
- SSE streaming: `agent.stream()` and `pc.stream()` with multi-agent filtering.
- `pc.deploy()` shorthand for agent + channel registration (removed in unreleased — use `pc.agent()` with `channels`).

---

## [0.1.0] — 2026-05-20

### Changed

- Renamed from `@pinecall/core` to `@pinecall/sdk`.

---

## [0.0.1-beta.0] — 2026-05-18

### Added

- Initial release as `@pinecall/core`.
- `Pinecall` WebSocket client with auto-reconnection.
- `Agent` class with channel management (phone, SIP, WebRTC, mic, chat, WhatsApp).
- `Call` class with full call control (say, reply, replyStream, hangup, forward, hold, mute, DTMF).
- `ReplyStream` for token-by-token LLM streaming.
- Multi-environment support (`PINECALL_MODE`, `PINECALL_DEV_ID`, `DEV_CALLERS`).
- Server-side LLM (`llm.tool_call` event + `call.toolResult()`).
- Client-side LLM (`turn.end` event + `call.replyStream()`).
- WhatsApp channel with voice note transcription.
- REST API helpers: `fetchVoices`, `fetchPhones`, `fetchWebRTCToken`, `fetchTwilioBalance`.
- SSE streaming via `agent.stream()` and `pc.stream()`.
- Configuration shortcuts for voice (`elevenlabs:id`), STT (`deepgram-flux`), and LLM (`openai:gpt-4.1-mini`).
- Hot-reload: `agent.configure()`, `call.configure()`, `call.setPrompt()`, `call.setPromptVars()`, `call.addContext()`.
- Per-channel config overrides.
- 72 tests (Vitest).

# Changelog

All notable changes to `@pinecall/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- `pc.deploy()` shorthand for agent + channel registration in one call.

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

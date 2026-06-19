# Changelog

All notable changes to `@pinecall/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [0.2.22] — 2026-06-19

### Fixed

- **camelCase / spaced agent ids broke phone registration** — the server slugifies agent ids (lowercase + hyphens), so an agent created as `pc.agent("futbolAgent", { phoneNumber })` got `agent.created` back as `futbolagent`. The id resolver's case-insensitive fallback compared the lowered server id against the **original-case** local keys, so it never matched → `_flushPending()` never ran → the buffered `channel.add` for the phone was **never sent**. The number silently never registered and every inbound call hit `client.not_found`. The resolver now matches by **slugifying both sides** (mirroring the server), so `futbolAgent`, `My Agent`, `receptionist_bot_v2`, etc. all resolve correctly and phones register as expected.

## [0.2.21] — 2026-06-19

### Changed

- **`pinecall knowledge query`** — the `kbId` is now **optional**: with a single knowledge base it's auto-selected, so `pinecall knowledge query "<question>"` just works (pass an explicit id when you have more than one).
- **`pinecall --help`** now lists the full `knowledge` subcommands (`docs`, `get`, `query`, `rm`, `delete`) and a dedicated **Conversations** section (`conversations`, `conversations get <id>`).

## [0.2.20] — 2026-06-19

### Fixed

- **`pinecall conversations`** now prints the **full conversation id** in the list (it was truncated to 10 chars, so copy-pasting it into `conversations get <id>` 404'd). `conversations get` also accepts a short **id prefix** now and resolves it against the recent list.

## [0.2.19] — 2026-06-19

### Added

- **`pinecall conversations` CLI** — browse saved conversation transcripts (chat + voice) for your org: `conversations` (list, with `--type=chat|phone|webrtc`, `--agent=<slug>`, `--limit`), `conversations get <id>` (full transcript). Backed by the new Playground `GET /api/conversations` API. Transcripts are persisted server-side (with the client IP for chat/webrtc) and are also viewable by Pinecall staff in the platform admin.

## [0.2.18] — 2026-06-19

### Fixed

- **`pinecall run` Node v24 DEP0190 warning** — on Windows, args passed to `spawn()` with `shell: true` were concatenated without escaping, triggering a deprecation warning and potentially mangling file paths through `cmd.exe`. Now builds a single properly-quoted command string for the Windows shell, with no separate args.

## [0.2.17] — 2026-06-19

### Fixed

- **`pinecall run` on Windows** — fixed `spawn npx ENOENT` crash. Three issues: `which` → `where` for PATH lookup, `node_modules/.bin/tsx` → `tsx.cmd` for local binary detection, and added `shell: true` to `spawn()` so Windows can resolve `.cmd` shims. All platforms unaffected.

## [0.2.16] — 2026-06-18

### Changed

- **`pinecall knowledge push`** now stores each file under its **relative path** (not just the basename), so re-pushing the same files updates the existing documents in place (the server upserts by path) instead of creating duplicates. Re-running `push` to refresh a knowledge base is now idempotent.

## [0.2.15] — 2026-06-18

### Added

- **`pinecall knowledge` CLI** — manage knowledge bases from the terminal: `knowledge` (list), `knowledge create "<name>"`, `knowledge docs <kbId>`, `knowledge push <kbId> <files…>` (upload local `.md`/`.txt`), `knowledge get <kbId> <docId>`, `knowledge query <kbId> "<question>"` (retrieval-only semantic search, **no LLM**), `knowledge reindex <kbId>` (re-train), `knowledge rm <kbId> <docId>`, `knowledge delete <kbId>`. Knowledge bases are a paid feature — free-trial orgs get a clear upgrade prompt.

## [0.2.14] — 2026-06-18

### Added

- **Knowledge bases (RAG)** — `pc.agent(name, { knowledgeBase: "kb_..." })` grounds an agent on a knowledge base created in the Pinecall dashboard (new **Knowledge** section). Before every LLM turn the voice server retrieves the most relevant document chunks for the user's message and injects them into the prompt. Placement is controlled by the new **`{{RAG_CONTEXT}}`** prompt variable — include it to decide exactly where the retrieved docs go, or omit it and the context is appended automatically. Works across voice and chat. Requires sdk-server with matching support.

## [0.2.13] — 2026-06-18

### Added

- **Ephemeral tools** — `tool({ ..., ephemeral: true })` marks a tool whose result is used to generate the current reply but is **not persisted to conversation history**: it never reaches the LLM context of later turns nor the saved transcript. Use for sensitive lookups or large/noisy payloads. The server keeps the result only for the immediate generation, then prunes it (and the originating `tool_calls` entry when all its calls were ephemeral). Defaults to `false` — existing tools are unchanged. Works across voice, chat, and WhatsApp. Requires sdk-server with matching support.

## [0.2.12] — 2026-06-17

### Added

- **`agent.bridge(target, opts?)`** — place a **voice call to another Pinecall agent** (no phone, no WebRTC). The server cross-wires the two agents' audio so both run their real STT/turn-detection/TTS pipelines; the calling agent is driven manually via `call.say()` and reads the target via `user.message` / `turn.end`. Powers the voice judge.
- **`dial({ detectTurnEnd })` / `bridge({ detectTurnEnd })`** — when `true`, the server detects the OTHER party's end-of-turn and emits `turn.end` to the initiating side (on `bot.finished`, `source: "bot"`). Default `false` for `dial`, `true` for `bridge`. Lets an automated caller know when to speak.
- **`pinecall test` voice mode** — run specs as a **real voice call** instead of text chat. The judge becomes a Pinecall agent (server-rendered voice) bridged to the target. New spec fields (`mode: voice`, `voice`, `stt`, `greeting`, `detectTurnEnd`, `language`) + CLI flags (`--voice`, `--stt`, `--record`, `--no-listen`, `--lang`). The bridged call plays live on the speakers and is recorded to WAV. Needs only `PINECALL_API_KEY` + the judge LLM key (no ElevenLabs); `speaker` is an optional native dep for playback.

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

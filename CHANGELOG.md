# Changelog

All notable changes to `@pinecall/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- **`pc.line()` — a phone number you program, with no model behind it.** A
  *line* claims a number as a session owner that is not an agent: it brings up
  its own STT, TTS and turn detection, takes the inbound call first, and every
  decision it makes is plain code. `llm`, `prompt`, `tools` and `greeting` are
  refused synchronously — a line has no model, and the first model call happens
  only if the code hands the live call to an agent, or never at all.
  `PhoneLine`, `LineCall` and their types are exported from the package root.
  Requires a voice server from 2026-08-22 or later. See
  `docs/guides/phone-lines.md`.
  - `line.extensions({ "10": "sales", "20": async (call) => {…}, "*": … })` —
    a declarative routing table on the extension the caller dialled after the
    number. Runs before `line.on("call")`; `"*"` is the no-extension /
    unmatched case; no match and no `"*"` falls through to the handler.
  - `line.on("ready" | "error" | "call" | "call.ended")`, `line.ready`,
    `line.registered`, `line.calls`, `line.destroy()`. A line re-claims its
    number on reconnect, exactly like an agent re-registers.
  - `await call.say(text, { voice?, language? })` on a `LineCall` — resolves
    when the audio finished playing, `{ interrupted: true }` if the caller
    talked over it.
  - `await call.listen({ digits?, terminator?, speech?, timeout, language? })` —
    the first of the keypad, the caller's speech (opt-in) or the timeout, off
    the one session the agent will keep using. `{ by: "keypad" | "speech" |
    "timeout" }`.
  - `await call.ask(text, opts)` — `say` + `listen`, with keypresses counted
    from before the first syllable and the timeout starting when the line stops
    speaking.
  - `await call.routeTo(agent, { language?, voice?, stt?, greeting?,
    promptVars?, context?, history? })` — hands the LIVE call to an agent in
    place: no re-dial, same audio stream. `{ ok: true }`, or `{ ok: false,
    reason: "offline" | "unknown" | "no_phone_config" | "capacity" |
    "swap_failed" }` with the line still owning the call.
  - `call.context(key, value)` (survives `routeTo`), `call.hangup(reason)`,
    `call.extension`, `call.transcript` (`{ who: "caller" | "line", text, at,
    role, content }`), `call.routed`.
  - Wire: `line.create` / `line.created` / `line.error` / `line.destroy` /
    `line.destroyed`, `call.route` / `call.routed` / `call.route_failed`, and
    the `extension`, `owner`, `routed_from`, `line_transcript` fields on
    `call.started`.
  - `Call.routedFrom` / `Call.extension` / `Call.lineTranscript` on every call,
    so an agent a line routed to knows which door the caller came through and
    what was already said. `null` / `[]` on calls no line touched.
  - Example: `examples/phone-line/` — a business front line with extension
    routing, a language menu by keypad or voice, a code-only menu, a `forward`
    to a human and a `routeTo` to an agent. No `pc.agent()` anywhere.
- **`call.dtmf_received` — the caller's keypad on a live phone call.** Twilio
  already sent a `dtmf` frame on every press and the voice server had no branch
  for it, so an inbound keypress was dropped on the floor and an IVR ("press 1
  for Spanish") could not be built on a streamed call. The server now emits
  `call.dtmf_received` with `digit` (this press) and `digits` (every press so
  far on the call), and the SDK types it on both `call.on()` and `agent.on()`.
  Only the inbound track counts — echoing our own `call.dtmf` tones back as
  caller input would be a loop. Requires a voice server from 2026-08-22 or
  later. See `guides/events.md` → DTMF for a language menu built on it.

### Changed
- **`call.say()` now returns a `Promise<{ interrupted: boolean }>`** on every
  `Call`, resolving when the audio stopped coming out of the speaker
  (finished, interrupted, or the call ended under it). Non-breaking: it never
  rejects, so existing fire-and-forget `call.say(...)` keeps working and cannot
  produce an unhandled rejection.

---

## [0.12.1] — 2026-08-22 — one frame per event: no more duplicate bubbles

### Fixed
- **A call's events could be written twice on `pc.stream()`/`agent.stream()`
  and the console's `GET /events`.** A duplicated wire frame from the server
  (or a call-proxy re-emit under a race) could reach an agent listener twice
  for the same logical message; `createAgentStream`/`createMultiAgentStream`
  (`src/sse/stream.ts`) now guard every SSE connection against writing the
  same `(event, callId, messageId)` frame twice — confirmed against a real
  capture where a WebRTC call's `user.message` and `message.confirmed` each
  arrived twice with the same `messageId`. `src/cli/console/transcript-
  reducer.ts` and `ui/src/state/transcript-reducer.ts` (the web console) got
  the same idempotency guard directly, since both also consume agent events
  independently of the SSE stream: a re-sent `user.message` / `bot.finished`
  whose `(callId, messageId)` was already applied no longer produces a second
  bubble; a messageId-less `user.message` (chat) falls back to deduping on
  `callId` + text within a 2s window.

---

## [0.12.0] — 2026-08-21 — pinecall run grows a console: the terminal goes live and the browser joins in

`pinecall run` is now the whole dev loop. The terminal view shows what the
caller is saying while they say it, the agent's words as they are spoken, the
turn state and every tool call; a local web console on `127.0.0.1:4747` lets
you call the agent from the browser, watch every phone/WebRTC/chat/WhatsApp
call live and chat by text; `c` opens a chat prompt in the terminal and
`--call` makes the agent ring you. One event bus, three observers — the
terminal, the web console and whatever you build with `pc.stream()`.

### Added
- **A local web console in `pinecall run`.** The agent process now serves a
  small HTTP server (127.0.0.1:4747 by default) and prints its URL in the boot
  banner: `◉ console → http://127.0.0.1:4747   (p open · c chat · e events · q
  quit)`. It exposes the process over a frozen contract — `GET /api/agents`,
  `GET /api/calls` (live calls plus the last 50 ended, with their transcript),
  `GET /events` (SSE: a `console.hello` resync frame with `{ agents, calls }`,
  then every agent event, plus `llm.toolCall` and a synthetic `llm.toolResult`
  the public `pc.stream()` does not carry), `POST /token` and
  `POST /chat-token` (minted per request with `{ console: true }` metadata —
  the API key never reaches the page) and `POST /api/calls/:id/hangup`. The
  built web app is served from `dist/ui/` inside the installed package; a
  source checkout without it gets a page listing the endpoints instead.
- **Console flags:** `--no-ui` (`PINECALL_RUN_UI=0`), `--ui-port <n>`
  (`PINECALL_RUN_UI_PORT`, the next 10 ports are tried if it is busy),
  `--ui-host <h>` (`PINECALL_RUN_UI_HOST`) and `--open`
  (`PINECALL_RUN_OPEN=1`, opens the browser on boot).
- **Keyboard shortcuts in a TTY:** `p` opens the console, `e` turns the
  every-event debug mode on and off *at runtime*, `q` / Ctrl-C quits
  gracefully (the server closes, the client disconnects), `c` opens the
  terminal chat prompt. With stdin piped nothing is touched.
- **`@pinecall/sdk/console`** — the transcript reducer and the calls model, the
  ONE event → conversation state machine the terminal view, the console server
  and the browser app all run on. Pure, dependency-free and browser-clean
  (`CallSnapshot`, `TranscriptLine`, `createTranscriptStore`,
  `createCallsModel`).
- **A terminal chat prompt (`c`).** In a TTY, `c` opens a one-line
  `you ›` prompt pinned under the live transcript: type, Enter sends, Esc or an
  empty line closes it, Ctrl-U clears the line, backspace edits. The message
  goes out as an `llm.chat` frame on the agent's OWN socket, so the reply comes
  back as ordinary agent events (`chat.started`, `user.message`,
  `bot.speaking`) and the terminal live view, the web console and your own
  `pc.stream()` all render it with no special casing. The prompt and the
  shortcuts take turns owning stdin, so neither swallows the other's keys, and
  the transcript keeps scrolling above the prompt while you type. With several
  agents in one file, `c` asks which one (or use `--agent <id>`). Off a TTY it
  is inert — nothing is read and stdin is never touched.
- **`--call <number>` — the agent rings you.** `pinecall run agent.mjs --call
  +34600000000` (or `PINECALL_RUN_CALL`) places one outbound call through
  `agent.dial` as soon as the agent is registered server-side, with
  `{ console: true }` metadata, and the call then shows up in both observers.
  Refusals are one line with the fix: a number that is not E.164 never reaches
  the carrier, an agent with no phone channel is told to add `phoneNumber`, and
  `busy` / `no-answer` / `failed` / a plan gate come back in the carrier's own
  words instead of a stack trace.
- **`--agent <id>`** (`PINECALL_RUN_AGENT`) — which agent `c` and `--call` talk
  to when one file runs several.
- **`canCall` on `GET /api/agents`** — true exactly when the agent has a phone
  number to dial FROM, so the web console can offer a "ring me" button that
  agrees with what `--call` would do.

### Security
- The console binds loopback by default. On any other interface every request
  must carry the per-run key (`?k=…`, which then sets the `pc_console`
  cookie) or it is 401. The key is generated per run and never leaves the
  process; the API key is never sent to the page and never logged.
- **The `pinecall run` web console (`dist/ui/`).** A prebuilt single-page app
  shipped inside the package — no CDN and no second install — that the runner
  serves at `http://127.0.0.1:4747`. Three columns on the Pinecall design
  system (`@pinecall/react-theme`), light and dark: the **calls** the process
  is handling (live first, with channel, peer, state and a running timer, then
  the ones that ended with their duration and reason), the **transcript** of
  the selected call (caller left, agent right, the interim caller line
  replaced by the final, the agent's line growing word by word and marked `⏏`
  when it was cut, tool calls inline as `⚡ name(args)` → `✓ result`,
  expandable), and a **talk** panel that calls the agent from the browser over
  WebRTC or chats with it by text (`@pinecall/web`). An events drawer shows the
  raw stream — what `pinecall run --events` prints. Tokens are minted by the
  runner (`POST /token`, `POST /chat-token`): the API key never reaches the
  page. The transcript is driven by the same reducer semantics as the terminal
  live view, so the two views can never disagree.

- **Docs: [The run console](/guides/run-console).** A new guide covering what
  `pinecall run` gives you now — the terminal live view, the web console (what
  each column shows, calling the agent from the page, watching a phone call,
  the events drawer, `--ui-host 0.0.0.0` and the per-run key for testing from a
  phone), the HTTP surface, and the security model — plus **"One bus, three
  observers"**: the agent process is the subject, and the terminal view, the
  console (over `pc.stream()`) and your own code observe the same typed events,
  with a ten-line fourth observer to prove it. `reference/cli.md` gains the
  `pinecall run` flags (`--open`, `--no-ui`, `--ui-port`, `--ui-host`,
  `--events`) and keys (`p` / `c` / `e` / `q`); `build-a-live-call-app` opens
  with a pointer to the console.

### Changed
- `--no-ui` no longer means "no terminal shortcuts": with the web console off,
  `c` (chat), `e` (events) and `q` (quit) still work — only `p` has nothing to
  open.
- `src/cli/live-view.ts` no longer decides *what* was said — only how to draw
  it. The state machine moved to `src/cli/console/transcript-reducer.ts` and
  the view paints the effects it emits, so the terminal, the web console and
  the browser cannot drift. Rendered output is unchanged.
- **`pinecall run` is live.** The terminal display no longer waits for the
  finals: in a TTY the caller's line grows as words are recognised
  (`user.speaking`) and is fixed on `user.message`; the agent's line grows
  **word by word as the audio plays** (`bot.word`) and is fixed on
  `bot.finished` — or marked `⏏` on `bot.interrupted`; the turn state
  (`● listening` / `thinking` / `pause` / `speaking`) with the time since the
  call started sits on the last line, which is the only line ever redrawn, so
  scrollback stays sane. Tool calls and results stay inline; chat/WhatsApp
  agents (no audio, no words) show the reply text itself. Off a TTY (pipe, CI)
  the output is one plain line per final event with a `t+12.3s` prefix and no
  escape codes. Multi-agent files get `[agent-id]` prefixes, concurrent calls
  `[call-id]`. All rendering lives in `src/cli/live-view.ts` with an
  injectable stream; the runner only picks the mode from the environment.
- **`pinecall run --events`** (or `PINECALL_RUN_EVENTS=1`) prints every agent
  event name with a compact payload summary, in both renderers — a debug aid
  for turns that do not go the way you expect.

### Fixed
- `pinecall run` showed no `caller ›` / `agent ›` lines for a chat session
  that never sent `call.started` (`pinecall chat`, the MCP `chat` tool, any
  `llm.chat` client): the view now opens an implicit context on the first
  `user.message` / `bot.speaking`, listens to `chat.started` /
  `whatsapp.started`, and fixes a text reply once its chunks settle (300 ms)
  or the next event arrives — streamed chunks still coalesce into one line.
- `pinecall run` printed no tool calls: the display read `tool_calls` /
  `tools` off the `llm.toolCall` event, whose payload is `toolCalls` with
  JSON-string `arguments`. Now parsed and rendered as `⚡ name(args)`.

---

## [0.11.0] — 2026-08-21 — speech-to-text without a call: files, live audio, and who said what

The other half of the standalone audio stack. `pc.audio.transcribe()` turns a
file into text (with speaker labels when you ask), `pc.audio.transcribeStream()`
turns a live microphone into partials and finals over a WebSocket, and
`pinecall stt` does both from the terminal — same providers your agents listen
with (ElevenLabs Scribe, Deepgram nova-3, Soniox incl. its async diarization),
billed per minute on the same credits, free on your own provider key, no agent
and no call required.

### Added
- **`pc.audio.transcribe()`** — standalone speech-to-text, no agent and no
  call. `transcribe(input, { model?, language?, diarize?, format?, filename?,
  contentType?, signal? })` POSTs one audio file (bytes, a `Blob`/`File`, or —
  Node only — a path, read lazily) as multipart to `/v1/audio/transcriptions`
  and resolves with a `Transcription`: `requestId`, `text`, `language`,
  `duration` (seconds), plus `model`, `words[]` (`{ word, start, end,
  speaker? }`) and `segments[]` (`{ id, start, end, text, speaker? }`) with
  `format: "verbose_json"`; `format: "text"` yields the plain text. `diarize:
  true` labels speakers on words and segments. Models: `elevenlabs/scribe_v1`
  (default), `deepgram/nova-3`, `deepgram/nova-2`, `soniox/stt-async-preview`.
  Refusals arrive as the same typed `AudioApiError` as `speech()` (`status` +
  `code`: `FILE_TOO_LARGE`, `DIARIZE_UNSUPPORTED`, `INSUFFICIENT_CREDITS`, …).
  Also exported top-level as `transcribe()`, bound to nothing. Needs a voice
  server that serves the endpoint.
- **`pc.audio.transcribeStream()`** — live transcription of PCM you write.
  `transcribeStream({ model?, language?, sampleRate?, encoding?, diarize? })`
  opens `WS /v1/audio/transcriptions/stream` at once (Node only — the key
  travels in the `Authorization` header, never in the URL), buffers `write()`
  until the server says `ready`, then sends the audio as binary frames in
  order. Events `ready`, `partial` (interim text), `final` (`{ text, start?,
  end?, language?, speaker?, words? }`), `done` (`{ audioSeconds,
  billedMinutes }`), `error` (`AudioApiError`) and `close` (code); `for await
  (const item of stream)` yields the partials and finals in order and throws
  on error. `finalize()` commits what the server has heard, `end()` says
  there is no more audio and resolves on `done`, `close()` hangs up now.
  Models: `deepgram/nova-3` (default), `elevenlabs/scribe_v2_realtime`,
  `soniox/stt-rt-v5`; `sampleRate` 8000|16000 (default)|24000|48000,
  `encoding` linear16 (default)|mulaw. Also exported top-level as
  `transcribeStream()`.
- **`pinecall stt <file>` / `pinecall stt --stream`** — speech-to-text from the
  terminal over `pc.audio.transcribe()` / `transcribeStream()`. File mode:
  `--format text|json|verbose_json|srt|vtt` (default `text`; `srt`/`vtt` are
  built from the segments, or from the words in 8-word cues cut on speaker
  change), `--diarize` (`[speaker N] …` per segment — `text` fetches
  `verbose_json` under the hood), `--model`, `--lang`, `-o out`; the
  transcript goes to stdout or the file, the summary (request id, audio
  seconds, model, elapsed) and errors to stderr. Stream mode: raw s16le mono
  PCM on stdin (`sox -d -r 16000 -c 1 -b 16 -e signed -t raw - | pinecall stt
  --stream`, or the ffmpeg equivalent), `--model`, `--lang`, `--rate
  8000|16000|24000|48000`, `--diarize`; partials rewrite one line on a TTY
  stderr, every final is one line on stdout (`[speaker N] text` when
  diarized); stdin EOF or Ctrl-C ends the stream and prints the audio seconds
  and billed minutes. Refusals become the `AudioApiError` code plus a one-line
  fix (`FILE_TOO_LARGE`, `DIARIZE_UNSUPPORTED`, `INSUFFICIENT_CREDITS`, …).
- **Docs** — `guides/speech-to-text` (batch, diarization, live streaming from
  an Electron app with the capture worklet and IPC glue, choosing a model,
  errors, `pinecall stt`, raw HTTP / `openai` client); `reference/audio-api`
  gains `POST /v1/audio/transcriptions` and `WS /v1/audio/transcriptions/stream`
  (frames, close codes) plus the SDK surface; `reference/cli` gains `pinecall stt`.

---

## [0.10.0] — 2026-08-21 — speech without a call: the TTS stack on its own

The voice server's text-to-speech is now reachable **without an agent and
without a call**: one HTTP request that streams the audio back as it is
produced, with optional word timestamps. A desktop app (Electron main, Node,
anything that speaks HTTP) can read a document aloud, announce a build, or
preview a voice — using the same providers and voices your agents speak with,
billed per character on the same credits, and free of charge on your own
provider key.

### Added
- **`pinecall tts "<text>" [-o out.wav]`** — text-to-speech from the terminal
  over `pc.audio.speech()`. `--voice provider/alias` (default `elevenlabs/sarah`),
  `--model`, `--lang`, `--format pcm|wav|mp3` (inferred from the `-o` extension),
  `--rate 16000|24000`, `--words` (prints `start\tend\tword` to stderr as they
  arrive). Text from the argument or stdin; audio goes to the file or to a
  non-TTY stdout (`… --format wav | ffplay -`), never to a terminal. Ends with
  request id, characters, audio ms and elapsed on stderr; refusals print the
  `AudioApiError` code plus a one-line fix. Docs: `guides/text-to-speech` and
  `reference/audio-api`.
- **`pc.audio.speech()` / `pc.audio.voices()`** — standalone text-to-speech,
  no agent and no call. `speech({ input, voice, language?, model?, format?,
  sampleRate?, speed?, timestamps?, signal? })` POSTs `/v1/audio/speech` and
  resolves as soon as the headers arrive with a `SpeechResult`: `audio` (a
  `ReadableStream<Uint8Array>` of raw bytes as they are produced — never
  buffered), `words` (an async iterable of `{ word, start, end }` when
  `timestamps: true`), `done` (`{ characters, audioMs }`), `cancel()` (aborts
  the request and the synthesis behind it), plus `arrayBuffer()` and the
  Node-only `toFile(path)`. Refusals arrive as a typed `AudioApiError` with
  `status` + `code` (`BAD_VOICE`, `INSUFFICIENT_CREDITS`, `RATE_LIMITED`, …).
  `voices()` lists what `speech()` accepts via `GET /v1/audio/voices`. Both are
  also exported top-level as `speech()` / `fetchAudioVoices()`, bound to
  nothing. Needs a voice server that serves the endpoint.
- **`stt.turn` for Soniox** — who ends the turn. `"native"` (default) lets
  Soniox's semantic endpointing decide, as Flux does for itself; `"smart_turn"`
  keeps Soniox as transcriber and hands the turn to the local SmartTurn model.
  Typed on the new `SonioxSTTConfig`, which also exposes the `endpoint_*`
  tuning fields that were accepted but untyped. Server-side; needs a voice
  server that knows the knob.

### Removed
- **`fetchBalance`** (and its `Balance` / `FetchBalanceOptions` types) is gone
  from the public API. It was never implemented — every call threw
  `"fetchBalance is not yet implemented"` and pointed at `fetchTwilioBalance`,
  so nothing can have depended on it. `fetchTwilioBalance` is unchanged.

### Changed
- **The SDK no longer writes to `console.log` from library code.** Auto-executed
  tool calls (`🔧 tool_call …`, `⚙️`, `✅`, `❌`) and the WhatsApp session lines
  (`[wa] …`) printed on every consumer's stdout in production; they now go
  through the client's logger at `debug` level. `pinecall run` still shows tool
  calls and results — it wraps `execute` itself and never depended on those
  prints. The `/tmp/debug.log` trace in the `pinecall test` voice client is
  deleted.
- **One version constant.** `src/version.ts` is now the only place a version
  string lives; the CLI, its banner and the tap user-agent all read it, and
  tsup injects package.json's version into the shipped bundles. `npm run
  check:version` (run by `prepublishOnly`) fails if the source fallback drifts.

## [0.9.1] — 2026-08-17 — a tap that reads the right pages, and a bar that moves

### Fixed
- **`tap`'s push progress streams per document.** The push phase uploaded the
  whole batch and only then emitted its progress events, so a consumer's bar
  sat at `0/N` for the entire phase (~0.6 s × N pages) and jumped to done in
  one burst — measured live with a 39-page crawl. Each document now emits its
  `push` event as it lands; failure semantics are unchanged (one bad document
  never aborts the rest).
- **`tap` picks the pages that explain the site, not the first ones the sitemap
  exported.** A sitemap's order is export order, never a ranking: `limit=40` on
  `linear.app` indexed the first 40 `<loc>`s — almost all changelog posts — and
  left out the homepage, `/docs` and the Start Guide, so the assistant answered
  thinly about a site it had "read". Discovery now collects the whole readable
  sitemap and ranks it before the cut: path depth ascending (home first, then
  the top-level sections, then their children), the sitemap's own `<priority>`
  descending to break depth ties when it declares one, and the original
  document order as a stable final tiebreak. `<priority>` is read off the same
  `<url>` element as its `<loc>`, and `readSitemapEntries` exposes the pair. The
  discovered set, the robots/normalization/extension rules and the limit are
  unchanged — a site with fewer pages than the limit yields exactly the same
  list as before, and the link-crawl fallback (home-first by construction) is
  untouched.

## [0.9.0] — 2026-08-16 — tap a website like tapping a pine

### Added
- **Website tap — `@pinecall/sdk/tap`.** Point it at a URL and it crawls the
  site client-side (`robots.txt` → sitemap → one hop of same-site links),
  extracts each page to clean markdown with `defuddle` over `linkedom`, and
  pours it into a knowledge base through the public knowledge API. Three verbs:
  `planTap` previews and writes nothing anywhere, `tap` executes a plan against
  a KB, and `syncTap` re-taps incrementally from a `_tap-manifest.json` stored
  inside the KB itself — unchanged pages are skipped, vanished pages deleted,
  and the index rebuilt only when something moved. The manifest also records the
  crawl options the tap ran with (`limit`, and `include`/`exclude` as regex
  sources), so `syncTap` re-plans the same slice of the site instead of the
  library defaults — a site tapped with `--limit=8` syncs with 8. `syncTap`
  takes `limit`/`include`/`exclude` to override a stored one, and persists the
  override. Manifest version stays `1`: the field is optional on read, and a
  manifest written without it syncs with the defaults.
- Every long operation takes `onProgress?: (ev: TapProgress) => void`, and
  `done`/`total` are present on **every** event so a consumer can draw a
  progress bar that does not stutter.
- Politeness is the default, not an option: an identifying user agent, `robots`
  disallow honoured (a blanket `Disallow: /` yields an empty plan rather than an
  exception), 4 concurrent requests, a 15 s per-page timeout and a 100-page
  limit. Constants are exported so a UI can display the numbers.
- Client-rendered pages are **flagged, never rendered**: `needsJs` on the plan
  row when the text-to-HTML ratio falls below 0.012. There is no headless
  browser in the SDK.
- CLI: `pinecall knowledge tap <url> [kbId]` (preview table, confirmation,
  progress bar; omit the kbId and it creates a `site: <hostname>` knowledge base
  and prints its id) with `--limit=N`, `--include=`, `--exclude=`, `--dry-run`,
  `--yes` and `--no-reindex`; plus `pinecall knowledge sync <kbId>`.
- New guide: [Tap a website](docs/guides/tap.md).

`defuddle` and `linkedom` are runtime dependencies of the **subpath only** — the
package root bundle imports neither, so a caller who does not tap does not pay
for them.

## [0.8.0] — 2026-08-16 — knowledge bases stop being a CLI-only feature

### Added
- **Public knowledge base (RAG) API.** The knowledge-base REST surface, which
  until now only existed inside the CLI, is exported from the package root:
  `listKnowledgeBases`, `createKnowledgeBase`, `getKnowledgeBase`,
  `deleteKnowledgeBase`, `reindexKnowledge`, `pushDoc`, `pushDocs`, `getDoc`,
  `deleteDoc` and `queryKnowledge`, plus the `KnowledgeBase`, `KnowledgeDoc`,
  `KnowledgeDocWithText`, `KnowledgeDocInput`, `KnowledgeHit`,
  `KnowledgeApiOptions` and `PushResult` types. A build script can now create a
  knowledge base, push a folder of `.md` files (upsert by `path`, so re-running
  is idempotent), attach it to an agent and debug retrieval without shelling out
  to the CLI.
- These calls go to the **Playground** management API — `playgroundUrl`, then
  `PINECALL_PLAYGROUND_URL`, then `https://playground.pinecall.io` — with your
  org API key, not to the voice server.
- **`KnowledgeApiError`** — HTTP 402 on an org whose plan lacks knowledge bases
  surfaces as a typed, catchable error with `code === "UPGRADE_REQUIRED"`
  instead of a formatted string.
- Guide: [Knowledge bases](/guides/knowledge-bases) gained a **Programmatic API**
  section with a runnable end-to-end example.

## [0.7.0] — 2026-08-15 — memory: facts per contact, on the semantic index, out through the observer

### Added
- **`memory` on `AgentConfig`** — long-term memory per contact. After each
  reply a nano model (default `openrouter/qwen/qwen3-8b`, your OpenRouter key)
  reads the last exchange against the facts already held and returns ops —
  `add` / `update` (with `supersedes`) / `delete` — which the server applies to
  a per-contact `memory.md` on its semantic index, puts back into the prompt
  as `{{MEMORY}}`, and emits as ONE `memory.ops` event: to `agent.on(...)`, to
  the call log (cursor-replayable) and to the browser's DataChannel. Never on
  the turn's own path. `remember` / `forget` brief the extractor; `consolidate`
  picks per-turn or per-call; `contactKey` names the identity on WebRTC/chat.
- **`agent.memory`** — `get(contact)`, `search(query, { contact?, k? })`
  (per contact or across every contact of the agent), `forget(contact)`; REST
  with your API key, so a back office reads it without the agent online.
  Mirrored as `GET/DELETE /api/memory/...`.
- **`memory.ops` event** on agent and call, and the `MemoryConfig`,
  `MemoryOp`, `MemoryOpsEvent`, `MemoryFact`, `MemoryHit`, `MemoryContact`
  types.
- Guide: [Memory](/guides/memory).

## [0.6.1] — 2026-08-15 — a language switch mid-call reaches the agent

### Fixed
- **`call.language` now follows a mid-call switch.** When a browser changes
  the session's language (`VoiceSession.configure({ language })`) the server
  moves STT and TTS and emits `call.updated`; the SDK folds it into
  `call.language` before the next `call.preparing`, so a prompt localised in
  that hook stays in step with what the caller is hearing. It was fixed at the
  value the call started with.

## [0.6.0] — 2026-08-15 — the session's language, and one owner for the greeting

### Added
- **`call.language`** — the session's language as the server resolved it: the
  browser's `config.language` on WebRTC, the dialled number's channel language
  on phone, the `lang` sealed into the token on chat. It is the same value the
  server used to pick the STT/TTS language and the greeting, so an agent that
  localises its prompt from it can never disagree with what the caller hears.
- **Per-language `greeting`** — `{ en: "Hi…", es: "Hola…" }` alongside the
  existing string / `{ text }` / function forms. The server picks the entry for
  the session's language.
- **`greetingInChat`** — deliver the greeting on chat sessions too, as the
  session's first bot message (in the LLM history, so the model does not
  introduce itself again). Opt-in: most chat UIs paint their own opening line.

### Changed
- **A string or object `greeting` now travels on the wire** and the SERVER
  delivers it on every channel, instead of the SDK registering a client-side
  `call.started → call.say`. One text, one owner — the shape that was producing
  double greetings when a page or an agent also said hello. A **function**
  greeting still runs client-side (it cannot serialize) and stays voice-only.

### Fixed
- **`typecheck` was red before this release.** The chat path emitted
  `user.message` without the `messageId`, `confidence` and `turnId` its own
  event type requires. A chat message has no STT metadata, so those fields are
  now neutral rather than missing.

### Security
- Requires a server that **allowlists browser-sent session config** (`voice`,
  `language`, `stt`, `tts`, `greeting`, `flash`) and refuses `prompt`, `llm`,
  `tools`, `knowledge_base`, `skills` and `raw_prompt` from the browser — on the
  WebRTC offer and on mid-call `configure()`. Public (`allowedOrigins`) agents
  were otherwise one console line away from a replaced system prompt.

## [0.5.1] — 2026-08-13

### Fixed
- **Tools defined with Zod 4 reached the LLM with no parameters at all.** Zod 4
  renamed the discriminant the schema converter switches on — `_def.typeName`
  (`"ZodString"`) became `_def.type` (`"string"`) — so every v4 schema fell
  through the switch and `_toWire()` emitted `parameters: {}`. The model then
  called the tool with no arguments, exactly as instructed, and the SDK's own
  Zod validation rejected what the model was never told about. Found in a
  production voice agent whose five tools all failed this way: a receptionist
  that could not receive the visitor's name, and a door that could not receive
  its access code. Anything on Zod 4 was affected; nothing on Zod 3 was.
- `convertNode` now handles both formats. The Zod 4 branch maps
  `object · string · number · int · boolean · enum · array · optional ·
  nullable · default · literal · pipe`, reads `.describe()` from the schema's
  `.description` getter (v4 no longer writes `_def.description`), and converts
  the **input** side of a `.transform()`, since that is what the model has to
  produce.

### Added
- `tests/tool-wire.test.ts` — asserts the generated **wire schema** against
  **real Zod, both majors**. The existing tool tests duck-typed Zod's v3
  internals and stayed green through the entire outage; the bytes that travel
  to the LLM had no test at all.

### Added
- **Docs: `guides/project-structure.md`** — the recommended layout for a Pinecall
  app, first in the Guides nav because it is what "starting a project" routes to:
  `apps/agents/<name>/` one process per agent (`index.mjs` + `specs/` + a `.env`
  holding only `PINECALL_API_KEY`), the token endpoint beside the agent it mints
  for, `packages/` for domain code with no `@pinecall` import in it, and the web
  app as a separate deployable. Pushed to the docs knowledge base.
- **`mcp/PARITY.md`** — audit of every authenticated playground route (and the
  platform's JSON resource routes) against the MCP tools, each row either mapped
  to its tool or marked GAP with a proposed tool shape.
- **Docs: a mobile section.** `@pinecall/ionic` and `@pinecall/react-native`
  existed only as package READMEs and were invisible to the docs site and the
  knowledge base. New nav group **"@pinecall/ionic (Mobile)"** with
  `docs/mobile/ionic-overview.md` (why a native plugin instead of the webview,
  install + iOS permissions, the token endpoint, the headless `CallClient`
  store and the `useCallClient` hook, `direction: outgoing | incoming`,
  platform support and the Android `ConnectionService` notes),
  `docs/mobile/background-calls-pushkit.md` (the PushKit / VoIP-push reference
  implementation for ringing a backgrounded or killed app — paid Apple
  Developer account required) and `docs/mobile/react-native.md` (the React
  Native package: same architecture and API, no web fallback). Linked from
  `index.md` "What you can build" and the quickstart's next steps, and pushed
  to the docs knowledge base.
- **`@pinecall/sdk/log` — the Call Log contract as a subpath you can ship to a
  browser.** A call is an append-only log of entries with a per-call monotonic
  `seq`; live, late, reconnecting, replaying and history are all just cursors
  over that one log, so there is one envelope and one reducer instead of a
  shape per consumer.
  - **`LogEntry`** — the envelope (`seq`, `ts`, `type`, `data`, call/agent ids)
    and **`LOG_EVENT_TYPES`**, a **closed vocabulary**: `call.*`, `user.*`,
    `bot.*`, `turn.*`, `tool.*`, `docs.sources`, `skill`, `audio.metrics`,
    `handoff`, `supervisor`, `log.gap`, `log.caughtUp`. An entry whose `type`
    is not in the vocabulary is not an error — `isKnownLogEntry` narrows,
    `UnknownLogEntry` keeps it, so a newer server never breaks an older client.
  - **`CallLogView`** (and `createCallLogView`) — THE reducer. Entries in,
    `CallLogState` out: phase, messages, turns, tool calls, metrics, intent.
    Updates are **copy-on-write** — only the arrays and objects an entry
    actually touches are replaced, so `prev.messages !== next.messages` is a
    correct and cheap render guard for React and friends. Out-of-order and
    duplicate entries are handled by `seq`; a gap is reported, not guessed.
  - The subpath imports nothing outside `src/log/**`, has **zero runtime
    dependencies and no node builtins** — asserted by a test, not by intent —
    so it costs a browser bundle nothing but the reducer.
  - Behaviour is pinned by `fixtures/call-log-golden.json`, a fixture shared
    verbatim with `@pinecall/web`: both packages reduce the same bytes and must
    agree.
- **`createToken({ scope, callId })` — read-only observers.** `scope: "observe"`
  mints a token that can read a call log and nothing else, agent-scoped (every
  call of an agent) or narrowed to one call with `callId`. Purely additive: a
  call with neither option produces the exact URL it produced before.
- **`EventStream` resumes from a cursor instead of restarting.** `seq` IS the
  cursor, so a reconnect now asks the server for `after=<highest seq seen>` and
  the stream deduplicates anything at or below it. `after` seeds the cursor from
  one you persisted across page loads; `resume: false` opts out. A server that
  knows nothing about cursors is unaffected — the parameter is only appended on
  RE-connects, never on the first one.

### Changed
- **Docs: the call log is the documented way to observe calls.** Two new
  guides — `guides/call-log.md` (the model: envelope, `seq` cursor, the two
  logs, stream tokens with a sealed agent set, `/v1` endpoints, the
  `@pinecall/web/log` hooks) and `guides/build-a-live-call-app.md` (step by
  step: a Soniox + Mistral Small + ElevenLabs restaurant agent with a browser
  talk tab and a live phone-line dashboard). Every page that presented
  in-process SSE/WS streaming as *the* observability story (sse-streaming,
  ws-streaming, deployment-topologies, multi-tenant, events, reference/events,
  the examples, `pc.stream()`/`agent.stream()`/`call.streamSSE()` API pages)
  now says what those streams actually are — in-process taps with no cursor
  and no replay — and points dashboards at the call log. Documented the
  agent-log gotcha: in an agent log the envelope's `call` is `null` and the
  id lives in `data.call`.
- **`channel: "stream"` now means something.** The channel and its
  `/stream/token` endpoint have been in this map for a while with nothing on
  the other side; with call-log v3 on the server the minted token is the one
  the log endpoints and the observer socket actually accept. The SDK's
  channel→endpoint map is untouched — what changed is that it now leads
  somewhere. Requires a server carrying call-log v3.

### Fixed
- **`await call.setPromptVars()` (and `getHistory`, `setHistory`, `addHistory`,
  `clearHistory`, `setPrompt`, `addContext`) never resolved.** The server's
  `history.updated` / `history.data` acks carry no `agent_id`, and the SDK's
  dispatcher resolved the owning agent from exactly that field — so every ack
  was dropped before it reached the promise waiting for it, and any caller that
  awaited one of these hung forever with no error, no log, and no way to detect
  it. Acks are now routed by `call_id`, which is unambiguous across the agents
  multiplexed on one socket. **This half works against an unchanged server**, so
  the hang is fixed the moment the SDK is upgraded.
- **Concurrent history requests could resolve each other.** They all key on the
  event name `history.updated`, so a second request overwrote the first one's
  resolver in the pending map. Requests now carry a `request_id` that a current
  server echoes; correlation falls back to the event name for older servers.
- **A request that is never answered now rejects** (`REQUEST_TIMEOUT`, 10s)
  instead of leaving a promise pending forever, and a server that refuses one
  rejects with `REQUEST_REJECTED`. Fire-and-forget callers are unaffected: the
  returned promise is internally marked as handled, so an unawaited rejection
  cannot take the process down.

### Added
- **`preparing` — an opt-in budget for the pre-turn hook, and a loud failure
  when it is missed.** `call.preparing` fires before every generation and the
  server holds the turn while your handler runs; that wait was a fixed 150 ms
  charged to *every* agent whether or not it had a handler, and its expiry was
  silent. From a host 172 ms away (measured, one real deployment) the race was
  lost on **every single turn** and the app rendered its prompt with the
  previous turn's values, forever, without a single log line.

  ```ts
  pc.agent("front-desk", { preparing: true });                 // 1500ms budget
  pc.agent("front-desk", { preparing: { timeoutMs: 2500 } });  // your own, max 5000
  pc.agent("front-desk", { preparing: false });                // never wait at all
  ```

  - The SDK now **awaits what your handler returns** and answers the server
    `llm.ready` when it settles, so the turn resumes the instant you are done —
    the budget is a ceiling, not a delay. Make the handler `async` and `await`
    your `setPromptVars` and it is guaranteed to land on *this* generation.
  - Omitting `preparing` keeps the exact previous behaviour; the server also
    stops waiting after a few turns with no answer, which reclaims the 150 ms
    for the majority of agents, which have no `call.preparing` handler at all.
  - New **`call.preparingTimeout`** event (on the `Call` and the `Agent`) with
    `turn`, `waitedMs` and `budgetMs`, plus a logged warning. Opted-in agents
    only.
  - Requires a server with the matching change for the budget and the event; an
    older server ignores the field and keeps its 150 ms wait.
- **`agent.ready` / `agent.registered` — the registration ack is now observable.**
  `pc.agent()` returns synchronously and only *queues* `agent.create` on the
  socket, so until now a caller had no way to know when the agent actually
  existed server-side. `agent.ready` is a `Promise<void>` that resolves on the
  server's `agent.created` / `agent.resumed`, rejects with `AgentConflictError`
  on a terminal conflict, and goes back to pending if the socket drops (it
  resolves again once the reconnect re-registers the agent). `agent.registered`
  is the boolean form.
- **`ServerAtCapacityError` — a full server no longer masquerades as a broken
  agent.** When the voice server's `max_clients` ceiling refuses a registration
  it now sends `code: "SERVER_AT_CAPACITY"` with `used` / `limit`, and the SDK
  rejects `agent.ready` (and emits on the client's `error` event) with a typed
  `ServerAtCapacityError` carrying the server's message verbatim plus the slot
  counts. Previously the refusal arrived as a nondescript `REGISTRATION_ERROR`
  and the only visible symptom was the *token mint* answering
  `Agent '<id>' is not online` — a claim about the agent when the truth was
  about the server. It is not a name conflict, so it does not enter the
  `AGENT_CONFLICT` retry backoff. Requires a server with the matching change;
  older servers keep the old generic behaviour.

### Fixed
- **`createToken()` no longer races the registration it depends on.** Registering
  an agent and minting a token for it in the next statement sent an HTTP request
  that overtook the still-in-flight `agent.create` WebSocket frame, and the
  server correctly answered `404 Agent '<id>' is not online` for a registration
  that was valid and healthy — the mint had simply arrived first. `pc.createToken()`
  (and `agent.createToken()`, which delegates to it) now awaits the agent's
  registration ack when the agent belongs to this client; agents owned by another
  process are minted straight through as before. The wait ends the moment the ack
  arrives — no fixed delay — and if the agent is never registered the mint fails
  with `AGENT_NOT_REGISTERED` / `AgentConflictError` instead of returning a token
  that would 404. Server-side unchanged: no coordinated deploy.

---

## [0.4.0] — 2026-08-11 — The Call Log

### Added
- **`@pinecall/sdk/log` — the Call Log contract as a subpath you can ship to a
  browser.** A call is an append-only log of entries with a per-call monotonic
  `seq`; live, late, reconnecting, replaying and history are all just cursors
  over that one log, so there is one envelope and one reducer instead of a
  shape per consumer.
  - **`LogEntry`** — the envelope (`seq`, `ts`, `type`, `data`, call/agent ids)
    and **`LOG_EVENT_TYPES`**, a **closed vocabulary**: `call.*`, `user.*`,
    `bot.*`, `turn.*`, `tool.*`, `docs.sources`, `skill`, `audio.metrics`,
    `handoff`, `supervisor`, `log.gap`, `log.caughtUp`. An entry whose `type`
    is not in the vocabulary is not an error — `isKnownLogEntry` narrows,
    `UnknownLogEntry` keeps it, so a newer server never breaks an older client.
  - **`CallLogView`** (and `createCallLogView`) — THE reducer. Entries in,
    `CallLogState` out: phase, messages, turns, tool calls, metrics, intent.
    Updates are **copy-on-write** — only the arrays and objects an entry
    actually touches are replaced, so `prev.messages !== next.messages` is a
    correct and cheap render guard for React and friends. Out-of-order and
    duplicate entries are handled by `seq`; a gap is reported, not guessed.
  - The subpath imports nothing outside `src/log/**`, has **zero runtime
    dependencies and no node builtins** — asserted by a test, not by intent —
    so it costs a browser bundle nothing but the reducer.
  - Behaviour is pinned by `fixtures/call-log-golden.json`, a fixture shared
    verbatim with `@pinecall/web`: both packages reduce the same bytes and must
    agree.
- **`createToken({ scope, callId })` — read-only observers.** `scope: "observe"`
  mints a token that can read a call log and nothing else, agent-scoped (every
  call of an agent) or narrowed to one call with `callId`. Purely additive: a
  call with neither option produces the exact URL it produced before.
- **`EventStream` resumes from a cursor instead of restarting.** `seq` IS the
  cursor, so a reconnect now asks the server for `after=<highest seq seen>` and
  the stream deduplicates anything at or below it. `after` seeds the cursor from
  one you persisted across page loads; `resume: false` opts out. A server that
  knows nothing about cursors is unaffected — the parameter is only appended on
  RE-connects, never on the first one.

### Changed
- **`channel: "stream"` now means something.** The channel and its
  `/stream/token` endpoint have been in this map for a while with nothing on
  the other side; with call-log v3 on the server the minted token is the one
  the log endpoints and the observer socket actually accept. The SDK's
  channel→endpoint map is untouched — what changed is that it now leads
  somewhere. Requires a server carrying call-log v3.

---

## [0.3.3] — 2026-07-30 — Registration conflicts end

### Added
- **`AgentConflictError` — a registration conflict now has a TERMINAL state.**
  Retrying a name that a live process legitimately owns is a storm, not
  persistence, so the SDK now stops and says so:
  - the server emits the new **`AGENT_CONFLICT_FATAL`** code (with
    `holder_alive: true`) when its liveness probe *confirmed* the holder alive
    — the SDK stops on the spot, no retry;
  - a plain `AGENT_CONFLICT` is retried only while a stale registration could
    still plausibly clear: a **total budget of 90s** (2× the server's 45s
    stale-registration window, derived from `SERVER_LIVENESS_WINDOW_MS`) for
    the whole episode, not a per-attempt cap. Exhausting it fails with the same
    terminal error;
  - `holder_alive: false` still resets to fast retries and restarts the budget;
  - the failure is programmatic, not just a log line: an `AgentConflictError`
    (`agentId`, `reason: "server_fatal" | "retry_budget_exhausted"`, code
    `AGENT_CONFLICT_FATAL`) is emitted on the client's `error` event.
  Compatible both ways, no coordinated deploy: an old SDK never sees the fatal
  code and falls through to its existing `AGENT_CONFLICT` branch; a new SDK
  against an old server applies the 90s budget on its own.

### Fixed
- **Registration conflicts no longer storm the server when the name is
  actively held.** The 0.3.2 retry existed for STALE registrations (the server
  frees those in ~1 min), but when a second LIVE process legitimately owns the
  agent name, the constant-cadence retry re-shipped the full `agent.create`
  payload (prompt, tools — tens of KB) every ~20-40s for hours. The SDK now
  honors the server's structured rejection (`retry_after_s`, `holder_alive`):
  - `holder_alive: true` → backoff grows toward a **10-minute cap** (with ±15%
    jitter) instead of the 60s stale cap;
  - `holder_alive: false` → retries reset to **fast** (the holder died, the
    name is about to free up);
  - the human-facing "already connected — run `pinecall kick <agent>`" banner
    is printed **once per conflict episode** instead of on every attempt, and a
    success after retries logs how many it took.
  Fully backward compatible: against an old server (no hints) the legacy
  5s→60s backoff applies, now with jitter; an old SDK against the new server
  simply ignores the extra error fields.

## [0.3.2] — 2026-07-25

### Fixed
- **Agent registration no longer gives up on `AGENT_CONFLICT` / `AGENT_IN_USE`.**
  The SDK now retries the registration with backoff (5s → 10s → 20s → 40s, then
  every 60s) until the server accepts it, and clears the retry on
  `agent.created` / `agent.resumed`. Previously a single rejection was terminal:
  the process stayed up and healthy while the agent was silently offline
  forever, so a momentary conflict became an outage that only a human could
  notice and fix.

  This is the client half of a two-sided fix. The server (sdk-server) used to
  treat "a `send()` on the old socket didn't throw" as proof the old agent was
  alive — but writing to a half-open TCP socket succeeds long after the peer is
  gone, so registrations orphaned by a network blip or a restart were held
  forever and every reconnect was rejected. The server now tracks the last
  inbound frame per connection and demands a real ping round-trip before
  declaring a silent connection alive; stale registrations are released within
  about a minute.

  Together: an agent that loses its connection comes back **unattended**.
  `pinecall kick` is now only for a genuinely live duplicate instance.

## [0.3.1] — 2026-07-10

### Added
- **`timezone` in AgentConfig** — built-in `{{date}}`/`{{time}}`/`{{day}}`/
  `{{datetime}}`/`{{date_block}}` vars resolve in the agent's IANA zone on every
  transport (voice/chat/whatsapp), no per-turn `setPromptVars` round-trip.
  Was UTC-only before.
- **`sendMessage` accepts a contact** — enables human sends after session GC;
  the server falls back to direct channel delivery.
- **`tool()` `noFollowup` option** — UI-only tools skip the follow-up assistant
  turn (pairs with the sdk-server change that honors `no_followup`).

## [0.3.0] — 2026-06-29

### Added
- **`promptVars` at registration** — seed default `{{vars}}` agent-level, so
  every session starts with them without a `setPromptVars` call.

## [0.2.27] - 2026-06-22

### Added

- **`rawPrompt` + channel-aware house style** — by default (`rawPrompt: false`) the
  server augments your `prompt` with style guidance tuned to the channel so agents
  work well out of the box: **voice** (phone/WebRTC) answers like a spoken phone
  receptionist (no markdown/emojis — it's read aloud by TTS); **chat** uses common
  Markdown + tasteful emojis; **WhatsApp** uses WhatsApp's own formatting
  (`*bold*`, `_italic_`, `~strike~`, ` ```mono``` `). When the agent has `skills`,
  a note on using `loadSkill` / `unloadSkill` is injected too. Set `rawPrompt: true`
  to disable all injection and use the prompt verbatim.
- **Skills (`skill()`)** — bundle a prompt fragment + tools + a knowledge base
  into a named capability the LLM loads and unloads on demand (progressive
  disclosure). Declare with `skills: [booking, billing]` in `pc.agent()` (or
  `agent.skill(...)` at runtime). The model arrives seeing only global tools plus
  auto-generated `loadSkill` / `unloadSkill` meta-tools; a skill's tools,
  instructions and knowledge base reach the model only once it's active. Strict
  disclosure keeps the prompt and tool list small. Activation modes: `"model"`
  (default, LLM-driven), `"manual"` (`call.loadSkill(name)` / `call.unloadSkill(name)`,
  plus `call.activeSkills`), or `"always"` (pinned). RAG over multiple active
  knowledge bases is merged by score. New events `skill.loaded` / `skill.unloaded`
  fire on the call and agent.
- **Mid-call tool hot-reload fixed** — `agent.update({ tools })` and
  `call.update({ ... })` now actually apply tool/skill/prompt changes to the live
  call (previously the server dropped the `llm` block mid-call, and the SDK kept a
  stale tool list that replied "Unknown tool" to freshly added tools).
- **`fetchModelAccess` / `hasModelAccess` / `fetchModelCatalog`** — check whether the
  org can use an STT/TTS/LLM model (plan + managed/BYOK gates) before configuring an
  agent, via `GET /api/models/access`. Returns `{allowed, reason, managed, planAllowed,
  hasKey, requiresKey}`.
- **New STT/TTS/LLM providers (BYOK-only)** documented in the provider reference:
  STT — Cartesia Ink-Whisper, ElevenLabs Scribe, AssemblyAI; TTS — Rime; LLM —
  xAI Grok, Groq, Cerebras, DeepSeek, OpenRouter. These require your own API key
  (saved under Provider Keys); configuring one without a key is rejected at agent
  registration with `PROVIDER_KEY_REQUIRED`, and BYOK usage is billed by the
  provider directly (not deducted from Pinecall credits). The managed providers
  (no key needed) remain: Deepgram/Gladia/Transcribe (STT), ElevenLabs/Cartesia/
  Polly (TTS), OpenAI/Anthropic/Google/Mistral (LLM).

### Changed

- Docs: Gemini default updated to `gemini-2.5-flash` (`gemini-2.0-flash` retired).

## [0.2.26] — 2026-06-21

### Added
- **`fetchModelAccess` / `hasModelAccess` / `fetchModelCatalog`** first shipped
  here (the fuller description above under 0.2.27 covers them) — model-access
  SDK helper + `GET /api/models/access` endpoint docs.

## [0.2.25] — 2026-06-20

### Added

- **`createToken(channel, agentId, metadata?)`** — optional sealed session
  `metadata` baked into a browser token. Trusted server-side (the browser cannot
  forge or alter it) and surfaces as `call.metadata`. Useful for multi-tenant /
  per-user context on `webrtc`/`chat`/`stream` tokens.

## [0.2.24] — 2026-06-19

### Added

- **`flash: true` agent-config flag** — opt out of the multilingual auto-default
  and keep the faster/cheaper `eleven_flash_v2_5` on a non-English agent (e.g.
  `{ language: "es", flash: true }`). Sibling of `language`; ElevenLabs-only;
  no-op for English; an explicit `voice: { model }` always wins over it. Also
  available per-channel (`phoneNumbers: [{ number, language, flash: true }]`).

## [0.2.23] — 2026-06-19

### Fixed

- **`pinecall voices` no longer requires an API key** — voice browsing is a public
  discovery command, but the CLI errored with "Missing API key" before reaching
  it. It now runs anonymously and only sends auth when a key is present (no more
  literal `Bearer undefined`).
- **`/api/sdk/voices` ignored the `language` filter** — the server had no
  `language` query param, so `?language=es` returned unfiltered (English) voices.
  Added server-side filtering; `fetchVoices({ language })` and `pinecall voices
  --language=es` now pass it through (a client-side filter is kept as a fallback
  for older servers).

### Changed

- **ElevenLabs TTS model is now auto-selected by `language`** — non-English agents
  (e.g. `language: "es"`) default to `eleven_multilingual_v2` instead of
  `eleven_flash_v2_5`. Flash/Turbo don't normalize text, so Spanish & other
  languages mispronounced numbers, dates, currency and abbreviations. The
  multilingual model reads them naturally. English is unchanged (still flash).
  Pin a model explicitly with `voice: { ..., model: "eleven_flash_v2_5" }` to opt
  out. `eleven_multilingual_v2` bills at a higher rate (100 vs 50 credits/1k chars).

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

## [0.2.6] — 2026-05-31

### Added

- **`agent.dial()` auto-resolves `from`** — optional when the agent has exactly
  one phone channel; errors clearly if there are 0 or more than 1 without an
  explicit `from`.

---

## [0.2.5] — 2026-05-31

### Added

- **`call.streamSSE(res)`** — one-liner for Call Me endpoints. Handles SSE
  headers, word-by-word buffering, keepalive pings, event scoping, and cleanup
  automatically.

---

## [0.2.4] — 2026-05-31

### Added

- **`tool()`** — declarative tool definitions with Zod schema + auto-execution,
  replacing hand-rolled JSON-schema tool wiring.

### Changed

- Voice-widget docs rewritten for ContactHub, chat, Call Me, multi-channel,
  mobile fullscreen, and the `tools` prop.

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

## [0.1.4] — 2026-05-24

### Added

- **`tokenProvider`** option for token-based auth flows (see the booking-tools
  example's `/api/token` endpoint).

### Fixed

- `agent.createToken()` no longer double-applies the dev prefix (`_createTokenRaw`).
- WhatsApp channel re-registration on reconnect (`phoneNumberId`, `accessToken`).

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

---
title: "CLI"
description: "Inspect agents, chat, test with specs, browse voices, and manage billing from the terminal."
---

The `pinecall` CLI is built into `@pinecall/sdk` — no extra package needed. It lets you inspect your live Pinecall environment and interact with agents from the terminal.

## Installation

The CLI ships with the SDK. Install globally:

```bash
npm install -g @pinecall/sdk
```

Or if you have the SDK linked locally:

```bash
cd sdk && npm run build && npm link
```

## Authentication

The CLI requires a Pinecall API key. Set it via environment variable or flag:

```bash
# Environment variable (recommended)
export PINECALL_API_KEY="pk_your_key_here"

# Or per-command flag
pinecall agents --api-key=pk_your_key_here
```

You can also override the server URL:

```bash
# Environment variable
export PINECALL_URL="http://localhost:1337"

# Or per-command flag
pinecall agents --server=http://localhost:1337
```

## Commands

Every command at a glance (run `pinecall --help` for the same list):

| Command | What it does |
|---------|--------------|
| `pinecall run <file>` | Run an agent file with a live terminal display |
| `pinecall agents` | List currently-connected agents |
| `pinecall kick <agent>` | Force-disconnect an agent by slug |
| `pinecall chat [agent]` | Interactive text chat with a connected agent |
| `pinecall test <path>` | Run agent specs (text or real-voice mode) |
| `pinecall phones` | List phone numbers |
| `pinecall phone request` / `search` | Provision / search managed numbers |
| `pinecall voices` | List TTS voices (`voices play` to preview) |
| `pinecall tts "<text>"` | Text-to-speech to a file (`-o`) or stdout; `--words` for timestamps |
| `pinecall stt <file>` / `--stream` | Speech-to-text from a file (text/json/srt/vtt, `--diarize`) or live PCM on stdin |
| `pinecall calls` | Call history (duration, credits, cost) |
| `pinecall conversations` | List saved conversation transcripts (`conversations get <id>` for one) |
| `pinecall usage` | Credit usage breakdown (alias of `account usage`) |
| `pinecall balance` | Current credit balance |
| `pinecall knowledge …` | Manage knowledge bases (list/create/docs/push/get/query/reindex/rm/delete) |
| `pinecall account` | Org overview; `account keys`, `account usage` |
| `pinecall twilio …` | Linked Twilio accounts (link/import/unlink) |
| `pinecall signup` | Create a new organization |

**Global flags:** `--api-key=pk_…`, `--server=URL`, `--playground=URL`, `--json`, `-h/--help`, `-v/--version`.

### `pinecall run <file>`

Run an agent file with a live terminal display **and a local web console**. The primary way to develop and test agents.

```bash
pinecall run agent/index.ts
pinecall run agent/index.js
pinecall run agent/index.ts --events   # debug: print every event
pinecall run agent/index.ts --open     # open the web console in the browser
pinecall run agent/index.ts --no-ui    # terminal only
```

**Flags**

| Flag | Env | What it does |
|------|-----|--------------|
| `--events` | `PINECALL_RUN_EVENTS=1` | print every event name + payload summary |
| `--open` | `PINECALL_RUN_OPEN=1` | open the console in the default browser on boot |
| `--no-ui` | `PINECALL_RUN_UI=0` | do not start the web console |
| `--ui-port <n>` | `PINECALL_RUN_UI_PORT` | console port (default `4747`; the next 10 are tried if busy) |
| `--ui-host <h>` | `PINECALL_RUN_UI_HOST` | console interface (default `127.0.0.1`) |

The flag wins over the environment variable. Global flags (`--api-key`, `--server`, `--json`, …) apply as usual.

**Keys** (in a TTY, while the agent runs)

| Key | What it does |
|-----|--------------|
| `p` | open the console in the browser |
| `c` | terminal chat — not yet; points you at the console's chat tab |
| `e` | toggle event printing on and off, live |
| `q` | quit — closes the console, disconnects, restores the terminal (so does `Ctrl-C`) |

```
  ⚡ booting pines  ·  gpt-5.4-nano · cartesia/sonic
  ⚙ tools: checkAvailability, makeReservation, cancelReservation
  ☎ listening on +14155550177 …

  ☎  incoming call — +14155550177 · phone — 14:02:11
  caller › Hey, I'd like to reserve a table for Friday.
  pines  › Of course! How many guests?
  caller › Two, around seven.
          ⚡ checkAvailability(date: "2026-06-13", time: "19:00", partySize: 2)
          ✓ available: true, table: "window"
  pines  › Great news — a window table at 7 is free. Shall I book it?
  caller › Yes pl                                       · ● listening t+24.1s
```

In a terminal the last line is **live** and is redrawn in place while everything above it is fixed:

- the caller's line grows as words are recognised (`user.speaking`) and is fixed when the turn's final text arrives (`user.message`);
- the agent's line grows **word by word as the audio is heard** (`bot.word`) and is fixed on `bot.finished`. A barge-in (`bot.interrupted`) fixes what was actually said and marks it `⏏`. Chat and WhatsApp agents have no audio, so there the reply text itself is the line;
- the turn state — `● listening` / `● thinking` / `● pause` / `● speaking` — sits at the end of the live line with the time since the call started;
- tool calls (`⚡ name(args)`) and their results (`✓ …`) stay inline, in order;
- call start and end keep their own lines, the end with the duration.

A session that never announces itself — `pinecall chat`, the MCP `chat` tool, any `llm.chat` client — renders the same way (`☎  session — chat`): the reply text is fixed once its chunks stop arriving (300 ms) or on the next event. Only the last line is ever redrawn, so scrollback stays readable. With several agents in one file lines are prefixed `[agent-id]`; with several concurrent calls, `[call-id]` too.

**Not a TTY** (piped, CI, `| tee`): no cursor movement and no escape codes — one line per final event, prefixed with the time since the call started. Interim speech and turn state are not printed.

```
  t+0.0s   ☎  incoming call — +14155550177 · phone
  t+2.0s   caller › Hey, I'd like a table for two.
  t+3.5s   pines  › Of course! How many guests?
  t+4.0s   ☎  call ended — hangup (12s)
```

**Debug mode:** `--events` (or `PINECALL_RUN_EVENTS=1`) additionally prints every event the agent emits — name plus a compact payload summary — in both modes. Useful when a turn does not go the way you expect:

```
  t+1.2s · speech.started {turnId:1,confidence:0.92,timestamp:1755…}
  t+1.5s · user.speaking {messageId:"u1",text:"Hey",confidence:0.8}
  t+2.0s · turn.end {turnId:1}
```

`NO_COLOR` disables colours. Uses `tsx` for `.ts` files, `node` for `.js`. Sets `PINECALL_CLI_RUN=1` which triggers the SDK's built-in runner display (boot banner, live transcript, tool call formatting). The agent file needs zero changes — `pinecall run` just adds the terminal UI.

**The web console.** The same process also serves a local web app — the banner prints its URL:

```
  ◉ console → http://127.0.0.1:4747   (p open · c chat · e events · q quit)
```

Calls the process is handling (live and recent), the selected call's transcript growing word by word with tools inline, an events drawer, and a panel that **calls the agent from the browser over WebRTC** or chats with it by text. It binds `127.0.0.1`; on any other host (`--ui-host 0.0.0.0`) every request needs the per-run key printed in the banner (`?k=…`). Tokens are minted by the runner — your API key never reaches the page. Full walkthrough: [The run console](/guides/run-console).

> **Convention:** Agent code lives in `agent/index.ts` (or `.js`), tools in `agent/tools.ts`. Export the agent: `export const agent = pc.agent(...)`.

### `pinecall agents`

List all currently connected agents with their phone numbers and channel types.

```bash
pinecall agents
```

```
  Agent         Phones        Channels
  ────────────  ────────────  ─────────────────────────────
  florencia     +13186330963  phone, webrtc, chat, whatsapp
  clara         +14258423349  phone, webrtc, chat
  mara          +17438373786  webrtc, phone

  3 agents connected
```

> **Note:** This shows **live in-memory state** — only agents that are currently connected to the voice server appear here.

### `pinecall kick <agent>`

Force-disconnect an agent by slug. Useful when an agent process crashed or was killed without cleanly disconnecting, leaving a stale registration that blocks new connections.

```bash
pinecall kick pines
```

```
  ⚡ pines disconnected
```

**Why you need this:** The server protects production agents from accidental displacement — if you try to connect a new agent with the same slug while the old one is still alive, the new connection is **rejected** with an `AGENT_CONFLICT` error.

```
  ✗ Agent "pines" is held by a LIVE process — not retrying.
    Run pinecall kick pines to disconnect the current holder,
    or register this agent under a different id.
```

> **You usually don't need to kick.** The server only counts a registration as "alive" if its socket produced a frame in the last 45s **or** answers a ping round-trip. A registration orphaned by a crash, a restart or a network blip is released within about a minute, and the SDK retries by itself in the meantime — your agent reconnects unattended.
>
> **A conflict now has a terminal state.** When the server's liveness probe *confirms* a live holder it answers `AGENT_CONFLICT_FATAL` and the SDK **stops immediately** — retrying cannot change the answer. Even without that (older server), retries are bounded by a **total budget of 90 seconds** (2× the server's 45s stale-registration window); when it runs out the SDK fails with the same terminal error instead of retrying forever. Either way you get one clear message naming the two ways out, and an `AgentConflictError` on the client's `error` event you can catch:
>
> ```ts
> import { AgentConflictError } from "@pinecall/sdk";
> pc.on("error", (err) => {
>     if (err instanceof AgentConflictError) {
>         console.error(`${err.agentId} is taken (${err.reason})`);
>         process.exit(1);
>     }
> });
> ```
>
> Reach for `kick` when a **genuinely live** second process owns the slug (two deployments of the same agent) — or, better, give your second process a different agent id (e.g. a `dev-` prefix), which never fights production for the name.

> **Note:** `kick` sends an `agent.displaced` event to the old agent's WebSocket before unregistering it. If the process is still running, it will receive the event and can handle cleanup.

### `pinecall phones`

List phone numbers from your organization. Merges two sources:
- **db** — numbers registered in the Pinecall database
- **live** — numbers claimed by currently connected agents

```bash
pinecall phones
```

```
  Phone         Name            Agent          Source
  ────────────  ──────────────  ─────────────  ──────
  +13186330963  (318) 633-0963  florencia      db
  +14258423349  (425) 842-3349  clara          db
  +13049709763  (304) 970-9763  — (available)  db
  +17438373786  —               mara           live

  4 phone numbers (3 db, 1 live), 1 available
```

### `pinecall voices`

Browse available TTS voices. Without flags, shows a discovery overview.

```bash
pinecall voices
```

```
  Voice Catalog

  Provider      Voices  Languages
  ──────────    ──────  ─────────────────────────
  elevenlabs    142     ar, cs, el, en, es, hi, it, pt
  cartesia      100     ar, de, en, es, fr, ko, pt, sv

  Usage

  $ pinecall voices --provider=elevenlabs
  $ pinecall voices --provider=elevenlabs --language=es
  $ pinecall voices play elevenlabs/sarah

  In your agent: voice: "elevenlabs/sarah"
```

#### Listing voices

Use `--provider` and `--language` to filter:

```bash
pinecall voices --provider=elevenlabs --language=es
```

```
  elevenlabs voices (es)

     Voice                  Description                  Lang
  ─  ─────                  ───────────                  ────
  ♂  elevenlabs/agustin     Conversational & Relaxed     es
  ♂  elevenlabs/antonio     Confident Conversational…    es
  ♀  elevenlabs/carolina    Spanish woman                es
  ♀  elevenlabs/daniela     Young and Talkative          es
  ♀  elevenlabs/fran        Fresh & Upbeat               es
  ...

  41 voices · pinecall voices play <voice>
```

#### Playing voice previews

Preview any voice directly in the terminal:

```bash
pinecall voices play elevenlabs/sarah
```

```
  ▶ elevenlabs/sarah
  Sarah - Mature, Reassuring, Confident
  ♀ female · en · Mature, Reassuring, Confident

  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 2.5s

  Use in your agent: voice: "elevenlabs/sarah"
```

The audio plays through your system speakers with a real-time progress bar. Works on macOS (afplay) and Linux (mpv).

### `pinecall tts`

Synthesize speech from text — no agent, no call — through [`pc.audio.speech()`](/guides/text-to-speech).

```bash
pinecall tts "<text>" [--voice elevenlabs/sarah] [--model provider/model] [--lang es]
                      [--format pcm|wav|mp3] [--rate 16000|24000] [-o out.wav] [--words]
```

```bash
pinecall tts "Hola, tu pedido está listo." --voice elevenlabs/sarah --lang es -o listo.wav
echo "Build finished" | pinecall tts -o done.mp3                    # text from stdin
pinecall tts "Testing" --format wav | ffplay -nodisp -autoexit -    # raw bytes to a pipe
pinecall tts "Twinkle twinkle" --words -o t.pcm                      # word timestamps on stderr
```

| Flag | Meaning |
|---|---|
| `--voice <provider/alias>` | Voice — default `elevenlabs/sarah`; browse with `pinecall voices` |
| `--model <provider/model>` | TTS model; `provider/auto` or omit to pick by language |
| `--lang <code>` | ISO-639-1 language, e.g. `es` |
| `--format pcm\|wav\|mp3` | Default: `wav` for `-o *.wav`, `mp3` for `*.mp3`, else `pcm` (s16le mono) |
| `--rate 16000\|24000` | Sample rate for pcm/wav (default 16000) |
| `-o <file>` | Write the audio to a file |
| `--words` | Request word timestamps; prints `start<TAB>end<TAB>word` lines to stderr as they arrive |

- Text comes from the argument or, when absent, from stdin.
- Without `-o` the raw bytes go to stdout **only if stdout is not a TTY**; on a
  terminal the command prints usage and refuses — audio is never dumped to a
  terminal.
- Everything that is not audio goes to stderr: the timestamps, the closing
  summary (`✓ listo.wav · wav 16000 Hz · 31 chars · 1840 ms audio · 910 ms · req_…`)
  and errors — the `AudioApiError` code plus a one-line fix (402 →
  "top up credits / upgrade at platform.pinecall.io").

### `pinecall stt`

Transcribe an audio file, or a live PCM stream on stdin — no agent, no call —
through [`pc.audio.transcribe()` / `pc.audio.transcribeStream()`](/guides/speech-to-text).

```bash
pinecall stt <file> [--model provider/model] [--lang es] [--diarize]
                    [--format text|json|verbose_json|srt|vtt] [-o out]
pinecall stt --stream [--model deepgram/nova-3] [--lang es] [--rate 16000] [--diarize]   # raw s16le mono PCM on stdin
```

```bash
pinecall stt meeting.m4a                                    # plain text on stdout
pinecall stt call.wav --diarize                             # [speaker 0] … / [speaker 1] … per segment
pinecall stt talk.mp3 --format srt -o talk.srt              # subtitles from the segments (srt | vtt)
pinecall stt memo.wav --format verbose_json --lang es       # words + segments as JSON
sox -d -r 16000 -c 1 -b 16 -e signed -t raw - | pinecall stt --stream            # live, from the mic
ffmpeg -f avfoundation -i :0 -ac 1 -ar 16000 -f s16le - | pinecall stt --stream   # same with ffmpeg (macOS; -f alsa -i default on Linux)
```

| Flag | Meaning |
|---|---|
| `<file>` | Audio file — wav, mp3, m4a, webm, ogg, flac; max 25 MB |
| `--stream` | Live mode: raw s16le mono PCM on stdin; finals on stdout, partials on stderr |
| `--model <provider/model>` | File: `elevenlabs/scribe_v1` (default), `deepgram/nova-3`, `deepgram/nova-2`, `soniox/stt-async-preview`. Stream: `deepgram/nova-3` (default), `elevenlabs/scribe_v2_realtime`, `soniox/stt-rt-v5` |
| `--lang <code>` | ISO-639-1 language, e.g. `es`; default auto-detect |
| `--diarize` | Speaker labels — `[speaker N]` in front of each segment (file) or final (stream) |
| `--format <f>` | File mode: `text` (default) \| `json` \| `verbose_json` \| `srt` \| `vtt` |
| `--rate <hz>` | Stream mode: sample rate of the PCM on stdin — `8000` \| `16000` (default) \| `24000` \| `48000` |
| `-o <file>` | File mode: write the transcript to a file instead of stdout |

- **File mode** prints the transcript on stdout (or writes `-o`). `text` is the
  plain transcript; with `--diarize` it becomes one `[speaker N] …` line per
  segment (`verbose_json` is fetched under the hood). `json` / `verbose_json`
  print the wire object. `srt` / `vtt` are built from the segments (or from the
  words, in 8-word cues cut on speaker change, when the model returns no
  segments) — `[speaker N]` is prepended to each cue when diarized.
- **Stream mode** reads raw PCM from stdin (it refuses a terminal and prints the
  `sox` line). Each final is one line on stdout; partials rewrite one line on
  stderr only when stderr is a TTY, so `… | pinecall stt --stream > notes.txt`
  gets clean finals. stdin EOF or Ctrl-C sends `stop`, waits for the server's
  `done`, and prints the audio seconds and billed minutes; a second Ctrl-C
  closes the socket at once (exit 130).
- Everything that is not the transcript goes to stderr: the summary
  (`✓ stdout · text · 12.4 s audio · elevenlabs/scribe_v1 · es · 910 ms · req_…`)
  and errors — the `AudioApiError` code plus a one-line fix (413 → "max 25 MB —
  trim or compress the file", 400 `DIARIZE_UNSUPPORTED` → "drop --diarize or pick
  soniox / deepgram").

### `pinecall chat [agent]`

Interactive text chat with a connected agent. Uses the same LLM + tools as a voice call, but over text.

```bash
# Chat with a specific agent
pinecall chat mara

# If no agent specified, lists available agents to pick from
pinecall chat
```

```
  ⚡ Connected to mara

  you › Book me a haircut for friday
  mara › Let me check available slots...
        ┌ tool: findSlots({"date":"2026-06-06"})
        └ {"available":["10:00","14:00","16:30"]}
  mara › I found 3 available slots: 10am, 2pm, and 4:30pm. Which works?

  you › 2pm
  mara › Booked! Haircut for Friday at 2pm.
        ┌ tool: bookAppointment({"date":"2026-06-06","time":"14:00","service":"haircut"})
        └ {"confirmed":true,"bookingId":"bk_abc123"}
```

#### Slash commands

| Command | Action |
|---------|--------|
| `/reset` | Start a new conversation (clears history) |
| `/clear` | Clear the screen |
| `/quit` | Exit chat |

> **Note:** The agent must be connected (shown in `pinecall agents`) for chat to work. The chat uses the same prompt, tools, and model configuration as the deployed agent.

### `pinecall test <path>`

Run YAML-based agent specs. A **judge LLM** (Haiku by default) converses with your agent following a workflow you define, then reports pass/fail via tool calls.

```bash
# Run all specs in a directory
pinecall test agent/specs/

# Run a single spec
pinecall test agent/specs/date-handling.spec.yaml

# Override the judge model
pinecall test agent/specs/ --judge anthropic/claude-haiku-4-5

# List specs without running
pinecall test agent/specs/ --list

# Voice mode — run the spec as a REAL voice call (judge agent ↔ your agent)
pinecall test agent/specs/greeting.spec.yaml --voice
```

**Voice mode** (`--voice` or `mode: voice` in the spec) runs the spec as a real bridged voice call instead of text — exercising STT, turn detection, TTS and barge-in. Extra flags: `--voice <p/v>` (judge TTS, default `elevenlabs/professional-male`), `--stt <prov>` (default `flux`), `--record <file>` (WAV out), `--no-listen` (don't open the live player), `--lang <code>`. See [Testing Agents → Voice Mode](/guides/testing-agents#voice-mode).

```
  ⚡ pinecall test

  Agent:  florencia
  Judge:  anthropic/claude-haiku-4-5
  Specs:  2 file(s)
  Server: wss://voice.pinecall.io

  ━━━ date-handling.spec.yaml ━━━
  Verifica que Florencia sabe la fecha correcta

  Turn 1: "Hola, ¿qué día es hoy?"
    Bot: Hoy es viernes 5 de junio de 2026. ¿Querés reservar algún servicio?
  Turn 2: "Perfecto, quiero reservar para mañana."
    Bot: Mañana es sábado 6 de junio.
    🔧 checkAvailability({"date":"2026-06-06"})

  Result: ✓ PASS
  Fechas correctas: hoy 5/6, mañana 6/6, tool arg 2026-06-06
  (4.3s, 2 turns)

  ═══ Summary ═══
    ✓ date-handling.spec.yaml  2 turns

  1 passed, 0 failed
```

#### Spec format

Specs are YAML files ending in `.spec.yaml`. The judge LLM reads the `workflow` and interacts with your agent as a real user would, calling `test_passed` or `test_failed` tools to report the result.

```yaml
# agent/specs/date-handling.spec.yaml
agent: florencia
description: "Date math and calendar awareness"

judge:
  provider: anthropic
  model: claude-haiku-4-5
  maxTurns: 10

workflow: |
  1. Ask the agent what day it is today
  2. Verify it responds with the correct current date
  3. Ask to book a service for tomorrow
  4. Verify the checkAvailability tool is called with tomorrow's date
  5. PASS if all dates are correct, FAIL if any are wrong
```

#### Judge providers

The judge is the LLM that evaluates your agent. Override with `--judge provider/model`:

| Provider | Model | Cost (in/out per 1M) | Notes |
|----------|-------|---------------------|-------|
| `anthropic` | `claude-haiku-4-5-20251001` | $0.80 / $4.00 | Default. Reliable. |
| `openai` | `gpt-5-chat-mini` | $0.10 / $0.40 | **10x cheaper**, recommended. |
| `deepseek` | `deepseek-v4-flash` | $0.14 / $0.28 | Cheapest cloud option. |
| `ollama` | `gemma3:4b` | Free (local) | Requires Ollama running. |

> **Tip:** `claude-haiku-4-5` is the best balance of cost and reliability for automated testing.

#### Options

| Option | Description |
|--------|-------------|
| `--judge provider/model` | Override judge LLM (e.g. `anthropic/claude-haiku-4-5`) |
| `--agent <id>` | Override agent name from spec |
| `--grep <pattern>` | Run only specs matching pattern |
| `--verbose` | Show full agent responses |
| `--json` | JSON output for CI pipelines |
| `--list` | List discovered specs without running |

### `pinecall calls`

Call history — recent calls with duration, credits, and cost. Reads from the
Playground usage API.

```bash
pinecall calls                  # recent calls
pinecall calls --limit=50
pinecall calls --json
```

### `pinecall conversations`

Browse saved **conversation transcripts** (chat + voice) for your org. Each
conversation is one chat/call session; transcripts are persisted server-side
(with the client IP for chat/WebRTC). Aliases: `convos`.

```bash
pinecall conversations                      # list recent conversations
pinecall conversations --type=chat          # filter by type (chat|phone|webrtc)
pinecall conversations --agent=docs         # filter by agent
pinecall conversations --limit=50 --json
pinecall conversations get <id>             # print one full transcript
```

The list prints the full conversation id; `conversations get` also accepts a
short id prefix and resolves it against the recent list. Same data powers the
super-admin "Support chats" view in the dashboard.

### `pinecall usage`

Credit usage breakdown by service (STT/TTS/LLM/telephony/platform). Top-level
alias of [`pinecall account usage`](#pinecall-account).

```bash
pinecall usage
```

### `pinecall balance`

Show your Pinecall credit balance and plan info.

```bash
pinecall balance
```

> **Warning:** Credits are displayed in red when below 10% of your limit, and yellow below 25%, as a low-balance warning.

### `pinecall signup`

Open the Pinecall signup page in your browser to create a new organization.

```bash
pinecall signup
```

- Opens `https://playground.pinecall.io/signup` in your default browser
- Sign up there to create your org and get your first API key
- No authentication needed — this is the first step

### `pinecall account`

View your organization overview with plan, credits, keys, Twilio accounts, and phones.

```bash
pinecall account
```

```
  ⚡ My Company — my-company
    Plan Starter  ·  Credits 38,450/40,000  ·  Email admin@company.com
    ○ Not verified — outbound calls restricted
    Limits: phones 1/2  ·  concurrent 3  ·  agents 3

  ▸ API Keys (2)
  ▸ Twilio (1)
  ▸ Phones (1)
```

#### Subcommands

| Subcommand | Description |
|------------|-------------|
| `pinecall account` | Full overview |
| `pinecall account keys` | List API keys |
| `pinecall account keys create "Name"` | Create new key |
| `pinecall account usage` | Credit usage breakdown by service |
| `pinecall account session` | Debug session resolution |

### `pinecall account usage`

View credit consumption by service with a visual breakdown.

```bash
pinecall account usage
```

```
  ▸ Credits & Usage
    Plan      Starter
    Credits   ████████████████████████░░░░░░  38,450/40,000 (96%)
    Resets in 25 days

    Usage by Service (last 30 days)
    Service    Credits  Cost     Events
    STT        560      $0.0539  70       ████████████████ 36%
    TTS        900      $0.0450  20       ██████████████████████████ 58%
    LLM        12       $0.0002  6        █ 1%
    PLATFORM   78       $0.0780  78       █████ 5%

    Total consumed  1,550 credits  ·  $0.1771
```

### `pinecall phone`

Manage phone numbers — request managed numbers from Pinecall.

```bash
pinecall phone request                    # Provision a managed number
pinecall phone request --country=US       # Specify country
pinecall phone search                     # Search available numbers
pinecall phone search --area-code=415     # Filter by area code
```

Plan limits are enforced:
- **Free Trial**: managed numbers not available (use BYOC)
- **Starter**: up to 2 managed numbers
- **Pro**: up to 10
- **Enterprise**: unlimited

### `pinecall twilio`

Manage your own Twilio accounts (BYOC).

```bash
pinecall twilio                           # List accounts + phones
pinecall twilio link <SID> <Token>        # Link a Twilio account
pinecall twilio import +1234567890        # Import a phone number
pinecall twilio unlink <SID>              # Remove a Twilio account
```

> **BYOC phones are inbound only.** Outbound calls require a managed number from a verified account.

### `pinecall knowledge`

Manage knowledge bases (RAG) — the documents an agent grounds its answers on.
Attach a knowledge base to an agent with [`knowledgeBase`](/guides/knowledge-bases),
then upload, query, and re-train it from the terminal.

> **Paid feature.** Knowledge bases require a paid plan (Starter or higher). On a
> free trial the CLI prints an upgrade prompt.

```bash
pinecall knowledge                              # List knowledge bases
pinecall knowledge create "Product docs"        # Create one (prints its id)
pinecall knowledge docs <kbId>                  # List documents in a KB
pinecall knowledge push <kbId> ./docs/*.md      # Upload local .md / .txt files
pinecall knowledge get <kbId> <docId>           # Print a document's text
pinecall knowledge query [kbId] "how do I dial" # Semantic search — no LLM (kbId optional if you have one KB)
pinecall knowledge reindex <kbId>               # Re-train (rebuild) the index
pinecall knowledge rm <kbId> <docId>            # Delete a document
pinecall knowledge delete <kbId>                # Delete the knowledge base
```

Listing knowledge bases:

```
  ▸ Knowledge bases (1)
  ID                        NAME           DOCS  STATUS
  ────────────────────────  ─────────────  ────  ──────
  6a342d8665460d8af75d5757  Product docs   42    ready
```

`knowledge query` runs **retrieval only** (embeddings, no LLM) — it returns the
top matching chunks with a relevance score, useful for debugging what an agent
will retrieve:

```bash
pinecall knowledge query 6a342d8665460d8af75d5757 "how do I add a tool"
```

```
  ▸ Matches for "how do I add a tool" (6)
  0.476  Tools and Functions › Adding a tool
         To add a tool to an agent, call pc.tool and pass it in the tools array…
  0.459  Events › Tools
         The server-side LLM is requesting one or more tool calls…
```

Uploading reads each file's text locally and stores it in the knowledge base,
then the index re-trains automatically. Documents can also be managed in the
dashboard under **Knowledge**.

## Global Options

| Option | Description |
|--------|-------------|
| `--api-key=pk_...` | Override `PINECALL_API_KEY` env var |
| `--server=URL` | Override server URL (default: `https://voice.pinecall.io`) |
| `--json` | Output raw JSON instead of formatted tables |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

## JSON Output

All commands support `--json` for machine-readable output:

```bash
pinecall agents --json | jq '.agents[].slug'
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PINECALL_API_KEY` | Your Pinecall API key | — (required) |
| `PINECALL_URL` | Voice server URL | `https://voice.pinecall.io` |
| `ANTHROPIC_API_KEY` | For Anthropic judge (default) | — |
| `OPENAI_API_KEY` | For OpenAI judge | — |
| `DEEPSEEK_API_KEY` | For DeepSeek judge | — |
| `OLLAMA_HOST` | Ollama server URL | `http://localhost:11434` |
| `NO_COLOR` | Disable ANSI colors | — |

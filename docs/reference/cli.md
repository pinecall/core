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

### `pinecall run <file>`

Run an agent file with a polished terminal display. The primary way to develop and test agents.

```bash
pinecall run agent/index.ts
pinecall run agent/index.js
```

```
  ⚡ booting pines  ·  gpt-5-chat-latest · cartesia/sonic
  ⚙ tools: checkAvailability, makeReservation, cancelReservation
  ☎ listening on +14155550177 …

  ☎  incoming call — connecting…
  caller › Hey, I'd like to reserve a table for Friday.
  pines  › Of course! How many guests?
          ⚡ checkAvailability({ date: "2026-06-13", time: "19:00", partySize: 2 })
          → available · window seat · 1.5 hours
```

Uses `tsx` for `.ts` files, `node` for `.js`. Sets `PINECALL_CLI_RUN=1` which triggers the SDK's built-in runner display (boot banner, live transcript, tool call formatting). The agent file needs zero changes — `pinecall run` just adds the pretty output.

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

**Why you need this:** The server protects production agents from accidental displacement — if you try to connect a new agent with the same slug while the old one is still alive, the new connection is **rejected** with an `AGENT_CONFLICT` error. Use `pinecall kick` to remove the old registration first.

```
  ✗ Agent "pines" is already connected.
    Run pinecall kick pines to force disconnect.
```

> **Note:** `kick` sends a `agent.displaced` event to the old agent's WebSocket before unregistering it. If the process is still running, it will receive the event and can handle cleanup.

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
pinecall knowledge query <kbId> "how do I dial" # Semantic search — no LLM
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

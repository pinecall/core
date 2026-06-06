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
pinecall test agent/specs/ --judge openai:gpt-4.1-nano

# List specs without running
pinecall test agent/specs/ --list
```

```
  ⚡ pinecall test

  Agent:  florencia
  Judge:  openai:gpt-4.1-nano
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
  provider: openai
  model: gpt-4.1-nano
  maxTurns: 10

workflow: |
  1. Ask the agent what day it is today
  2. Verify it responds with the correct current date
  3. Ask to book a service for tomorrow
  4. Verify the checkAvailability tool is called with tomorrow's date
  5. PASS if all dates are correct, FAIL if any are wrong
```

#### Judge providers

The judge is the LLM that evaluates your agent. Override with `--judge provider:model`:

| Provider | Model | Cost (in/out per 1M) | Notes |
|----------|-------|---------------------|-------|
| `anthropic` | `claude-haiku-4-5-20251001` | $0.80 / $4.00 | Default. Reliable. |
| `openai` | `gpt-4.1-nano` | $0.10 / $0.40 | **10x cheaper**, recommended. |
| `deepseek` | `deepseek-v4-flash` | $0.14 / $0.28 | Cheapest cloud option. |
| `ollama` | `gemma3:4b` | Free (local) | Requires Ollama running. |

> **Tip:** `gpt-4.1-nano` is the best balance of cost and reliability for automated testing.

#### Options

| Option | Description |
|--------|-------------|
| `--judge provider:model` | Override judge LLM (e.g. `openai:gpt-4.1-nano`) |
| `--agent <id>` | Override agent name from spec |
| `--grep <pattern>` | Run only specs matching pattern |
| `--verbose` | Show full agent responses |
| `--json` | JSON output for CI pipelines |
| `--list` | List discovered specs without running |

### `pinecall balance`

Show your Twilio account balance.

```bash
pinecall balance
```

> **Warning:** The balance is displayed in red when below $10 as a low-balance warning.

### `pinecall signup`

Create a new organization with a free trial plan.

```bash
pinecall signup "My Company" --email=admin@company.com
```

- Assigns the **Free Trial** plan (14 days, 3,500 credits)
- Generates your first API key
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

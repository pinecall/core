# @pinecall/mcp

Pinecall as an **MCP server**. Point a coding agent at it and it can go from zero to a
working voice agent without leaving the editor: read the docs, discover the model/voice/phone
catalog, configure a **dev** agent, iterate on it by chatting with it, and debug real calls
from the call log.

> **Status: the journey is complete.** All 14 tools ship — `whoami`, `set_api_key`,
> `docs_search`, `get_doc`, `knowledge`, `list_agents`, `configure_agent`, `chat`,
> `list_phones`, `list_calls`, `get_call`, `list_models`, `list_voices`, `play_voice` —
> plus the `pinecall mcp install` one-command installer. What is deliberately absent:
> no spec-runner (chat **is** the testing story), no outbound dialling, no account
> creation, and no code tools — `tool()` and webhooks need a running SDK process.

## Install

```bash
pinecall mcp install
```

One command, every IDE. It detects the AI coding assistants on the machine and writes the
`pinecall` entry into each one's own config, in that host's own format:

| platform | config | format |
|---|---|---|
| `claude` | `~/.claude.json` | JSON (`mcpServers`) |
| `codex` | `~/.codex/config.toml` | TOML (`mcp_servers`) |
| `antigravity` | `~/.gemini/antigravity/mcp_config.json` | JSON |
| `cursor` | `~/.cursor/mcp.json` | JSON |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` | JSON |
| `gemini` | `~/.gemini/settings.json` | JSON |

```bash
pinecall mcp install                # everything detected on this machine
pinecall mcp install cursor codex   # only the ones you name (written even if undetected)
pinecall mcp install --list         # what is detected, changing nothing
pinecall mcp install --remove       # take the pinecall entry back out
```

Three properties worth knowing:

- **It only ever touches its own key.** Your other MCP servers, your unrelated settings and
  (in the TOML case) your comments come out the other side untouched. `--remove` deletes
  exactly the `pinecall` entry.
- **Re-running repairs, never duplicates.** The entry is replaced, so a config that drifted
  to an older command is cured by running the same command again. Each file is backed up to
  `<file>.bak` before it is written.
- **No API key is written to any config.** The entry is just
  `{"command": "npx", "args": ["-y", "@pinecall/mcp"]}`; the server reads `PINECALL_API_KEY`
  from the environment its host launches it in (or you call the `set_api_key` tool).

Restart the assistant afterwards — it read its config at startup.

Prefer to wire it by hand? The entry above is the whole thing. To run the server directly:
`pinecall mcp`, or the binary `pinecall-mcp` (stdio transport — stdout is the protocol,
diagnostics go to stderr).

### Environment

| var | default | what |
|---|---|---|
| `PINECALL_API_KEY` | — | your key. Missing? see key discovery below, or call `set_api_key`. |
| `PINECALL_URL` | `https://voice.pinecall.io` | the voice server |
| `PINECALL_PLAYGROUND_URL` | `https://playground.pinecall.io` | the Playground API (org/plan/credits) |

### Key discovery — "it works in my terminal but not in my editor"

An IDE spawns this server as a plain child process. On macOS a GUI app is not a login
shell and **never sources `~/.zshrc`**, so a key you exported in a terminal does not exist
in the server's environment. So the key is looked for in three places, in order:

1. **`PINECALL_API_KEY` in the server's env** — an `env` block in your `mcp.json`, a
   launchd/systemd unit, or on **Windows** a user variable set with `setx`, which *does*
   reach a GUI-launched child. Always wins.
2. **`~/.pinecall/credentials`** — the canonical store: JSON `{"api_key": "pk_…"}`, mode
   `0600`. Shared with the `pinecall` CLI (which reads it right after env), so both agree.
3. **A read-only scan of `~/.zshenv`, `~/.zshrc`, `~/.bash_profile`, `~/.bashrc`,
   `~/.profile`** for `export PINECALL_API_KEY=…`. The files are parsed with a regex and
   are **never executed or sourced**. A hit is used *and* copied into
   `~/.pinecall/credentials` (0600), so this fragile path runs exactly once — `whoami`
   reports `keySource: "shell-rc"` with a one-line notice when that happens.

`whoami` always reports `keySource`: `env` · `credentials` · `shell-rc` · `session`.

The key is held **in memory**, never logged, and never returned by a tool — every outbound
error string is scrubbed (`Session.redact`). The single exception to "never written" is
`~/.pinecall/credentials`, written at mode `0600`, and only by an rc-scan hit or an
explicit `set_api_key(persist: true)`.

## Tools

Fourteen tools, listed in journey order — the same order they appear in the server's
`instructions`.

| tool | what it does |
|---|---|
| `whoami` | the org this key belongs to — name, slug, plan, credits, plus `keySource` (where the key was found). The auth probe: call it first. |
| `set_api_key(key, persist?)` | store a key for this session, in memory. With `persist: true` also writes `~/.pinecall/credentials` (0600) so it survives a restart and the CLI sees it. Returns `{ ok, verified, persisted, org }` — never the key. |
| `docs_search(query, limit?)` | semantic search over the Pinecall docs KB — retriever only, no LLM. Returns `[{ title, path, snippet, score }]`. Search before guessing an API shape, and cite the `path`. |
| `get_doc(path)` | the WHOLE docs page behind a `docs_search` hit, as markdown: `{ path, title, markdown, truncated }`. The `.md` is optional (`guides/call-log`). Same KB `docs_search` queries, so the two cannot disagree. An unknown path returns `{ error, path, suggestions }`, never a crash. |
| `knowledge(action, kb?, …)` | knowledge bases (RAG): `list` the org's KBs, `query` one for ranked chunks, `push` `[{path, content}]` docs into one. Push is idempotent by path; re-training is automatic. The client supplies document content — the server never reads local files. |
| `list_agents()` | every agent in the org with `online`, `dev`, `channels`, `phones`, plus `devOverrides`. Read it before touching anything: `online: true` means a live process owns that agent. |
| `configure_agent(slug, prompt, llm?, voice?, language?, greeting?, phoneNumber?)` | create or hot-reload a **`dev-`** agent and hold it live for this session. A non-`dev-` slug is refused, with no override. A re-configure replaces the whole config — it does not merge. |
| `chat(agent, message, session?, timeoutSeconds?)` | say something to an agent, get its reply: `{ reply, session, toolCalls? }`. Pass `session` back to continue the conversation with its history. Works against dev **and** prod agents — it only talks, it never mutates. Turns are capped (30s default), so an offline agent or a stalled model comes back as an error, never a hang. |
| `list_phones(free?)` | every number with its owner — `{ number, agent, live, dev_override?, country, inInventory }` plus `{ total, free, assigned }`. `agent: null` is the only free one. |
| `list_calls(agent, live?, limit?)` | the agent's calls, newest first — `{ call, live, direction, from, startedAt, endedAt }`. Lifecycle only; the index into the log. |
| `get_call(call_id, after?, agent?, limit?)` | one call reduced — `phase`, `messages` with seqs, `toolCalls` with args and results, `turns`, `summary`. Cursor-paged: `after` in, `nextAfter` out. |
| `list_models(kind)` | the models the server accepts for `llm` / `stt` / `tts`, each with the exact config shortcut (`deepgram/flux`) and notes (languages, managed vs BYOK, realtime). Every row carries `usable` — managed, or the org has that provider's BYOK key. |
| `list_voices(provider?, language?, limit?)` | TTS voices with the exact `voice` string (`elevenlabs/sarah`), filtered by provider and language. Live from the server. Rows carry `usable` too. |
| `play_voice(voice, text?, language?)` | plays a sample of that voice **out of this machine's speakers** so you can choose by ear. Stdio only — see below. |

**Testing is chatting.** There is deliberately no spec-runner tool: to check behaviour, ask
the agent what a real caller would ask and read the transcript. `chat` reuses the very
WebSocket client the CLI's `pinecall chat` / `pinecall test` use (`llm.chat` protocol) —
no second implementation of the protocol exists.

`list_calls` / `get_call` are the **debugger**: after any chat or phone call, read the log
instead of guessing. They read [call-log v3](../docs/guides/call-log.md) over a `stream`
token minted per request with `scope: "observe"` (read-only, and narrowed to the single call
for `get_call`) — the API key never reaches the log endpoints. The call reduction is
`CallLogView` from `@pinecall/sdk/log`, the same one reducer the browser client uses, so
ephemeral interim transcripts collapse exactly as they do in a live UI.
| `list_models(kind)` | the models the server accepts for `llm` / `stt` / `tts`, each with the exact config shortcut (`deepgram/flux`) and notes (languages, managed vs BYOK, realtime). Every row carries `usable` — managed, or the org has that provider's BYOK key. |
| `list_voices(provider?, language?, limit?)` | TTS voices with the exact `voice` string (`elevenlabs/sarah`), filtered by provider and language. Live from the server. Rows carry `usable` too. |
| `play_voice(voice, text?, language?)` | Plays a sample of that voice **out of this machine's speakers** so you can choose by ear. Stdio only — see below. |
| `subscribe(plan?)` | plan, credits and the plan catalogue, plus a **Stripe link the human opens**. No argument = read-only + a Billing Portal URL. With `plan` = a Checkout URL, or an in-place plan change for an org that already subscribes — see below. |

### `subscribe`: the link is the product

Nothing money-shaped is implemented here. The tool composes four endpoints the Playground
already serves — `GET /api/orgs/me`, `GET /api/plans`, `POST /api/billing/portal`,
`POST /api/billing/checkout` — and returns what they give back. `STRIPE_SECRET_KEY` lives in
the Playground process only; the MCP never sees a card, a secret or a Stripe id, and what
crosses the wire is a hosted-page URL that the **human** opens.

Two behaviours worth knowing before you call it with a `plan`:

- an org with **no** subscription gets `checkoutUrl` — a Stripe Checkout page;
- an org that **already** subscribes has its subscription switched in place with proration
  and gets `{ applied: true, changed: "upgrade" | "downgrade" }` and no URL. That is a real
  billing change, so ask the human first. With no argument the tool cannot charge anything.

`portalUrl` is `null` with a `portalUnavailable` reason (code `NO_CUSTOMER`) when the org has
never paid — there is no Stripe customer to open a portal for yet. That is an answer, not an
error.
| `byok(action?, provider?, key?)` | your own provider keys: `list` → `[{provider, configured, addedAt?}]`, `set` (provider + key), `remove`. Saving a key moves that provider's usage off your Pinecall credits and onto the provider's own bill — see below. |

### `byok`: your own provider key, and what it does to the bill

`byok` writes the org's Provider Keys through the authenticated
`/api/credentials` endpoints — the same store the dashboard's **Provider Keys**
screen uses. Saving a key for a provider Pinecall serves *managed* makes yours win:
that usage is billed by the provider **directly** instead of deducting Pinecall
credits. For BYOK-only providers (`xai`, `groq`, `cerebras`, `deepseek`,
`openrouter`, `assemblyai`, `rime`) there is no managed key at all — without yours,
agent registration is rejected with `PROVIDER_KEY_REQUIRED`. The full split:
[managed vs BYOK](../docs/reference/managed-vs-byok.md).

**Nothing readable ever comes back.** `list` reports `configured: true` and nothing
else — the API's `apiKeyPreview` (the *leading* eight characters of the stored key)
is deliberately dropped rather than forwarded, and there is no read-back path. On
`set` the key transits once: it is registered with the session's `redact()` for the
duration of that one call, so an upstream error quoting it is scrubbed before it can
escape, and the result is redacted before it is returned.

### `play_voice`: audio on the user's machine

On the stdio transport this process runs on the user's machine, so it can reach their
speakers. It fetches the same sample the playground's voice picker plays
(`GET /api/sdk/voice-preview`): providers with a provider-hosted clip (elevenlabs,
cartesia) expose a `preview_url` on `GET /api/sdk/voices` and that file is fetched
directly — free and instant, but the words are fixed, so `text` is echoed back as
`textIgnored`. Providers without one (rime, xai) are synthesized from `text` and need
that provider's key on the org. Bytes go to a temp file in `os.tmpdir()` and are played
with `afplay` (darwin), `ffplay`/`aplay`/`mpg123` (linux) or `Media.SoundPlayer` (win32);
the player is killed at 15s. Over a remote transport there are no speakers to reach — set
`PINECALL_MCP_NO_PLAYBACK=1` and the result carries `played: false` plus the `previewUrl`.

### The catalog: what is live and what is a snapshot

`list_voices` is **fully live** — it is the SDK's own `fetchVoices` against
`GET /api/sdk/voices` on the voice server, the same call `pinecall voices` makes. Voices
differ per org and per provider key, so there is no static list. Rows without a friendly
alias are dropped and their provider is reported in `unlistedProviders`: `?provider=polly`
answers with the built-in fallback catalog (ElevenLabs ids, un-aliased), and passing those
through would produce `polly/EXAVITQu4vr4xnSDxMaL` — a string that is wrong twice.

`list_models` is a **hybrid**, because the server has no endpoint that returns config
shortcuts. `GET {playground}/api/rates/models` is live and authoritative but returns
*billing* ids (`deepgram-flux`, `stt-rt-v5`), not `deepgram/flux` / `soniox/realtime`. So:

- the shortcut table is **generated at build time** from `docs/reference/{llm,stt,tts}-providers.md`
  by `scripts/gen-catalog.mjs` → `src/catalog.generated.ts`, and every result carries
  `staleAsOf` (the generation date) and `source` (the doc it came from);
- `managed` (i.e. "do I need my own key?") is **refreshed live** from the rate table on every
  call, joined at *provider* level — an exact match on both sides, never a fuzzy model-id
  guess. If the rate table is unreachable the docs value is used and `managedSource` says so.

Regenerate after editing the provider docs: `npm run gen:catalog` (also runs on `npm run build`).

### `usable`: what *this* org can actually run

`managed: false` is a fact about the model — it needs somebody's key. It does not say
whether **you** have one. So every `list_models` and `list_voices` row also carries:

| field | meaning |
|---|---|
| `usable: true` | pick it — it is managed, or the org already has that provider's key |
| `usable: false` + `unusableReason: "needs-byok"` | `byok('set', provider, key)` first, or the agent is rejected with `PROVIDER_KEY_REQUIRED` at registration |
| `byokUnknown: true` | the credentials lookup failed; `usable` fell back to `managed` alone |

The join is **one** `GET /api/credentials` per tool call — the same listing `byok` shows,
fetched through the shared `src/byok-status.ts` so the three tools cannot drift — matched at
provider level and case-insensitively. A provider you cannot hand a key to (`pinecall`,
`polly`) is never blocked for want of one: `byok` would refuse that provider name, so
"needs-byok" there would be advice nobody could follow. And the lookup is tolerant by
design: a credentials endpoint that 500s degrades the *answer* (`byokUnknown`), it never
fails the catalog.

## The instructions are the product

Every tool ships its own **manual**, and the server's `instructions` field is assembled from
the journey playbook (`src/instructions.ts`) plus those manuals — so a tool cannot exist
undocumented and its manual cannot go stale in a second file.

That text loads into **every** client's context on connect, before the user has asked
anything, so it is on a **hard 4000-character budget pinned by a test**
(`tests/session.test.ts`). A new tool pays for its section by shortening someone's manual,
never by growing the total. Keep a manual to the non-obvious: the trap, the invariant, the
thing a competent agent would get wrong — the "what it does" already lives in the tool's
`description`.

## Adding a tool

One file, one import line. That is the whole extension point:

```ts
// src/tools/list_models.ts
import { z } from "zod";
import { defineTool } from "./types.js";

export default defineTool({
    name: "list_models",
    description: "…",
    schema: { kind: z.enum(["llm", "stt", "tts"]).optional() },
    manual: "**`list_models`** — …",          // its section of the server instructions
    async handler(args, { session }) {
        return session.server("/api/models");  // reuses the SDK's apiFetch
    },
});
```

```ts
// src/tools/index.ts
import listModels from "./list_models.js";
export const tools = [whoami, setApiKey, listModels];
```

Registration, the JSON envelope, error redaction and the instructions assembly all iterate
that array — nothing else changes.

## Layout

```
src/
  index.ts         stdio entrypoint (bin: pinecall-mcp)
  server.ts        registry → McpServer; the single error/redaction envelope
  instructions.ts  the journey playbook + buildInstructions(tools)
  session.ts       the API key, the two base URLs, the HTTP seam
  call-log.ts      stream-token minting + the agent-log → rows fold
  tools/
    types.ts       the ToolModule contract + defineTool()
    index.ts       THE REGISTRY
    whoami.ts  set-api-key.ts
    docs-search.ts  get-doc.ts  knowledge.ts
    list-agents.ts  configure-agent.ts  chat.ts
    list-phones.ts  list-calls.ts  get-call.ts
    list-models.ts  list-voices.ts  play-voice.ts
  catalog.generated.ts   GENERATED — the shortcut table (npm run gen:catalog)
scripts/
  gen-catalog.mjs        docs/reference/*.md → catalog.generated.ts
```

`session.ts` imports `apiFetch` from the SDK's own `src/api/http.ts` — there is no second
HTTP client in this package, and the Playground path is the one the CLI's `pinecall account`
uses (`GET /api/orgs/me`).

## Develop

```bash
npm install
npm test          # vitest — boots the server over a REAL stdio transport
npm run gen:catalog  # regenerate the model shortcut table from docs/reference
npm run build     # tsup → dist/index.js
npm run typecheck
```

The test suite starts the actual server as a subprocess and drives it with the MCP client:
it asserts `tools/list` matches the registry, that `instructions` carries the playbook plus
exactly one section per tool and stays inside the 4000-char budget, that a missing key errors
naming `set_api_key`, and that no key text ever comes back out. The catalog tests hit the **real** endpoints (both are public reads):
`list_models("stt")` must carry `deepgram/flux` and `soniox/realtime` with their language
notes, and `list_voices({ language: "es" })` must return Spanish voices only, every one of
them a usable `provider/alias` string.

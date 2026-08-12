# @pinecall/mcp

Pinecall as an **MCP server**. Point a coding agent at it and it can go from zero to a
working voice agent without leaving the editor: read the docs, discover the model/voice/phone
catalog, configure a **dev** agent, iterate on it by chatting with it, and debug real calls
from the call log.

> Status: foundation. Today it ships `whoami`, `set_api_key`, `docs_search` and `knowledge`;
> the rest of the journey (`list_models`, `list_voices`, `list_phones`, `list_agents`,
> `configure_agent`, `chat`, `list_calls` / `get_call`) lands tool by tool.
> Status: in progress. Today it ships `whoami`, `set_api_key` and `chat`; the rest of the
> journey (`docs_search`, `list_models`, `list_voices`, `list_phones`, `list_agents`,
> `configure_agent`, `list_calls` / `get_call`, `knowledge`) lands tool by tool.
> Status: in progress. Today it ships `whoami`, `set_api_key`, `list_models` and
> `list_voices`; the rest of the journey (`docs_search`, `list_phones`, `list_agents`,
> `configure_agent`, `chat`, `list_calls` / `get_call`, `knowledge`) lands tool by tool.

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
| `PINECALL_API_KEY` | — | your key. Missing? call the `set_api_key` tool instead. |
| `PINECALL_URL` | `https://voice.pinecall.io` | the voice server |
| `PINECALL_PLAYGROUND_URL` | `https://playground.pinecall.io` | the Playground API (org/plan/credits) |

The key is held **in memory only**. It is never written to a file, never logged, and never
returned by a tool — every outbound error string is scrubbed (`Session.redact`).

## Tools

| tool | what it does |
|---|---|
| `whoami` | the org this key belongs to — name, slug, plan, credits. The auth probe: call it first. |
| `set_api_key(key)` | store a key for this session, in memory. Returns `{ ok, verified, org }` — never the key. |
| `docs_search(query, limit?)` | semantic search over the Pinecall docs KB — retriever only, no LLM. Returns `[{ title, path, snippet, score }]`. Search before guessing an API shape, and cite the `path`. |
| `knowledge(action, kb?, …)` | knowledge bases (RAG): `list` the org's KBs, `query` one for ranked chunks, `push` `[{path, content}]` docs into one. Push is idempotent by path; re-training is automatic. The client supplies document content — the server never reads local files. |
| `chat(agent, message, session?, timeoutSeconds?)` | say something to an agent, get its reply: `{ reply, session, toolCalls? }`. Pass `session` back to continue the conversation with its history. Works against dev **and** prod agents — it only talks, it never mutates. Turns are capped (30s default), so an offline agent or a stalled model comes back as an error, never a hang. |

**Testing is chatting.** There is deliberately no spec-runner tool: to check behaviour, ask
the agent what a real caller would ask and read the transcript. `chat` reuses the very
WebSocket client the CLI's `pinecall chat` / `pinecall test` use (`llm.chat` protocol) —
no second implementation of the protocol exists.
| `list_calls(agent, live?, limit?)` | the agent's calls, newest first — `{ call, live, direction, from, startedAt, endedAt }`. Lifecycle only; the index into the log. |
| `get_call(call_id, after?, agent?, limit?)` | one call reduced — `phase`, `messages` with seqs, `toolCalls` with args and results, `turns`, `summary`. Cursor-paged: `after` in, `nextAfter` out. |

`list_calls` / `get_call` are the **debugger**: after any chat or phone call, read the log
instead of guessing. They read [call-log v3](../docs/guides/call-log.md) over a `stream`
token minted per request with `scope: "observe"` (read-only, and narrowed to the single call
for `get_call`) — the API key never reaches the log endpoints. The call reduction is
`CallLogView` from `@pinecall/sdk/log`, the same one reducer the browser client uses, so
ephemeral interim transcripts collapse exactly as they do in a live UI.
| `list_models(kind)` | the models the server accepts for `llm` / `stt` / `tts`, each with the exact config shortcut (`deepgram/flux`) and notes (languages, managed vs BYOK, realtime). |
| `list_voices(provider?, language?, limit?)` | TTS voices with the exact `voice` string (`elevenlabs/sarah`), filtered by provider and language. Live from the server. |

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

Every tool also ships its own **manual**, and the server's `instructions` field is assembled
from the journey playbook plus those manuals — so a tool cannot drift from its documentation.

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
    whoami.ts
    set-api-key.ts
    knowledge.ts
    list-calls.ts
    get-call.ts
    list-models.ts
    list-voices.ts
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
one section per tool, that a missing key errors naming `set_api_key`, and that no key text
ever comes back out. The catalog tests hit the **real** endpoints (both are public reads):
`list_models("stt")` must carry `deepgram/flux` and `soniox/realtime` with their language
notes, and `list_voices({ language: "es" })` must return Spanish voices only, every one of
them a usable `provider/alias` string.

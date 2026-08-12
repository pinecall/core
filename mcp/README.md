# @pinecall/mcp

Pinecall as an **MCP server**. Point a coding agent at it and it can go from zero to a
working voice agent without leaving the editor: read the docs, discover the model/voice/phone
catalog, configure a **dev** agent, iterate on it by chatting with it, and debug real calls
from the call log.

> Status: in progress. Today it ships `whoami`, `set_api_key`, `list_models` and
> `list_voices`; the rest of the journey (`docs_search`, `list_phones`, `list_agents`,
> `configure_agent`, `chat`, `list_calls` / `get_call`, `knowledge`) lands tool by tool.

## Install

```jsonc
// Claude Code / Cursor / any MCP client
{
  "mcpServers": {
    "pinecall": {
      "command": "npx",
      "args": ["-y", "@pinecall/mcp"],
      "env": { "PINECALL_API_KEY": "pk_..." }
    }
  }
}
```

Or run the binary directly: `pinecall-mcp` (stdio transport — stdout is the protocol,
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
  tools/
    types.ts       the ToolModule contract + defineTool()
    index.ts       THE REGISTRY
    whoami.ts
    set-api-key.ts
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

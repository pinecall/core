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
```

`session.ts` imports `apiFetch` from the SDK's own `src/api/http.ts` — there is no second
HTTP client in this package, and the Playground path is the one the CLI's `pinecall account`
uses (`GET /api/orgs/me`).

## Develop

```bash
npm install
npm test          # vitest — boots the server over a REAL stdio transport
npm run build     # tsup → dist/index.js
npm run typecheck
```

The test suite starts the actual server as a subprocess and drives it with the MCP client:
it asserts `tools/list` matches the registry, that `instructions` carries the playbook plus
one section per tool, that a missing key errors naming `set_api_key`, and that no key text
ever comes back out.

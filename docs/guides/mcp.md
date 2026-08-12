---
title: "The MCP Server"
description: "Pinecall as an MCP server — build, run and debug voice agents from Claude Code, Cursor, or any MCP client."
---

# The MCP Server

`@pinecall/mcp` turns Pinecall into a set of MCP tools a coding agent can drive:
read these docs, discover the model/voice/phone catalog, configure a **dev**
agent, iterate on it by chatting with it, wire a phone number, and read the live
call log of a real call — without leaving the editor.

## Install

```bash
pinecall mcp install
```

One command, every IDE — it detects the assistants installed on the machine
(Claude Code, Codex, Antigravity, Cursor, Windsurf, Gemini CLI) and writes the
`pinecall` entry into each one's own config. Re-running repairs a drifted entry;
`--remove` uninstalls. Or by hand, in any MCP client:

```jsonc
{ "mcpServers": { "pinecall": { "command": "npx", "args": ["-y", "@pinecall/mcp"] } } }
```

Auth is `PINECALL_API_KEY` — from the environment, `~/.pinecall/credentials`, or
a read-only scan of your shell rc files (IDEs launch MCP servers without your
shell; the server finds the key anyway and persists it so the scan runs once).

## What it can do

Eighteen tools, in journey order: `whoami` · `set_api_key` · `docs_search` ·
`get_doc` · `knowledge` · `list_models` · `list_voices` · `play_voice` ·
`list_phones` · `list_agents` · `configure_agent` · `run_agent` · `chat` ·
`observe` · `list_calls` · `get_call` · `subscribe` · `byok`.

Three rules shape it:

- **`dev-` only.** `configure_agent` refuses any slug that does not start with
  `dev-`, with no override: registering an agent hot-reloads the live one, so a
  production slug would clobber the process that owns it. Production agents are
  deployed from code.
- **Chat is the testing story.** There is deliberately no spec-runner tool —
  converse with the agent and judge the transcript. (`pinecall test` still
  exists in the [CLI](/reference/cli) for YAML specs.)
- **Real code tools need a process.** A `tool()` with an `execute` function
  cannot travel over MCP; `run_agent` runs your own agent file through the same
  machinery as `pinecall run`, with start/stop/status/logs.

The full tool reference, the safety model and the development setup live in the
package's own repo: [github.com/pinecall/mcp](https://github.com/pinecall/mcp).

## What's next

- [Tools and Functions](/guides/tools-and-functions) — `tool()`, `ephemeral`, `noFollowup`
- [The Call Log](/guides/call-log) — what `observe`/`get_call` read
- [CLI](/reference/cli) — `pinecall mcp install` and everything else

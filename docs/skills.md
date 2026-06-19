---
title: "Agent Skills (@pinecall/skills)"
description: "Drop the Pinecall docs into Claude Code, Cursor, Antigravity, Copilot or any agent that speaks the open Agent Skills format — so your coding agent builds voice & chat agents the right way, offline, with the correct defaults."
---

# Agent Skills

[`@pinecall/skills`](https://github.com/pinecall/skills) packages the entire
Pinecall documentation as **[Agent Skills](https://github.com/agentskills/agentskills)** —
installable into **Claude Code, Google Antigravity, Cursor, GitHub Copilot, Codex**,
or anything that speaks the open Skills format. Your coding agent then knows how
to build Pinecall voice & chat agents **with the right defaults**, offline, without
you pasting docs into the chat.

Each skill is a folder with a `SKILL.md` + a `references/` tree of the real docs
pages, loaded **on demand** (progressive disclosure). The whole package is
**generated from these same docs** (`sdk/docs/`) — one source of truth feeds the
docs site, the [`/ask` knowledge base](/guides/knowledge-bases), and these skills.

## Install

The open installer picks your agent's skills directory and symlinks the skills in:

```bash
npx skills add pinecall/skills
```

Or copy just the skills you want into your agent's skills directory:

| Agent | Directory |
|-------|-----------|
| Claude Code | `.claude/skills/` |
| Google Antigravity | `.agents/skills/` (or the plugin's `skills/`) |
| Cursor / Copilot / others | per the agent's docs |

```bash
cp -R skills/pinecall-guides ~/your-project/.claude/skills/
```

## What's inside

One skill per docs section — install all of them, or only the ones you need:

| Skill | Covers |
|-------|--------|
| `pinecall-quickstart` | Install + your first voice agent |
| `pinecall-concepts` | Agents/Channels/Calls, server vs client LLM, hot reload, topologies |
| `pinecall-guides` | Inbound/outbound, WhatsApp, tools, events, takeover, WebRTC, multi-tenant, testing… |
| `pinecall-examples` | Copy-paste full agents |
| `pinecall-sdk-api` | `@pinecall/sdk` API (Pinecall / Agent / Call / ReplyStream) |
| `pinecall-web-voice` | `@pinecall/web/core` — browser WebRTC voice |
| `pinecall-web-widget` | `@pinecall/web` React widget |
| `pinecall-web-chat` | `@pinecall/web/chat` — text chat |
| `pinecall-web-components` | Framework-agnostic web components |
| `pinecall-reference` | CLI, STT/TTS/LLM providers, events, limits, REST |
| `pinecall-security` | Security model |

## Built-in house rules

Every skill carries the Pinecall **house rules**, so the agent never drifts from
the supported configuration:

- Example defaults: `stt: "deepgram/flux"`, `llm: "openai/gpt-5-chat-latest"`,
  `voice: "elevenlabs/sarah"`. Never `deepgram/nova-2`.
- **Turn detection & VAD are auto-derived from the STT provider — never set
  `turnDetection` or `vad` by hand.** (Flux → native turns + native VAD; every
  other STT → `smart_turn` + `silero`.)
- Greeting: inbound → `greeting` in `pc.agent()`; outbound → `greeting` in
  `agent.dial()`.
- Auth: `new Pinecall()` reads `PINECALL_API_KEY` and auto-connects.

## Staying in sync

The `skills/` tree is **generated and committed**, so `npx skills add` works
offline. Whenever the docs change, the package is regenerated from `sdk/docs/`:

```bash
node build.mjs                      # reads ../sdk/docs by default
DOCS_DIR=/path/to/sdk/docs node build.mjs
```

The generator maps each `docs.json` navigation group to one skill, copies that
group's pages into `references/`, and writes a `SKILL.md` index + the house
rules. No dependencies.

## Related

- [Quickstart](/quickstart) — build your first agent
- [Knowledge bases](/guides/knowledge-bases) — the same docs power the `/ask` agent
- [`@pinecall/sdk` API](/api/pinecall)

---
title: "How it was built"
description: "The build log behind the tutorial — the decisions that were reversed, the two bugs the first real phone call exposed, and what each one cost."
---

# How it was built

[The tutorial](/tutorial/configurable-agent) shows the finished shape, in the order
that makes sense to read. That is not the order it was built in, and the difference
is the useful part: three designs were rejected along the way, and two bugs only
appeared once both halves ran at the same time.

This page is the build log. It is here because the reasoning behind a design is
harder to reconstruct later than the design itself, and because the mistakes are more
instructive than the result.

## The starting tension

The first decision was whether to build this at all, because
[Project Structure](/guides/project-structure) says the opposite:

> Everything about the agent — model, voice, STT, phone number, greeting, prompt —
> belongs in `index.mjs`, where it is diffable and reviewable. If your `.env` grows a
> second row of agent config, that config has escaped code review.

A configurable agent is that rule inverted. Rather than ignore it, the resolution was
to make the exception explicit and narrow: the clinic edits what a receptionist would
(name, greeting, voice, language, hours, services); everything with a cost — the
model, the STT provider, which tools exist — stays in the repository. Both halves meet
in one function, `toAgentConfig()`, so the boundary is a diff rather than an argument.

Every later decision followed from that line.

## Three designs that were rejected

### A server inside the agent

The first sketch gave the agent an HTTP endpoint: the console saves, then `POST`s to
`/reload`, and the agent re-reads. It works, and it was rejected on shape. An agent
that listens on a port is a service: something has to be able to reach it, which is a
routing problem in development and a networking problem in production. The agent
should be a process that connects out, like every other Pinecall agent.

### Polling the store

With no server in the agent, the obvious fallback is for the agent to look: read the
store every few seconds, compare a timestamp, apply what changed. Twelve lines, no
infrastructure — and a few seconds of lag on every edit, plus thousands of daily reads
that answer "nothing changed".

It was written, and then thrown away, because it solves a problem that only exists if
you assume push requires a server. It does not:

> In SSE the **agent is the client**. It makes an outbound connection to the console
> and holds it open. An outbound connection is not a server: no port, no inbound
> route, no NAT problem — the same posture the agent already has toward Pinecall.

That reframing is the single most useful idea in the tutorial, and it arrived by
questioning a constraint that had been accepted too quickly.

### Configuring from the console's own process

A tempting shortcut: since the console has the API key, let *it* call
`agent.update()`. This is impossible, and the reason is worth stating precisely
because it shapes the whole architecture:

`agent.update()` writes to the WebSocket **the agent opened**. Only the process
holding that socket can use it. No REST call, no key, no privilege makes the console
able to reconfigure a running agent on its behalf — the change has to originate in
the agent's own process.

Minting a browser token, by contrast, *is* just an HTTP call carrying the org's API
key, so any trusted server can do it. Those two facts look similar and are opposites,
and mixing them up is how the token endpoint ends up in the wrong process.

## Two bugs the first real call exposed

Both were found by actually calling the agent — neither would have shown up in code
review.

### It spoke markdown

The first transcript came back like this:

```
🦷 Genial, Marta 🙂 Ya te he reservado la limpieza dental para el 24 de agosto
   a las 10:30. La referencia es `CD-08241030`.
```

An emoji and a backticked code span: invisible in a chat window, nonsense read out
loud. The prompt already said "sin listas ni markdown" and that was not enough,
because it named a format instead of a reason. What worked was telling the model what
happens to its output:

```
Todo lo que escribas se va a LEER EN VOZ ALTA, así que:
- Frases cortas, como habla una persona. Nunca listas, viñetas ni markdown.
- Nada de emojis ni asteriscos ni comillas de código: no se pueden pronunciar.
- Ofrece dos horas como mucho, no una lista entera.
- Los códigos y números se dicen despacio y dígito a dígito.
```

The same call also read six free slots in a row, which is unusable on the phone. That
one was not fixed in the prompt at all — the **tool** now returns three. The model
offers what you hand it, so shaping a tool's output is more reliable than asking the
prompt to be brief.

### It confirmed an appointment that did not exist

The worse bug. The agent booked a slot, said the reference out loud, and the console's
agenda stayed empty.

The appointment book was a `Map` at module scope. The agent and the console are **two
processes**, so each had imported its own copy: the agent booked into its memory, and
the console rendered from a different, untouched one. Nothing errored. The call sounded
perfect.

The fix was to make the book a file, like the settings already were. The rule it
taught is the one worth carrying:

> Anything two processes share must live somewhere both can see. In this app that is
> the settings **and** the appointment book — and a `Map` at module scope looks
> exactly like shared state until you run the second process.

A related symptom appeared right after: the console kept serving the old shape until
it was restarted, because it had loaded the previous version of the module at boot.
Worth knowing when a fix "does not work" while both processes are still running.

## Smaller corrections

**`tool()` takes a Zod schema.** The first version of `tools.mjs` passed a
JSON-Schema `parameters` object, which is what many APIs accept. It threw at boot.
The SDK's shape is `schema: z.object({ … })`, and `.describe()` on each field is not
decoration — it is what the model reads to decide what to put there. See
[Tools and Functions](/guides/tools-and-functions).

**A registration conflict is not a failure to fix.** During iteration a second agent
process was started while the first still held the slug, and the server refused it:

```
✗ Agent "dental-desk" is held by a LIVE process — not retrying.
  Run pinecall kick dental-desk to disconnect the current holder.
```

That refusal is the protection working: one live process owns a slug, so the change
you are testing cannot be silently answered by the old build. The confusing part is
that the *old* process keeps answering perfectly — which for a minute looks like your
edit had no effect.

**The token endpoint needs the agent online.** Minting returned
`Agent 'dental-desk' is not online` before the agent was started. It is a clear error,
and it establishes the order: the agent registers, then browsers can connect.

## What it cost

| | |
|---|---|
| Repository | 24 files, ~1,200 lines, much of it comments |
| Processes | 2 — the console and the agent |
| Pinecall surface used | `pc.agent()`, `agent.update()`, `call.setPromptVars()`, `tool()`, `createToken()`, `<VoiceWidget>` |
| Lines that make it configurable | the SSE endpoint (~20), the SSE client (~40), `toAgentConfig()` (~25) |

The last row is the point. Making an agent configurable from a UI is not a framework
or a platform feature — it is one translator function, one outbound connection, and a
clear line about which settings are allowed to move.

## What's next

- [An agent your customer can configure](/tutorial/configurable-agent) — the tutorial itself
- [Hot-Reload](/concepts/hot-reload) — the mechanism the whole design rests on
- [Multi-Tenant Dashboards](/guides/multi-tenant) — where this app goes next

---
title: "Build a Live Call App"
description: "Step by step: a restaurant voice agent you can talk to from the browser, call by phone, and watch live — Soniox STT, Mistral Small, ElevenLabs."
---

# Build a Live Call App

This guide builds a complete app, step by step: **Bistro Aurora**, a restaurant
host that

- answers a **real phone number**,
- takes **browser voice calls** (WebRTC, mic in the page),
- books tables with a **tool**, and
- has a **live dashboard**: every phone call appears in the browser the moment
  it rings, transcript streaming in real time — powered by the
  [call log](/guides/call-log).

Pipeline: **Soniox** (STT) → **Mistral Small** (LLM) → **ElevenLabs** (TTS).
Two processes: a Node agent (~80 lines) and a React app.

```
 caller ☎ ──┐
            ├─▶ Pinecall voice server ──▶ call log (seq, cursor)
 browser 🎙 ─┘        ▲      │                    │
                      │      ▼                    ▼
              agent process (Node)         React app (watch tab)
              prompt · tool · tokens       useAgentCalls + useCall
```

## 0. Project layout

```bash
mkdir bistro && cd bistro
mkdir agent web
npm init -y
npm install @pinecall/sdk zod
```

Set your key once:

```bash
export PINECALL_API_KEY=pk_...
```

## 1. The agent process

`agent/index.mjs` — the whole backend. It does exactly two jobs: **define the
agent** (prompt, pipeline, tool, phone number) and **mint tokens** (the API key
never reaches the browser).

```javascript
import { createServer } from "node:http";
import { Pinecall, tool } from "@pinecall/sdk";
import { z } from "zod";

const SLUG = "bistro";
const PORT = 8790;
const pc = new Pinecall();

// ── the tool ──────────────────────────────────────────────────────────
const bookTable = tool({
  name: "book_table",
  description:
    "Book a table. Call it exactly once, only when you know the day, the time and how many people.",
  schema: z.object({
    day: z.string(),
    time: z.string(),
    people: z.number().int().min(1).max(20),
  }),
  execute: async ({ day, time, people }) => {
    const reference = "R-" + Math.random().toString(36).slice(2, 7).toUpperCase();
    return { ok: true, reference, day, time, people };
  },
});

// ── the agent ─────────────────────────────────────────────────────────
const agent = pc.agent(SLUG, {
  prompt: `You are the host at Bistro Aurora, a small bistro.
Take table reservations. Ask for ONE detail at a time: day, then time,
then party size. Confirm before booking. Speak — never use markdown,
lists or emojis; everything you say is read aloud.`,
  stt: "soniox/realtime",
  llm: "mistral/mistral-small-latest",
  voice: "elevenlabs/sarah",
  language: "en",
  greeting: "Bistro Aurora, good evening — how can I help?",
  tools: [bookTable],
  phoneNumber: "+13186330963", // a number from your Pinecall org
});

// ── token endpoints ───────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  try {
    if (req.url === "/api/token")
      return res.end(JSON.stringify(await agent.createToken("webrtc")));
    if (req.url === "/api/observer-token")
      return res.end(JSON.stringify(await pc.createToken("stream", SLUG)));
    if (req.url === "/health") return res.end('"ok"');
    res.statusCode = 404;
    res.end('"not found"');
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e?.message ?? e) }));
  }
});
server.listen(PORT, "127.0.0.1", () =>
  console.log(`bistro agent — tokens on :${PORT}`),
);
```

Run it:

```bash
node agent/index.mjs
```

The phone number is live right now — call it and the agent answers. Everything
else in this guide is about the **browser**.

Two different tokens, two different powers:

| Endpoint | Mints | Grants |
|---|---|---|
| `/api/token` | `createToken("webrtc")` | **participate** — join a call with a mic |
| `/api/observer-token` | `createToken("stream", SLUG)` | **observe** — read this agent's [call log](/guides/call-log), no mic, no voice |

> In production, put your own auth in front of both endpoints — a token is a
> capability, mint it only for users who should have it.

## 2. The web app

```bash
cd web
npm create vite@latest . -- --template react
npm install @pinecall/web
```

Proxy the token endpoints to the agent process in `vite.config.js`:

```javascript
export default {
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:8790" } },
};
```

## 3. Talk — a voice call from the page

`useVoiceSession` owns the entire WebRTC session. The page is just a projection
of its state — you write **zero** socket or audio code.

```jsx
// web/src/App.jsx
import { useState } from "react";
import { useVoiceSession } from "@pinecall/web";
import { Observer } from "./Observer.jsx";

const tokenProvider = async () => {
  const res = await fetch("/api/token");
  if (!res.ok) throw new Error(`token endpoint: ${res.status}`);
  return res.json();
};

export function App() {
  const [tab, setTab] = useState("talk");
  const s = useVoiceSession({
    agent: "bistro",
    tokenProvider,
    trackedTools: ["book_table"],
  });

  return (
    <main>
      <nav>
        <button onClick={() => setTab("talk")}>🎙 talk</button>
        <button onClick={() => setTab("watch")}>📡 watch the phone line</button>
      </nav>

      {tab === "watch" && <Observer />}
      {tab === "talk" && (
        <>
          {s.status !== "connected" ? (
            <button onClick={s.connect}>📞 Call the restaurant</button>
          ) : (
            <button onClick={s.disconnect}>hang up</button>
          )}

          {s.messages.map((m) => (
            <p key={m.id}>
              <b>{m.role === "bot" ? "host" : "you"}</b> {m.text}
              {m.isInterim && "▌"}
            </p>
          ))}

          {s.toolCalls.map((t) => (
            <div key={t.toolCallId}>
              ⚙ {t.name} {t.result ? `→ booking ${t.result.reference}` : "…"}
            </div>
          ))}
        </>
      )}
    </main>
  );
}
```

What the hook gives you: `s.messages` (interim + final transcripts, both
sides), `s.toolCalls` (with `.result` once the tool ran), `s.phase`
(`listening` / `speaking`), `s.connect` / `s.disconnect` / `s.toggleMute`.

## 4. Watch — the phone line, live in the browser

This is the part most platforms cannot do: **observe calls you are not in**,
with nothing but a token. Two hooks, chained — that chain *is* the design:

1. `useAgentCalls(agent)` tails the **agent log** → *which calls exist, which
   are live*.
2. `useCall({ call })` tails **that call's log** → transcript, tools, phase.

```jsx
// web/src/Observer.jsx
import { useEffect, useState } from "react";
import { useAgentCalls, useCall } from "@pinecall/web/log/react";

const AGENT = "bistro";

export function Observer() {
  const [auth, setAuth] = useState(null); // { token, server }
  useEffect(() => {
    fetch("/api/observer-token").then((r) => r.json()).then(setAuth);
  }, []);
  if (!auth) return <p>minting observe token…</p>;
  return <Board token={auth.token} server={auth.server} />;
}

function Board({ token, server }) {
  const { calls, live } = useAgentCalls(AGENT, { token, server });
  const [watching, setWatching] = useState(null);

  // auto-open the first live call the moment it starts
  useEffect(() => {
    if (!watching && live.length > 0) setWatching(live[0].call);
  }, [watching, live]);

  return (
    <section>
      <p>📡 {live.length} live / {calls.length} total</p>
      {calls.map((c) => (
        <button key={c.call} onClick={() => setWatching(c.call)}>
          {c.live ? "🔴" : "⏹"} {c.direction} · {c.from}
        </button>
      ))}
      {watching && <Watch call={watching} token={token} server={server} />}
    </section>
  );
}

function Watch({ call, token, server }) {
  const s = useCall({ call, token, server });
  return (
    <div>
      <p>{s.live ? "🔴 live" : "⏹ ended"} · {s.caughtUp ? "caught up" : "catching up…"}</p>
      {s.messages.map((m) => (
        <p key={m.seq ?? m.id}>
          <b>{m.role === "bot" ? "host" : "caller"}</b> {m.text}
        </p>
      ))}
      {s.toolCalls.map((t) => (
        <p key={t.id}>⚙ {t.name} {t.result?.reference && `→ ${t.result.reference}`}</p>
      ))}
    </div>
  );
}
```

Note the import: **`@pinecall/web/log/react`** — the hooks live under
`/log/react`; `@pinecall/web/log` is the framework-free layer
(`CallLogView`, `tail`, `poll`).

## 5. Run the whole thing

```bash
node agent/index.mjs   # terminal 1 — agent + tokens
cd web && npm run dev  # terminal 2 — the page
```

Open the page, go to **watch**, and **call the phone number from your own
phone**. The call appears in the list the moment it rings; click it (or let it
auto-open) and the transcript streams as you speak. Hang up — the row flips to
*ended*, and the full transcript stays readable: history and live are the same
log, read from a different cursor.

## What you did NOT build

- No WebSocket handling — the hooks own attach/reconnect/cursor resume.
- No event bus, no webhook receiver, no polling loop with gaps.
- No audio code — WebRTC, VAD, barge-in, TTS are the server's job.
- No key exposure — the browser only ever held two scoped, short-lived tokens.

## What's next

- [The Call Log](/guides/call-log) — the model that made the watch tab possible
- [Tools and functions](/guides/tools-and-functions) — richer tools
- [Multi-Tenant](/guides/multi-tenant) — one dashboard per customer, sealed by
  the token's agent set

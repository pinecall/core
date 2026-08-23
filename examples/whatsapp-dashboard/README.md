# WhatsApp dashboard — taking the conversation off the agent

A WhatsApp support agent that a human can step into, mid-conversation, and step
back out of. Three calls do the work:

| call | what happens |
|---|---|
| `agent.pause(sessionId)` | the model stops replying to *that* conversation; messages keep arriving |
| `agent.sendMessage({ sessionId, text })` | the operator answers in its place |
| `agent.resume(sessionId)` | the agent takes over again — with what the human said already in context |

Watching is the other half, and the server does none of it. It mints a
read-only **Call Log** token — `agent.createToken("stream", undefined, { scope:
"observe" })` — and the browser reads the log straight from Pinecall over SSE:

```
WhatsApp ──▶ voice.pinecall.io ──WS──▶ server.mjs
                    │                      ▲
              SSE (call log)               └── pause / send / resume (REST)
                    ▼                      │
              dashboard (client/) ─────────┘
```

Two hooks from `@pinecall/web/log/react` are the whole reader:

| hook | what it gives |
|---|---|
| `useAgentCalls(agent, { token })` | one row per conversation — the agent log is lifecycle-only: which calls exist, which are live |
| `useCall({ call, token })` | that conversation's messages, tool calls and takeover state |

Nothing is fanned out through Node, so the dashboard survives a server restart
and a second operator tab costs the server nothing.

This is the one example with a `client/` folder, because a takeover UI needs a
UI. Everything Pinecall does is in `server.mjs`; `client/` is a single React
component reading the log.

## Run it

```bash
npm install
npm run build           # builds client/dist — the server refuses to start without it
cp .env.example .env    # then fill in the Meta credentials
npm start
```

Then point your Meta app's webhook at `https://voice.pinecall.io/whatsapp/webhook`,
subscribe to the `messages` field, and use the same verify token you put in
`.env`. The [WhatsApp guide](https://docs.pinecall.io/guides/whatsapp) has the
Meta-side walkthrough.

| env | what |
|---|---|
| `PINECALL_API_KEY` | your key |
| `AGENT` | the slug to register as (default `whatsapp-dashboard`) |
| `WA_PHONE_NUMBER_ID` | Meta Cloud API phone number **id**, not the number |
| `WA_ACCESS_TOKEN` | Meta access token |
| `WA_VERIFY_TOKEN` | the verify token you typed into the Meta console |
| `WA_APP_SECRET` | optional — verifies the webhook signature |
| `PORT` | dashboard port (default `3000`) |

## What you will see

`Agent 'whatsapp-dashboard' ready on WhatsApp` and `Dashboard on
http://localhost:3000`. Message your Business number: the console prints the
inbound line and the bot's reply, and both appear in the dashboard as they
happen. Hit **Pause AI** — new messages arrive tagged `[paused]` and the model
stays quiet. Type a reply yourself, then **Resume AI**: the agent picks the
thread back up knowing what you said.

Reload the page mid-conversation: the log resumes from the cursor it stored
rather than replaying from the top.

Conversations are saved to `./data/conversations.json` via `JsonFileHistory`
and reloaded from `/api/history` — that is what fills in conversations old
enough to have aged out of the log. Both `data/` and `client/dist/` are
gitignored — they are build and runtime artifacts, not source.

## Files

```
server.mjs           the agent, the observe-token mint and the takeover API
client/src/App.jsx   the dashboard, one React component over @pinecall/web/log
client/vite.config.js  dev-server proxy to :3000
```

| server route | why it exists |
|---|---|
| `GET /api/token` | mints the read-only `observe` token the browser watches with. `PINECALL_API_KEY` never leaves the server |
| `GET /api/state` | which conversations the operator has paused — pausing has no log entry of its own |
| `POST /api/pause|resume|send/:sessionId` | the three takeover verbs |
| `GET /api/history` | conversations saved by `JsonFileHistory` |

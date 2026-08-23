# WhatsApp dashboard — taking the conversation off the agent

A WhatsApp support agent that a human can step into, mid-conversation, and step
back out of. Three calls do the work:

| call | what happens |
|---|---|
| `agent.pause(sessionId)` | the model stops replying to *that* conversation; messages keep arriving |
| `agent.sendMessage({ sessionId, text })` | the operator answers in its place |
| `agent.resume(sessionId)` | the agent takes over again — with what the human said already in context |

`agent.stream(res)` is the other half: point an SSE response at it and the
browser sees every message, pause and resume live.

```
WhatsApp ──▶ voice.pinecall.io ──WS──▶ server.mjs ──SSE──▶ dashboard (client/)
                                            ▲                     │
                                            └── pause / send / resume (REST)
```

This is the one example with a `client/` folder, because a takeover UI needs a
UI. Everything Pinecall does is in `server.mjs`; `client/` is a single React
component reading the stream.

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

Conversations are saved to `./data/conversations.json` via `JsonFileHistory`
and reloaded from `/api/history`. Both `data/` and `client/dist/` are
gitignored — they are build and runtime artifacts, not source.

## Files

```
server.mjs           the agent, the SSE stream and the takeover API
client/src/App.jsx   the dashboard, one React component
client/vite.config.js  dev-server proxy to :3000
```

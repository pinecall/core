# WhatsApp Dashboard — Human Takeover Example

A WhatsApp support agent with a live dashboard for human operators to monitor conversations, pause the AI, send messages manually, and resume.

## Architecture

```
React Dashboard (Vite :5173)  ←SSE→  Express Server (:3000)  ←WS→  voice.pinecall.io
         │                                   │
         └── REST (pause/resume/send) ──────►│
                                             └── JsonFileHistory → ./data/conversations.json
```

## Setup

### 1. Prerequisites

- Node.js 18+
- A [Pinecall](https://pinecall.io) API key
- A Meta Business app with WhatsApp configured ([setup guide](https://pinecall.io/docs/guides/whatsapp))

### 2. Install

```bash
npm install
cd client && npm install && cd ..
```

### 3. Configure environment

```bash
export PINECALL_API_KEY="pk_..."
export WA_PHONE_NUMBER_ID="123456789012345"
export WA_ACCESS_TOKEN="EAAxxxxxxx..."
export WA_APP_SECRET="abc123..."           # optional, recommended
export WA_VERIFY_TOKEN="my-verify-token"   # optional, default: pinecall-wa-verify
```

### 4. Configure Meta webhook

In your Meta app dashboard, set the webhook URL to:

```
https://voice.pinecall.io/whatsapp/webhook
```

Subscribe to the `messages` field. The verify token must match `WA_VERIFY_TOKEN`.

### 5. Run

```bash
# Terminal 1 — backend
npm start

# Terminal 2 — dashboard
cd client && npm run dev
```

Open http://localhost:5173 — the dashboard will show live WhatsApp conversations.

## Usage

1. **Send a WhatsApp message** to your Business number — it appears in the dashboard
2. **AI responds automatically** — the agent handles the conversation
3. **Pause AI** — click "⏸ Pause AI" to take over
4. **Send as human** — type messages in the input bar while paused
5. **Resume AI** — click "▶ Resume AI" to hand back to the agent

The AI resumes with full context of what the human said.

## Conversation History

Conversations are automatically saved to `./data/conversations.json` via `JsonFileHistory`. Past conversations load from `/api/history`.

## Files

```
server.js              Express backend (agent + SSE + REST API)
client/
  src/App.jsx          React dashboard (single component)
  src/index.css        Dark theme styles
  vite.config.js       Vite config with API proxy
```

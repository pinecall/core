---
title: "Example: Browser Widget"
description: "Complete Next.js app with backend agent, token endpoint, and React VoiceWidget."
---

# Example: Browser Widget

A complete Next.js (App Router) example: backend agent, token endpoint, and React widget. Users land on the page, click the orb, and have a voice conversation with your agent — no phone number needed.

## Project structure

```
my-app/
├── app/
│   ├── api/
│   │   └── token/
│   │       └── route.ts      # mints WebRTC tokens
│   ├── page.tsx              # renders the widget
│   └── layout.tsx
├── agent.ts                  # the agent (runs on server boot)
├── lib/
│   └── pinecall.ts           # singleton Pinecall + agent
└── package.json
```

## Install

```bash
npm install @pinecall/sdk @pinecall/voice-widget
```

## 1. Define the agent (`lib/pinecall.ts`)

Singleton pattern — one `Pinecall` instance per Next.js process, reused across requests.

```typescript
// lib/pinecall.ts
import { Pinecall } from "@pinecall/sdk";

declare global {
  var __pinecall: Pinecall | undefined;
}

async function init() {
  const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });
  await pc.connect();

  const mara = pc.deploy("mara", {
    prompt: `You are Mara, a friendly assistant for our app.

Help users navigate features, answer questions about pricing,
and escalate to human support when needed.

Be brief. Keep responses under 2 sentences when possible.`,
    model: "gpt-4.1-mini",
    voice: "elevenlabs:EXAVITQu4vr4xnSDxMaL",
    language: "en",
    channels: ["webrtc"],
    tools: [
      {
        type: "function",
        function: {
          name: "getPricing",
          description: "Return the current pricing tiers.",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  });

  mara.on("call.started", (call) => {
    call.say("Hi! I'm Mara. How can I help?");
  });

  mara.on("llm.tool_call", async (data, call) => {
    const results = [];
    for (const tc of data.toolCalls) {
      let result;
      if (tc.name === "getPricing") {
        result = {
          free: "$0/month — basic features",
          pro: "$29/month — advanced features",
          team: "$99/month — collaboration",
        };
      }
      results.push({ toolCallId: tc.id, result });
    }
    call.toolResult(data.msgId, results);
  });

  return pc;
}

// Reuse across hot-reloads in dev
export const pc = globalThis.__pinecall ?? (await init());
if (process.env.NODE_ENV !== "production") globalThis.__pinecall = pc;
```

## 2. Token endpoint (`app/api/token/route.ts`)

Behind your auth. This example uses a simple session check — replace with your real auth (NextAuth, Clerk, custom).

```typescript
// app/api/token/route.ts
import { pc } from "@/lib/pinecall";
import { cookies } from "next/headers";

export async function GET() {
  // Your auth check
  const session = cookies().get("session")?.value;
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Rate limit per user
  // ... your rate limit logic here ...

  const token = await pc.createToken("webrtc", "mara");
  return Response.json(token);
}
```

## 3. The page (`app/page.tsx`)

```tsx
// app/page.tsx
"use client";

import { VoiceWidget } from "@pinecall/voice-widget";

export default function HomePage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full p-8 bg-white rounded-2xl shadow-sm">
        <h1 className="text-2xl font-semibold mb-2">Need help?</h1>
        <p className="text-gray-600 mb-6">
          Click the orb below to talk to Mara, our AI assistant.
        </p>

        <VoiceWidget
          agent="mara"
          tokenProvider={async () => {
            const res = await fetch("/api/token", { credentials: "include" });
            if (!res.ok) throw new Error("Could not get token");
            return res.json();
          }}
        />
      </div>
    </main>
  );
}
```

## 4. Run it

```bash
PINECALL_API_KEY=pk_... npm run dev
```

Open `http://localhost:3000`. Click the orb. Talk.

## Adding a transcript UI

The widget accepts callback props for events. Build a live transcript by appending messages to React state:

```tsx
"use client";

import { useState } from "react";
import { VoiceWidget } from "@pinecall/voice-widget";

type Message = { role: "user" | "bot"; text: string };

export default function HomePage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentBot, setCurrentBot] = useState("");

  return (
    <main className="min-h-screen flex flex-col items-center p-8 bg-gray-50">
      <div className="max-w-2xl w-full">
        <h1 className="text-2xl font-semibold mb-6">Chat with Mara</h1>

        <div className="bg-white rounded-2xl p-6 min-h-[400px] mb-6 space-y-3">
          {messages.map((m, i) => (
            <div
              key={i}
              className={m.role === "user" ? "text-blue-600" : "text-gray-800"}
            >
              <span className="font-medium">
                {m.role === "user" ? "You: " : "Mara: "}
              </span>
              {m.text}
            </div>
          ))}
          {currentBot && (
            <div className="text-gray-800 opacity-60">
              <span className="font-medium">Mara: </span>
              {currentBot}
            </div>
          )}
        </div>

        <div className="flex justify-center">
          <VoiceWidget
            agent="mara"
            tokenProvider={async () => {
              const res = await fetch("/api/token", { credentials: "include" });
              return res.json();
            }}
            onUserMessage={(text) =>
              setMessages((m) => [...m, { role: "user", text }])
            }
            onBotWord={(word) => setCurrentBot((s) => s + word + " ")}
            onBotFinished={() => {
              setMessages((m) => [...m, { role: "bot", text: currentBot.trim() }]);
              setCurrentBot("");
            }}
          />
        </div>
      </div>
    </main>
  );
}
```

## Production checklist

Before shipping this to real users:

- [ ] **Auth on the token endpoint** — never expose `pc.createToken()` without a real session check
- [ ] **Rate limit** — cap tokens per user per hour
- [ ] **Per-tenant scoping** — if multi-tenant, verify the user owns the agent they're requesting tokens for (see [Multi-tenant guide](/docs/guides/multi-tenant))
- [ ] **Error UI** — show fallback messaging when `tokenProvider` rejects
- [ ] **Mic permission UX** — explain why you need mic access before the user clicks
- [ ] **Conversation logging** — persist `call.transcript` and `call.messages` for audit/QA
- [ ] **Session limits** — set `sessionLimits.max_duration_seconds` appropriate to your use case

## What's next

- [Security](/docs/security) — production auth model
- [Multi-tenant](/docs/guides/multi-tenant) — per-user/per-tenant token scoping
- [Headless agent example](/docs/examples/headless-agent) — for pure backend agents

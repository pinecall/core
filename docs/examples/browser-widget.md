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
│   ├── api/token/route.ts    # mints WebRTC tokens
│   ├── page.tsx              # renders the widget
│   └── layout.tsx
├── lib/pinecall.ts           # singleton Pinecall + agent
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
  });

  mara.on("call.started", (call) => {
    call.say("Hi! I'm Mara. How can I help?");
  });

  return pc;
}

// Reuse across hot-reloads in dev
export const pc = globalThis.__pinecall ?? (await init());
if (process.env.NODE_ENV !== "production") globalThis.__pinecall = pc;
```

## 2. Token endpoint (`app/api/token/route.ts`)

Behind your auth. Replace the session check with your real auth (NextAuth, Clerk, custom).

```typescript
// app/api/token/route.ts
import { pc } from "@/lib/pinecall";
import { cookies } from "next/headers";

export async function GET() {
  const session = cookies().get("session")?.value;
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

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
    <main className="min-h-screen flex items-center justify-center">
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

## Adding tools

Add tools to the agent and handle them server-side. The widget just renders — tools execute on your backend:

```typescript
// In lib/pinecall.ts, add to the deploy config:
const mara = pc.deploy("mara", {
  // ...existing config...
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

// Handle tools
mara.on("llm.tool_call", async (data, call) => {
  const results = await Promise.all(
    data.toolCalls.map(async (tc) => ({
      toolCallId: tc.id,
      result: tc.name === "getPricing"
        ? { free: "$0/mo", pro: "$29/mo", team: "$99/mo" }
        : { error: `unknown: ${tc.name}` },
    }))
  );
  call.toolResult(data.msgId, results);
});
```

For **interactive tools** that render UI in the browser (slot pickers, forms), see the [Tools API guide](/voice-widget/tools-api).

## Production checklist

- [ ] **Auth on the token endpoint** — never expose `pc.createToken()` without a session check
- [ ] **Rate limit** — cap tokens per user per hour
- [ ] **Error UI** — show fallback when `tokenProvider` rejects
- [ ] **Mic permission UX** — explain why you need mic access before the click

## What's next

- [Security](/security) — production auth model
- [Tools API](/voice-widget/tools-api) — interactive tool UI in the browser
- [Headless agent example](/examples/headless-agent) — for backend-only agents

# Realtime Speech-to-Speech (OpenAI)

Run your voice agent on OpenAI's **Realtime speech-to-speech models** instead of
the classic STT → LLM → TTS pipeline. One model listens and speaks directly —
lower latency, more natural prosody, and native barge-in handling.

## Enable it

Set the server-side LLM to a realtime model. That's it:

```ts
const agent = pc.agent("receptionist", {
  llm: "pinecall/gpt-realtime",
  instructions: "You are a warm, concise phone receptionist for Bella Vista.",
  greeting: "Hi! Thanks for calling Bella Vista — how can I help?",
  tools: [checkReservation],
});
agent.addChannel("phone", "+19035551234");
```

Any model whose name contains `realtime` activates the mode
(`gpt-realtime`, `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, …).

## What changes under the hood

| | Classic pipeline | Realtime S2S |
|---|---|---|
| STT | Deepgram / Gladia / … | built into the model |
| Turn detection / VAD | smart_turn / silero | built into the model |
| TTS | ElevenLabs / Cartesia / … | built into the model |
| Barge-in | server energy + VAD | native (model interrupts itself) |
| Billing | STT min + LLM tokens + TTS chars | LLM **audio tokens** only (+ telephony) |

Because the model owns the whole audio path, `stt`, `tts`/`voice`,
`turnDetection`, `vad` and `interruption` config are **ignored** in this mode.
The speaking voice is one of OpenAI's realtime voices — default `marin`,
override with:

```ts
config: { realtime: { voice: "cedar" } }
```

## What still works exactly the same

- **Channels**: phone (Twilio) and WebRTC (browser) — same `addChannel` calls.
- **Greeting**: the `greeting:` field (or one `call.say` on `call.started`) —
  the realtime model speaks it verbatim.
- **Tools**: same `tools` definitions, same SDK execution — the server sends
  `llm.tool_call`, your handlers run locally, results go back mid-call.
- **Events**: `call.started`, `user.message`, `turn.end`, `bot.speaking`,
  `bot.finished`, `bot.interrupted`, `call.ended` (with the full transcript).
- **`call.say(text)`**: speaks the exact text through the realtime voice.
- **Prompt vars**: built-in `{{date}}`, `{{time}}`, `{{day}}`, `{{datetime}}`
  resolve at session start (with the agent's `timezone`).

## Not supported (yet) in realtime mode

- Skills (`skill()` progressive disclosure)
- Knowledge bases / RAG (`knowledgeBase`)
- Per-word captions (`bot.word`) and hold music
- Custom `setPromptVars` refresh per turn (vars resolve once at call start)

If you need any of these, stay on the classic pipeline for that agent.

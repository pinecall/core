# Phone line — a front desk with no agent in it

`pc.line()` claims a phone number and answers it with **code**: a greeting the instant
the call connects, one menu, and every branch decided by an `if` — no prompt, no model,
no tokens until the caller asks for the assistant.

```
  call connects ──▶ "Thanks for calling Mill Street Dental."
                    "Press 1 for opening hours, 2 for our address,
                     3 to speak to somebody, or 0 for our assistant."
                      ├─ 1 ──▶ say(hours)        ──▶ hangup
                      ├─ 2 ──▶ say(address)      ──▶ hangup
                      ├─ 3 ──▶ forward(HUMAN)         (the call LEAVES Pinecall)
                      └─ 0 ──▶ routeTo(AGENT)         (the LIVE call is handed to an agent)
```

A press cuts the menu short. Silence gets one repeat, then a polite goodbye.

## Run it

```bash
npm install
cp .env.example .env    # then fill in PINECALL_API_KEY and LINE_NUMBER
npm start
```

| env | what |
|---|---|
| `PINECALL_API_KEY` | your key |
| `LINE_NUMBER` | a number in your org this line will own (E.164) — `pinecall phones` lists them |
| `AGENT` | the agent slug option `0` hands the call to (it must be online to take it) |
| `HUMAN` | a real phone number option `3` forwards to (optional — empty and option 3 apologises) |

Then call `LINE_NUMBER`. You hear the greeting right away; press a digit.

## What you are looking at

- **`pc.line(number, { stt, voice, language, extension: { window: 0 } })`** — the line's own
  STT and TTS, and *no* post-dial extension window: a window lets `+1…,10` skip the menu,
  but it is 2.5 s of silence for every caller, which is the wrong trade on a front line.
- **`await call.say(text)`** resolves when the audio has finished playing.
- **`await call.ask(text, { digits: 1, timeout })`** speaks and waits for the keypad. A
  press made while the line is still talking resolves at once and cuts the audio.
- **`call.forward(number)`** leaves Pinecall — a real phone rings, nothing you do reaches
  the call after that.
- **`await call.routeTo(agent, { context })`** keeps the call inside Pinecall: same audio
  stream, no re-dial. The agent receives a normal `call.started` with `routedFrom`,
  `lineTranscript` and your `context`. `{ ok: false, reason }` if the agent is offline —
  the line decides what to say.
- **`call.transcript`** — everything the line and the caller said, printed on `call.ended`.

## Test it without a phone

```bash
npm run smoke
```

Stands up a mocked voice server on localhost and drives `server.mjs` — unmodified —
through every branch: the greeting, the menu, option 1 (hours + hangup) and option 0
pressed *during* the menu (hand-over, audio cut). Verified against the real voice server
on a real number as well; the smoke is what keeps it honest on every change.

Docs: [Phone lines](https://docs.pinecall.io/guides/phone-lines).

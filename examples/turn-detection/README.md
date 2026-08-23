# Turn detection — watch the agent decide you are done

Turn-taking is the invisible half of a voice agent: who is speaking, when a
pause is a pause and when it is the end of a sentence, and what happens when
you talk over the bot. This example adds no behaviour at all — it subscribes to
every turn event and draws the state machine, one box per turn.

```
IDLE ──speech.started──▶ LISTENING ──turn.pause──▶ (still LISTENING)
                                   ──turn.end────▶ BOT_PENDING
                                                        │
     ◀──bot.finished── BOT_SPEAKING ◀──bot.speaking─────┘
                            │
                            └──bot.interrupted──▶ LISTENING (barge-in)
```

`MODEL` picks who makes the call:

| `MODEL` | STT | turn detection |
|---|---|---|
| `flux` | `deepgram/flux` | native — built into the STT, the fastest path |
| `nova` | `deepgram/nova-3` | SmartTurn + Silero VAD, activated server-side |

## Run it

```bash
npm install
cp .env.example .env    # then fill in PINECALL_API_KEY
npm start
```

| env | what |
|---|---|
| `PINECALL_API_KEY` | your key |
| `AGENT` | the slug to register as (default `turn-detection`) |
| `PHONE` | a number in your org to answer on (E.164). Empty → browser only |
| `MODEL` | `flux` or `nova` (default `flux`) |
| `STT_LANG` | `en`, `es`, `ar`, `fr`, `de`, `pt` — sets STT language and voice. Not `LANG`: the shell owns that name |

## What you will see

A header naming the STT and turn detector, then a box per turn:
`speech.started`, the partial transcript as it firms up, `turn.pause` with the
probability that did *not* convince the detector, the transition to
`BOT_PENDING`, the reply streaming in word by word, and `bot.finished` with its
duration. Interrupt the agent mid-sentence and the box gets an `⚡ INTERRUPTION`
divider showing how many milliseconds of audio played before you cut in.

Run it once with `MODEL=flux` and once with `MODEL=nova` and compare where the
pauses fall — that comparison is the whole example.

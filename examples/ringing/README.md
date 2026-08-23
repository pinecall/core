# Ringing — decide before you answer

Register a number with `{ ringing: true }` and inbound calls stop at
`call.ringing` instead of being answered for you. You see who is calling while
the line is still ringing and choose: `call.accept()` or `call.reject("busy")`.

A rejected call is never answered — no audio, no model, nothing billed. That is
what makes a blacklist here cheaper than one in the prompt.

```
inbound call ──▶ call.ringing ──┬─ blacklisted ──▶ reject("busy")   (never answered)
                                └─ otherwise   ──▶ accept()  ──▶ call.started ──▶ …
```

## Run it

```bash
npm install
cp .env.example .env    # then fill in PINECALL_API_KEY and PHONE
npm start
```

| env | what |
|---|---|
| `PINECALL_API_KEY` | your key |
| `AGENT` | the slug to register as (default `ringing`) |
| `PHONE` | the number to answer on (E.164) — **required**, ringing is a phone flow |
| `BLACKLIST` | comma-separated numbers to reject, e.g. `+15551234567,+15559876543` |

## What you will see

`Agent 'ringing' ready on …`, then one line per call: `Ringing +1… → ACCEPTED`
(or `REJECTED (blacklisted)`), followed by `Call … started` and the end reason
with the duration. Put your own number in `BLACKLIST`, call, and you get a busy
signal without the agent ever picking up.

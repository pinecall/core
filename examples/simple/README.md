# Simple — an agent with a memory of its calls

The smallest agent worth running: a prompt, a voice, a number (optional), and a
`history` store. Hand the agent a store and every finished call writes itself to
it — no `save()` of your own, no `call.ended` bookkeeping.

## Run it

```bash
npm install
cp .env.example .env    # then fill in PINECALL_API_KEY
npm start
```

| env | what |
|---|---|
| `PINECALL_API_KEY` | your key |
| `AGENT` | the slug to register as (default `simple`) |
| `PHONE` | a number in your org to answer on (E.164). Empty → browser only |

## What you will see

`Agent 'simple' ready` as soon as the slug is registered. Call the number (or
open a widget / `pinecall chat` if you left `PHONE` empty), talk, hang up — the
console prints the call id and reason, and `./data/calls.json` has grown by one
conversation. `data/` is gitignored; it is a runtime artifact, not source.

`JsonFileHistory` is the built-in store. Anything with the same `save()` /
`findByContact()` shape works — see [`../history`](../history) for reading a
prior conversation back into a live call.

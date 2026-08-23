# History — the caller who rang yesterday

A returning caller should not have to introduce themselves again. The `history`
option is the write half: every call is saved when it ends. This example adds
the read half — look the caller up by number on `call.started` and push the
previous messages into the live call with `call.setHistory()`.

```
call.started ──▶ findByContact(number) ──┬─ nothing  ──▶ greet as a stranger
                                         └─ a record ──▶ setHistory(messages) ──▶ "Welcome back"
call.ended   ──▶ saved automatically (the `history` option)
```

## Run it

```bash
npm install
cp .env.example .env    # then fill in PINECALL_API_KEY
npm start
```

| env | what |
|---|---|
| `PINECALL_API_KEY` | your key |
| `AGENT` | the slug to register as (default `history`) |
| `PHONE` | a number in your org to answer on (E.164). Empty → browser only |

## What you will see

First call: `first call — nothing to restore`, and the agent greets you as a
stranger. Hang up — `Call … ended (hangup) — 6 messages saved` — and call again.
The second time it prints `1 previous call(s), restoring 6 messages` and the
agent picks up where you left off, because those messages are now in front of
the model.

Conversations land in `./data/calls.json`, which is gitignored: it is runtime
state, not source. `JsonFileHistory` is one implementation; anything with
`save()` and `findByContact()` drops in unchanged.

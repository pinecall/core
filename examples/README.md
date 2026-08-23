# Examples

**One feature, one file.** Every folder here shows exactly ONE thing, in a
single `server.mjs`, against this checkout of the SDK (`"@pinecall/sdk":
"file:../../"` — never a published version, so an example that breaks tells you
the SDK broke). Whole apps — a database, a deploy, two processes talking to
each other — live in [`pinecall/examples`](https://github.com/pinecall/examples).

| folder | what it shows |
|---|---|
| [`simple/`](./simple) | The smallest agent worth running — prompt, voice, and calls saved to a file |
| [`ringing/`](./ringing) | `call.ringing` — accept or reject an inbound call before it is ever answered |
| [`history/`](./history) | A returning caller's previous conversation, restored into the live one |
| [`turn-detection/`](./turn-detection) | Every turn event rendered as a state machine: Flux vs SmartTurn, pauses, barge-in |
| [`tools/`](./tools) | One `tool()`, and a return value that proves the model actually called it |
| [`skills/`](./skills) | `skill()` — tools that stay latent until the model loads them |
| [`reservations/`](./reservations) | Three tools in a fixed order: check, then confirm, then book |
| [`phone-line/`](./phone-line) | `pc.line()` — a keypad menu decided by `if`, with no model in it at all |
| [`outbound-dispatch/`](./outbound-dispatch) | `DispatchHub` — a CSV of people to ring, paced, with results written back |
| [`whatsapp-dashboard/`](./whatsapp-dashboard) | WhatsApp with human takeover: pause the agent, answer yourself, resume |
| [`agent-tests/`](./agent-tests) | `pinecall test` specs — chat and real voice. No server; these test one |

## Running any of them

The shape is the same everywhere:

```bash
cd examples/<folder>
npm install
cp .env.example .env    # then fill in PINECALL_API_KEY
npm start
```

`npm start` is `node --env-file=.env server.mjs` — Node 20.6+ reads the `.env`
itself, so no example depends on `dotenv`.

Most examples take a `PHONE`; leave it empty and the agent registers
browser-only — online and reachable from a widget or `pinecall chat`, it just
owns no number. `ringing/` and `outbound-dispatch/` are the exceptions: one is
about answering a phone and the other about dialling one, so both need a real
number.

Use a slug of your own in `AGENT` while you experiment. Registering a slug
hot-reloads whatever is live under it, so pointing an example at a production
agent takes that agent over.

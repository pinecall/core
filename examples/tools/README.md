# Tools — give the model a function, then prove it called it

One agent, one `tool()`. The interesting part is not the wiring, it is the
proof: `getOrderStatus` returns a port ("Rotterdam") and a carrier ("Maersk")
that exist nowhere but inside that function. If the agent's answer contains
Rotterdam, the function ran. If it waffles, it did not.

The zod schema's `.describe()` strings are read by the model, not by you —
that is where you tell it what an order id looks like.

## Run it

```bash
npm install
cp .env.example .env    # then fill in PINECALL_API_KEY
npm start
```

| env | what |
|---|---|
| `PINECALL_API_KEY` | your key |
| `AGENT` | the slug to register as (default `tools`) — must match `agent:` in `order.spec.yaml` |
| `PHONE` | a number in your org to answer on (E.164). Empty → browser only |
| `LLM` | A/B the model without editing the file, e.g. `openai/gpt-5.4-nano` |
| `ANTHROPIC_API_KEY` | only for `npm test` — the judge runs locally |

## What you will see

`Agent 'tools' ready — llm openai/gpt-4.1-mini, tools: getOrderStatus`. Ask it
"can you check order ABC-123?" from a widget, a chat or the phone, and the
console prints `getOrderStatus(ABC-123)` the moment the model decides to call
it — before the spoken answer comes back.

## Test it without a phone

`order.spec.yaml` is a `pinecall test` spec: a judge model plays the customer,
asks for order ABC-123, and passes only if the reply says the order is held in
customs *and* names Rotterdam.

```bash
npm start          # in one terminal — the agent must be online
npm test           # in another
```

The spec's `agent:` field must name the same slug the agent registered as.
More specs, and the voice-mode variant, in [`../agent-tests`](../agent-tests).

# Skills — tools the model has to ask for first

Every tool you hand an agent is a tool it must consider on every turn. A
`skill()` bundles tools *and* their instructions behind a name and one line of
description, and keeps them latent: the model sees the name, and must call
`loadSkill` before anything inside is callable.

This agent registers two skills and zero tools. Ask about the weather and the
model has to load `weather` first — which is exactly what makes the mechanism
visible in the console.

```
"what's the weather in Paris?"
   └─▶ loadSkill("weather")  ──▶ skill.loaded
        └─▶ getWeather("Paris")  ──▶ "21 degrees and sunny"
```

Skills run on the server-side LLM, so this one needs a managed key on a paid org.

## Run it

```bash
npm install
cp .env.example .env    # then fill in PINECALL_API_KEY
npm start
```

| env | what |
|---|---|
| `PINECALL_API_KEY` | your key — must be a paid org with the managed LLM |
| `AGENT` | the slug to register as (default `skills`) — must match `agent:` in both spec files |
| `PHONE` | a number in your org to answer on (E.164). Empty → browser only |
| `ANTHROPIC_API_KEY` | only for `npm test` — the judge runs locally |

## What you will see

`Agent 'skills' ready — skills: weather, billing (latent until loaded)`. Then,
per request, the order matters: `skill.loaded: weather (by llm)` comes first,
`getWeather(Paris)` second. Nothing calls a tool it has not loaded.

## Test it without a phone

`weather.spec.yaml` and `billing.spec.yaml` are `pinecall test` specs. A judge
model plays the user, asks for the weather in Paris and the balance on ACC-123,
and passes only on a concrete answer — which the agent can only give by loading
the right skill.

```bash
npm start          # in one terminal — the agent must be online
npm test           # in another; runs both specs
```

The specs' `agent:` field must name the same slug the agent registered as.

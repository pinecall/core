# Agent tests — specs, not a server

The odd one out: there is no `server.mjs` here, because there is nothing to
run. These two files are `pinecall test` **specs** — the thing you write to
check an agent that is already online. The agent under test lives elsewhere;
these describe what a conversation with it should look like.

A spec names an agent slug, a mode, and a `workflow` in plain English. A judge
model plays the user, has the conversation for real, and calls `test_passed` or
`test_failed` at the end.

| file | mode | what it costs |
|---|---|---|
| `pines-intro.spec.yaml` | `chat` | text only — fast, deterministic, no audio |
| `pines-intro.voice.spec.yaml` | `voice` | a real agent-to-agent voice call, played on your speakers and recorded to a WAV |

Voice mode is not a simulation: the judge is itself a Pinecall agent with a
voice and an STT, bridged to the target. It hears what a caller would hear —
including a TTS that swallows a word or a turn detector that cuts in early,
which text mode can never catch.

## Run them

The target agent must be online first. `pines` is the landing page's demo
agent; point the `agent:` field at any slug of your own.

```bash
# from the SDK root
npx pinecall test examples/agent-tests/pines-intro.spec.yaml
npx pinecall test examples/agent-tests/pines-intro.voice.spec.yaml
```

| env | what |
|---|---|
| `PINECALL_API_KEY` | your key |
| `ANTHROPIC_API_KEY` | the judge model, which runs locally |

`pinecall test <directory>` runs every spec in a folder — which is how
[`../tools`](../tools) and [`../skills`](../skills) test themselves, with their
specs sitting next to the agent they check.

## What you will see

A transcript of the judge's conversation as it happens, then a verdict per spec
with the judge's reason. Voice mode also plays the bridged call live and leaves
a WAV next to the spec, so a failure you cannot explain is a failure you can
listen to.

---
title: "Phone Lines"
description: "pc.line() — a phone number you program in code, with no model behind it."
---

# Phone Lines

A **line** is a phone number that answers with **your code**, not with a model.

`pc.line("+12186633772")` claims the number, brings up STT, TTS and turn
detection on it, and hands you the live call. From there every decision is an
`if`, a `switch`, an `await` — the caller's keypad, the caller's voice, a
lookup in your database. The first model call happens only if your code hands
the call to an agent with `call.routeTo("<slug>")`. Or never, if the whole call
is code.

```typescript
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall();

const line = pc.line("+12186633772", {
  stt: "soniox/stt-rt-v5",       // the line's own STT — multilingual, nobody knows the language yet
  voice: "elevenlabs/sarah",     // the line's own voice
  language: "en",
});

line.on("call", async (call) => {
  const answer = await call.ask("Press one for sales, two for support.", {
    digits: 1,
    timeout: 5000,
  });

  if (answer.by === "keypad" && answer.digit === "1") {
    await call.routeTo("sales");
  } else if (answer.by === "keypad" && answer.digit === "2") {
    await call.routeTo("support");
  } else {
    await call.say("Sorry, I didn't catch that.");
    call.hangup("no_selection");
  }
});
```

## A line is not an agent

| | `pc.agent(id, config)` | `pc.line(number, opts)` |
|---|---|---|
| Has a model | yes — `llm` + `prompt` | **no**. `llm`, `prompt`, `tools` and `greeting` are refused, synchronously |
| Decides by | the LLM | your code |
| Owns | a personality, reachable through channels | one phone number |
| First words | the `greeting` config | your first `call.say()` |
| Channels | phone, WebRTC, chat, WhatsApp | phone (and SIP) only |
| Keypad | an event you may handle | the primary input, with `listen`/`ask` |

The line **owns the number**, with priority over any agent registered on it.
The agent is a *destination*, resolved when `routeTo` runs — so if it is
offline, the line is told and decides what to do (say so, forward, hang up,
try another) instead of the caller hearing a dead number.

`pc.line()` is idempotent per number: calling it twice returns the same
`PhoneLine`.

<Note>
A line has its own STT and TTS, so **it bills like an agent does** — its
minutes and its TTS characters are charged to your org for as long as it owns
the session. A call that starts on a line and is routed to an agent is one call
log record with two owners in sequence.
</Note>

## The three flows

### (a) The caller dialled an extension

A caller who already knows where they are going can carry the destination in
the number itself. The line reads it off `call.extension` and routes without
asking anything.

```typescript
const line = pc.line("+12186633772", {
  voice: "elevenlabs/sarah",
  extension: { window: 2500 },   // ms of silence after connect to collect digits; 0 disables
});

// Declarative: an agent slug, or code. Runs BEFORE `line.on("call")`,
// and a match consumes the call.
line.extensions({
  "10": "pres-restaurantes",
  "11": "pres-hoteles",
  "20": async (call) => {                 // code, for an extension that is not just a hand-over
    await call.say("The warehouse is closed until Monday.");
    call.hangup("closed");
  },
  "*": async (call) => {                  // no extension dialled, or one that matched nothing
    await call.say("Welcome to Acme.");
    await call.routeTo("reception");
  },
});
```

With no matching key and no `"*"`, the call falls through to
`line.on("call")` — write both if you want a table *and* a hand-written flow.

#### How a caller actually dials an extension

**There is no such thing as an extension on the PSTN.** "Extension 33" means
the caller's phone dials the number and, once the call is *connected*, sends
`3 3` as keypad tones. You cannot print `+12186633772#33` and expect it to
work: a dialer sends the whole string to the carrier as one number and the
carrier drops it.

The only forms that work are the **pause** and the **wait**:

| Where | What to type / print | What happens |
|---|---|---|
| iPhone keypad | `+1 218 663 3772,33` — hold `*` until it becomes `,` | dials, waits ~2 s after connect, sends `3 3` automatically |
| iPhone keypad, manual | `+1 218 663 3772;33` — hold `#` until it becomes `;` | dials; a "Dial 33" button appears on screen — tap it when the line picks up |
| Android (Google Phone) | number → ⋮ → *Add 2-sec pause* / *Add wait* → `33` | the same two behaviours |
| Contact card / `tel:` link | `tel:+12186633772,33` (`,,33` for a longer pause) | one tap; the pause is honoured by iOS and Android |
| Any phone, by hand | dial, wait for pickup, press `3 3` | the tones land in the window if pressed within it; after that they are a menu answer, which reaches the same place |
| SIP / intercom | `sip:33@…` | the extension is in the URI — no window, no tones |

Append `#` (`,33#`) and the window closes the instant it arrives instead of
waiting the timeout out.

**Printed form, everywhere:** `+1 218 663 3772, 33`. The comma is the one
character every dialer turns into a pause. **Never print `#33` or `ext. 33`** —
people type it verbatim and it fails.

#### The extension window, and its cost

The window is the price of extensions. When the stream connects, the session
stays **silent** for `extension.window` milliseconds (default **2500**) and
collects whatever digits the caller's phone sends. Only then does `call` fire,
with `call.extension` already resolved to `"33"` or `null`.

- Digits inside the window become `call.extension`. They are **not** emitted as
  `call.dtmf_received`.
- Digits after the window are a menu answer (`listen` / `ask`) or a plain
  keypress — never an extension.
- A caller who dialled no extension hears **2.5 s of silence before the line
  speaks**. That is the trade-off. A line that never uses extensions should set
  `extension: { window: 0 }` and answer instantly.
- SIP carries the extension in the URI user part, so it needs no window at all.

### (b) A menu, answered by keypad *or* by voice

`ask()` is `say()` followed by `listen()` — the question and its answer.

```typescript
line.on("call", async (call) => {
  const answer = await call.ask(
    "Para español marque uno o diga español. For English, press two or say English.",
    { digits: 1, speech: true, timeout: 5000 },
  );

  const lang =
    answer.by === "keypad" ? (answer.digit === "1" ? "es" : "en")
    : answer.by === "speech" && /espa|spanish/i.test(answer.text) ? "es"
    : "en";

  const routed = await call.routeTo("reception", {
    language: lang,
    voice: lang === "es" ? "elevenlabs/marta" : "elevenlabs/sarah",
  });

  if (!routed.ok) {
    await call.say(lang === "es" ? "No hay nadie disponible." : "Nobody is available.");
    call.hangup("agent_offline");
  }
});
```

Both inputs come off the **one session** the agent will keep using after the
hand-over — same VAD, same STT, same turn detector. There is no `<Gather>`, no
second recognizer, no HTTP round trip, and everything the line heard is still
there for the agent.

`speech: true` is opt-in: a menu that only takes digits should not wait on
voice activity.

`ask()` collects the keypad **from before the first syllable** — barge-in on a
menu is the normal case, and a caller who knows the menu presses over it. The
timeout only starts counting once the line stopped speaking.

### (c) A whole app, with no agent at all

Nothing here needs a model. This is a complete opening-hours line:

```typescript
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall();
const HOURS = "We are open Monday to Friday, nine to six.";

const line = pc.line(process.env.LINE_NUMBER!, {
  voice: "elevenlabs/sarah",
  language: "en",
  extension: { window: 0 },      // no extensions on this line — answer immediately
});

line.on("call", async (call) => {
  const choice = await call.ask("For our opening hours, press one. To speak to somebody, press two.", {
    digits: 1,
    timeout: 6000,
  });

  if (choice.by === "keypad" && choice.digit === "1") {
    await call.say(HOURS);
    call.hangup("done");
    return;
  }

  if (choice.by === "keypad" && choice.digit === "2") {
    call.forward(process.env.HUMAN!);    // leaves Pinecall — see routeTo vs forward
    return;
  }

  await call.say("Sorry, I didn't get that. Goodbye.");
  call.hangup("no_selection");
});

line.on("call.ended", (call, reason) => {
  console.log(reason, call.transcript);
});
```

A full runnable version of this — extension routing, a language menu, a
code-only menu, forwarding and a hand-over — is in
[`examples/phone-line/`](https://github.com/pinecall/sdk/tree/main/examples/phone-line).

## The verbs

Every verb on the `LineCall` your handler receives. It is a real `Call`
(`instanceof Call` is true, every event and control still works) plus these:

| Verb | Returns | What it does |
|---|---|---|
| `await call.say(text, { voice?, language?, addToHistory? })` | `{ interrupted: boolean }` | Speak, and resolve when the **audio finished playing** — or `{ interrupted: true }` when the caller talked over it or the call ended mid-sentence. Never rejects. `voice`/`language` reconfigure the session before speaking, so the line is heard in the new voice from this sentence on. |
| `await call.listen(opts)` | `ListenResult` (below) | Wait for the **first** of: the keypad, the caller's speech (`speech: true`), or the timeout. |
| `await call.ask(text, opts)` | `ListenResult` | `say` then `listen`. Keypresses made during the sentence count; the timeout starts when the line stops speaking. |
| `await call.routeTo(agent, opts?)` | `{ ok: true }` \| `{ ok: false, reason }` | Hand the **live** call to an agent, in place. |
| `call.forward(to, { message?, announce? })` | — | Send the call **out of Pinecall** to another number. |
| `call.hangup(reason?)` | — | Hang up. The `reason` is kept in the call log. |
| `call.context(key, value)` | — | Set keyed context on the session. It **survives `routeTo`**, so the agent inherits what the line learned. |
| `call.extension` | `string \| null` | The extension dialled after the number, already resolved when `call` fires. |
| `call.transcript` | `LineTranscriptEntry[]` | What the caller said and what the line said back, in order. |
| `call.routed` | `boolean` | True once the hand-over landed. |
| `line.extensions(table)` | `this` | The routing table (flow (a)). |
| `line.destroy()` | — | Release the number. |

### `ListenOptions`

```typescript
await call.listen({
  digits: 2,           // resolve once this many keys were pressed
  terminator: "#",     // resolve on this key, whatever the buffer holds
  speech: true,        // also race the caller's SPEECH (opt-in)
  timeout: 5000,       // ms before giving up — required
  language: "es",      // switch the session's language before listening
});
```

### `ListenResult`

A tagged union — switch on `by`:

```typescript
{ by: "keypad"; digit: string; digits: string }          // digit = this press, digits = the buffer
{ by: "speech"; text: string; confidence: number }
{ by: "timeout" }
```

A call that **ends** under a `listen` resolves as `{ by: "timeout" }`, so a flow
always gets one answer and one code path — never a dangling promise.

### `LineTranscriptEntry`

```typescript
{ who: "caller" | "line"; text: string; at: number; role: "user" | "assistant"; content: string }
```

`role`/`content` are the same fact in the shape a plain `Call` transcript uses,
so code written against an agent's transcript reads a line's unchanged.

## `routeTo` vs `forward`

They are kept apart on purpose.

**`routeTo(agent, opts?)` — the hand-over.** No re-dial, no drop, no second
leg. The server swaps the session's owner and config **in place**: STT, TTS and
turn detection are rebuilt on the same live audio stream, and the agent sees a
normal `call.started`, carrying:

- `call.routedFrom` — `"line:+12186633772"`, the line that handed it over
- `call.extension` — the extension the caller dialled, so the agent knows which door it came through
- `call.lineTranscript` — everything the line heard and said, so the agent is not starting blind

```typescript
await call.routeTo("pres-hoteles", {
  language: "es",
  voice: "elevenlabs/marta",
  stt: "soniox/stt-rt-v5",
  greeting: "Hoteles, dígame.",         // overrides the agent's own greeting for this hand-over
  promptVars: { customer: "Acme" },
  context: { reason: "billing" },       // keyed context, same wire as call.context()
  history: true,                        // prime the agent with what the line heard (default true)
});
```

It resolves `{ ok: true }` once the swap landed, or:

```typescript
{ ok: false, reason: "offline" | "unknown" | "no_phone_config" | "capacity" | "swap_failed" }
```

On a failure **the session is untouched and the line is still the owner** — an
offline agent is the line's decision to make, not a 404 the caller hears. After
a successful route the `LineCall` goes inert (`call.routed` is `true`,
`call.status` is `"ended"`) and the line gets a `call.ended` with reason
`"routed"`.

**`forward(to)` — the exit.** The call **leaves Pinecall** for another number:
a human, an external queue, the old PBX. Nothing Pinecall does reaches it after
that, and there is no transcript to inherit.

Rule of thumb: staying inside Pinecall with an AI on the other end →
`routeTo`. Handing the caller to a person on a real phone → `forward`.

## Events on the line

```typescript
line.on("ready", () => {});                      // the server registered the line; the number is ours
line.on("error", (err) => err.code);             // LINE_CONFLICT | LINE_CONFIG_ERROR | PHONE_NOT_IN_ORG | UNAUTHORIZED
line.on("call", async (call) => {});             // an inbound call, held for you (fires after the extension window)
line.on("call.ended", (call, reason) => {});     // reason is "routed" after a hand-over

await line.ready;                                // resolves on line.created
line.registered;                                 // boolean
line.calls;                                      // ReadonlyMap<string, LineCall>
```

The raw streams are still there when a flow is not request/response:

```typescript
call.on("call.dtmf_received", (e) => e.digit);   // every press after the extension window
call.on("turn.end", (turn) => turn.text);        // the caller's confirmed speech turns
call.on("call.routed", (e) => e.agent);
call.on("call.route_failed", (e) => e.reason);
```

A line re-registers itself on reconnect, exactly like an agent — a line that
comes back has to take its number back, or the number is stranded.

## What's next

- [Events](/guides/events) — every event, including `call.dtmf_received` and the line events
- [Inbound Voice](/guides/inbound-voice) — the agent on the other side of a `routeTo`
- [Agents and Channels](/concepts/agents-and-channels) — where a line sits among the four nouns

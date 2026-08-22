# Phone Line — a business front line with no agent

A working phone app built entirely with [`pc.line()`](https://pinecall.io/docs/guides/phone-lines).
There is **no `pc.agent()` anywhere in this example**: the number answers with
code, speaks with its own TTS, reads the keypad and the caller's voice off its
own STT, and only hands the call to an agent when the caller asks for one.

```
caller ──▶ +1 218 663 3772           the LINE owns the number
             │
             ├─ dialled ",10" ──────▶ routeTo(AGENT)          (no menu, no question)
             │
             └─ no extension
                  ├─ "English or español?"     keypad OR voice
                  └─ menu, in that language
                       1 → opening hours       a constant, spoken
                       2 → the address         a constant, spoken
                       3 → forward(HUMAN)      leaves Pinecall
                       0 → routeTo(AGENT)      the live call, same stream
```

## Run it

```bash
npm install

PINECALL_API_KEY=pk_...   \
LINE_NUMBER=+12186633772  \
AGENT=my-agent            \
HUMAN=+15551234567        \
node server.mjs
```

| Variable | What |
|---|---|
| `PINECALL_API_KEY` | your Pinecall API key |
| `LINE_NUMBER` | the number this line claims, E.164. It must be on your org |
| `AGENT` | the agent slug to hand callers to (extension `10`, and menu option `0`) |
| `HUMAN` | a real phone number for menu option `3` — the call **leaves** Pinecall |
| `PINECALL_URL` | optional, override the voice server |

`AGENT` does not have to be running when the line starts: an agent is a
*destination*, resolved when `routeTo` fires. If it is offline the line says so
and hangs up — the caller never hears a dead number.

## What you will hear

**Dialling `+1 218 663 3772, 10`** — the line reads the extension off the digits
your phone sent after connect and hands you straight to the agent. Nothing is
spoken first.

**Dialling `+1 218 663 3772`** — about 2.5 seconds of silence (the extension
window, waiting for digits that never come), then:

> For English, press one or say English. Para español, marque dos o diga español.

Answer with the keypad **or out loud** — both come off the same session. Then
the menu, in your language. Press `1` for the opening hours, `2` for the
address, `3` to be forwarded to `HUMAN`, `0` to be handed to the agent in the
language you picked. Whatever the line heard travels with you: the agent gets a
normal `call.started` carrying `routedFrom`, `extension` and `lineTranscript`.

Press nothing and the line apologises and hangs up.

## Dialling with an extension

**There is no such thing as an extension on the PSTN.** "Extension 10" means
your phone dials the number, and once the call is *connected* sends `1 0` as
keypad tones. You cannot type `+12186633772#10` — a dialer sends the whole
string to the carrier as one number and the carrier drops it.

The forms that actually work:

| Where | What to type | What happens |
|---|---|---|
| iPhone keypad | `+1 218 663 3772,10` — hold `*` until it becomes `,` | dials, waits ~2 s after connect, sends `1 0` |
| iPhone keypad, manual | `+1 218 663 3772;10` — hold `#` until it becomes `;` | dials; tap the "Dial 10" button when the line picks up |
| Android (Google Phone) | number → ⋮ → *Add 2-sec pause* / *Add wait* → `10` | the same two behaviours |
| `tel:` link / contact card | `tel:+12186633772,10` (`,,10` for a longer pause) | one tap, pause honoured by iOS and Android |
| Any phone, by hand | dial, wait for pickup, press `1 0` fast | lands in the window; later presses are a menu answer instead |
| SIP | `sip:10@…` | the extension is in the URI — no window, no tones |

Append `#` (`,10#`) and the window closes the instant it arrives.

**Print it as `+1 218 663 3772, 10`.** The comma is the one character every
dialer turns into a pause. Never print `#10` or `ext. 10` — people type it
verbatim and it fails.

## The trade-off

The extension window costs every extension-less caller ~2.5 s of silence before
the line speaks. A line that never uses extensions should turn it off:

```javascript
pc.line(LINE_NUMBER, { extension: { window: 0 } });   // answers instantly
```

## Prove it without a phone

```bash
npm run smoke
```

`smoke.mjs` stands up a WebSocket server on localhost that plays the voice
server and runs `server.mjs` against it **unmodified** (via `PINECALL_URL`),
then drives a caller through every branch: registration, extension `10`, the
language question answered on the keypad, option `1`, and the hand-over on `0`.
It asserts the line registers with no model on the wire and that no agent is
ever created.

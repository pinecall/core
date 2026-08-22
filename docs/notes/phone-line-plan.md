# The phone line as code — `pc.phone()`

**Status:** design, nothing implemented. 2026-08-22, v2 (supersedes the
`<Gather>` draft — no TwiML menus; everything rides the media stream).

---

## 0. What is being asked, in one paragraph

A phone number must be a **first-class object you program**, live from the
first audio frame of a call: it has its own STT and TTS, it hears keypad presses
and speech from the **same audio buffer** the agents use, and it makes every
decision in plain code — `if`, `switch`, `await` — with **no LLM** anywhere
unless the code decides to hand the call to an agent. The destination agent
does not need to exist, be deployed or be online for the line to answer. One
number can front every agent Pinecall has, split by a menu or by the
**extension** the caller dialled. And the line must be able to change who is
handling the call, and in what language and voice, **without dropping the
stream**.

---

## 1. What the server is today — the facts this plan is built on

Read from `sdk-server/src/pinecall`, not from memory. Each one is load-bearing.

| fact | where | why it matters |
|---|---|---|
| **A number has no owner of its own.** Routing is `ClientManager._phone_to_client` + `_phone_dev_override`, in memory, written when an agent sends `channel.add`. The playground `Phone` document has no agent field at all. | `session/manager.py:975 get_client_for_number` | "without deploying the agent" is impossible today by construction. If the process that registered the number is down, `on_start` hits `session.no_client` and **closes the socket — the call is hung up** (`webhooks.py:~665`). |
| **The call and its pipeline are one `CallSession`** per Twilio stream: VAD, STT, TurnController, TTS, optional `LLMHandler`. | `transports/twilio/webhooks.py:278` | There is exactly one place where audio comes in (`on_media`) and one where it goes out (`_send_audio_b64`). A line is this object with a different owner — nothing new has to touch audio. |
| **No LLM is already a supported mode.** If the owner's config has no `llm`, `self.llm_handler = None` and `turn.end` reaches the SDK, which answers with `bot.reply` / `bot.reply.stream`. Docs call it "client-side LLM". | `webhooks.py:1037`, `session/bot_handler.py:45 handle_bot_reply`, `docs/concepts/server-vs-client-llm.md` | **Code-driven conversation exists.** What does not exist is: owning the call *before* an agent, switching owner mid-call, keypad input, and awaiting speech completion. |
| **The owner is swappable in principle.** The session is bound by `register_session(client_key, call_sid, self)`; every event resolves its target through `_client_sessions` first (`emit_to_call` FAST PATH) and only falls back to the number map. | `manager.py:1377`, `manager.py:1742` | A hand-off is `unregister_session(old) + register_session(new)` plus a config swap. No Twilio round-trip. |
| **Config hot-reload mid-call is real and deep.** `update_config()` rebuilds TTS (voice, model, language), STT, turn detection, and `llm_handler.apply_live_update` for prompt/tools/skills/KB — on the live stream. | `webhooks.py:2366` | `routeTo(agent, {language, voice})` is `update_config` with the target agent's resolved config. The greeting then plays in the right voice from the first word. |
| **Keypad presses were dropped on the floor.** `receiver()` had branches for `start`/`media`/`stop` only; Twilio's `{"event":"dtmf"}` frame had none. | `webhooks.py:508` | Written today (uncommitted): `on_dtmf()` → per-call digit buffer → `call.dtmf_received {digit, digits}`. Inbound track only. It is the keypad half of this plan. |
| **`forward` kills the stream.** `forward_call` POSTs new TwiML (`<Dial>to</Dial>`) to the Twilio REST API; the media stream ends; the call leaves Pinecall. | `transports/twilio/calls.py:179` | Correct for "send to a human", **wrong for agent→agent**. That must be an in-process owner swap, never a redirect. |
| **`say()` is fire-and-forget.** `call.say()` sends `bot.reply`; completion is observable only through `bot.finished {message_id}`. | `sdk/src/domain/call.ts:194`, `webhooks.py:3062 _emit_bot_finished` | An `await call.say()` is a promise resolved by the `bot.finished` for that `message_id`. The correlation already exists on the wire. |
| **The first-second greeting is server-side config.** Inbound greeting is read from the channel's `effective_config_raw.greeting` and spoken by the server, with a `_greeting_lock`. | `webhooks.py:~870` | A line has no `greeting:` config — its first words are code. The lock semantics must still apply to whatever the line says first, or the caller's breathing barges in the menu. |
| Per-call `<Parameter name="config">` override is parsed on `on_start` for OUTBOUND only (`_config_override`). | `webhooks.py:575` | Not needed for inbound lines: `routeTo` configures the live session directly. Mentioned so nobody reaches for TwiML parameters. |
| SIP inbound already carries an extension in the user part (`sip:204@domain`), normalised and routed like a number. | `transports/twilio/sip.py` | The SIP flavour of "number + extension" is free. |

---

## 2. The model

```
            ┌────────────────────────────────────────────────────┐
            │  CallSession  (one per Twilio stream)              │
  mulaw ──▶ │  VAD ─ STT ─ TurnController ─▶ owner               │ ──▶ mulaw
  dtmf  ──▶ │  digit buffer ───────────────▶ owner               │
            │  TTS ◀──────────────────────── owner.say()         │
            └────────────────────────────────────────────────────┘
                                   ▲ owner = the LINE first,
                                   │ then whichever agent routeTo() names
```

**A line is a session owner that is not an agent.** It registers on the same
socket agents use, under its own identity (`line:+12186633772`), claims the
number with priority over any agent (`line > dev- override > prod agent`), and
receives the call **first**, with no LLM. Everything the caller does reaches it
as events; everything it says goes out through the session's TTS. When code
says `routeTo`, the server swaps the session's owner and config **in place**
and the agent sees a normal `call.started`.

Three properties fall out of this:

1. **Same buffer, same pipeline.** Keypad and speech come from the one
   `CallSession`. No TwiML, no second STT, no HTTP callback, no `<Gather>`.
2. **No LLM unless asked.** The line's config has no `llm`; `llm_handler` is
   `None`. The first model call happens only after `routeTo` to an agent that
   has one — or never, if the line handles the whole call in code.
3. **The number answers without the agent.** The line owns the number; the
   agent is a *destination*, resolved at `routeTo` time. If it is offline the
   line is told and decides — say so, forward, hang up, try another.

---

## 3. The SDK surface

```ts
const line = pc.phone("+12186633772", {
  stt:   "soniox/stt-rt-v5",          // the line's own STT — multilingual, because nobody knows the language yet
  voice: "elevenlabs/sarah",          // the line's own voice
  language: "en",
});

line.on("call", async (call) => {
  // 1. An extension dialled with the number? (",204" — see §5)
  const ext = await call.extension({ timeout: 2500 });
  if (ext) return call.routeTo(BY_EXT[ext] ?? "pres-pinecall");

  // 2. A menu — spoken by the line, answered by keypad OR voice, decided by code.
  await call.say("Para español marque uno o diga español. For English, press two or say English.");
  const ans = await call.listen({ digits: 1, speech: true, timeout: 5000 });
  //   ans = { digit: "1" }  |  { text: "español", confidence: 0.93 }  |  { timeout: true }

  const lang = ans.digit === "1" || /espa|spanish/i.test(ans.text ?? "") ? "es" : "en";

  // 3. Hand the LIVE call to an agent, already in that language — no re-dial, no drop.
  const r = await call.routeTo("pres-restaurantes", { language: lang, voice: VOICES[lang] });
  if (!r.ok) {                         // agent offline: the LINE decides, not a 404
    await call.say(UNAVAILABLE[lang]);
    return call.hangup("agent_offline");
  }
});
```

### 3.1 `pc.phone(number, opts)` → `PhoneLine`

| member | meaning |
|---|---|
| `number` | E.164 or `sip:` URI, as `addPhoneNumber` accepts today |
| `opts.stt` / `opts.voice` / `opts.language` / `opts.turnDetection` | the line's own pipeline config — same shapes as an agent's, minus `llm`/`prompt`/`tools` (rejected if passed) |
| `opts.extensionWindowMs` (default 2500) | how long after connect to listen for post-dial digits before `call` fires (§5) |
| `line.on("call", h)` | an inbound call on this number is connected, VAD/STT/TTS up, and HELD for this handler |
| `line.on("call.ended", h)` | ended at any stage, including mid-menu |
| `line.on("ready" \| "error")` | registration lifecycle, same as agents |

`PhoneLine` is **not** an `Agent`: no prompt, no tools, no skills, no KB, no
chat/webrtc/whatsapp channels, no `agent.create`. It goes out as
`line.create {number, config}`; the server acks `line.created`. Same reconnect,
liveness and reaping rules as agents — a line that dies must release its
number like an agent does, or this becomes a new way to strand one.

### 3.2 The call handed to the handler — `LineCall`

The same `Call` object agents get (`from`, `to`, `id`, `transport: "phone"`,
`hold`/`mute`/`hangup`, `on(...)` with every event), plus the control verbs.
**Every verb is awaitable and deterministic.** None of them talks to a model.

| verb | returns | how it is built on what exists |
|---|---|---|
| `await call.say(text, {voice?, language?})` | when the audio **finished playing** (or was interrupted: `{interrupted: true}`) | `bot.reply` with a `message_id`; resolve on `bot.finished` / `bot.interrupted` for that id. Optional `voice`/`language` = a scoped `session.configure` before the reply. First `say` gets the greeting lock. |
| `await call.listen(opts)` | `{digit?, digits?, text?, confidence?, timeout?}` — the **first** of: a keypress (`digits: N` or `terminator`), an end-of-turn transcript (`speech: true`), or the timeout | keypad from `call.dtmf_received`; speech from `turn.end` (the pipeline's own end-of-turn — Soniox endpoint / smart-turn — not a second STT); timeout local. `speech: true` is opt-in because a menu that only takes digits should not wait on VAD. |
| `await call.extension(opts)` | the digits the caller's phone sent right after connect, or `null` | §5. Sugar over `listen({digits: "*", terminator: "#", timeout})` that starts **at connect**, before `call` fires, so the handler sees them as a fact. |
| `call.on("dtmf", h)` / `call.on("turn.end", h)` | the raw streams, for flows that are not request/response | exactly today's events |
| `await call.routeTo(agent, opts?)` | `{ok: true}` or `{ok: false, reason: "offline" \| "unknown" \| "no_phone_config" \| "capacity"}` | §4. The owner swap. `opts`: `language`, `voice`, `stt`, `greeting` (override the agent's), `promptVars`, `context` (→ `set_context`), `history` (prime the agent with what the line heard, as transcript) |
| `await call.forward(number)` | `{ok}` | today's `forward_call` — the call **leaves** Pinecall (human, external queue). Kept distinct from `routeTo` on purpose. |
| `await call.play(url \| buffer)` | when done | `bot.audio` frames — exists for WebRTC, wire it for phone. Hold-music reuse. |
| `call.hangup(reason)` / `call.reject()` | — | existing |
| `call.context(key, value)` | — | existing `set_context`; survives the owner swap so the agent inherits what the line learned |

### 3.3 Why `listen` and not `gather`

Twilio's `<Gather>` answers the call with TwiML, runs Twilio's own speech
recognition and posts a webhook. It is cheap and works with nothing of ours
running — and it is **not this product**: a second STT with its own language
list, a second voice, a round trip per question, no barge-in, and nothing it
hears reaches the agent afterwards. `listen` is the session's own VAD/STT/turn
pipeline, the same that the agent will keep using after `routeTo`, so the
menu and the conversation are one continuous stream with one transcript.

---

## 4. The hand-off — `routeTo` on the server

New verb on the client socket: `call.route {call_id, agent, opts}`. In
`CallSession`:

```
1. resolve target      client_manager.get_client_by_slug(agent, org)   (dev- override honoured)
                       offline / unknown / no phone config → answer {ok:false, reason}; session untouched
2. freeze the turn     turn_controller → IDLE; abort any line audio in flight (existing _abort_audio_callback)
3. swap owner          unregister_session(line_key) ; register_session(agent_key) ; self._client_key = agent_key
                       lock_phone_for_call stays (same call, same number)
4. swap config         raw = agent.get_raw_config_for_phone(number) ⊕ opts{language, voice, stt}
                       await self.update_config(raw)          ← TTS/STT/turn rebuilt on the live stream
                       if raw.llm: self.llm_handler = LLMHandler(self, llm_cfg) ; wire turn_controller.on_user_message_callback
                       opts.context → llm_handler.set_context ; opts.history → llm_handler.history (role-tagged, what the line heard)
5. tell both sides     line ← call.routed {call_id, agent}      (its handler's promise resolves {ok:true}; the Call object goes inert)
                       agent ← call.started {…, routed_from: "line:+1…", extension?, menu?}   — a normal call to the agent
6. greet               opts.greeting ?? the agent's channel greeting, spoken through the existing _send_greeting path with the lock
```

Everything in 2–6 is existing machinery called in a new order. The one new
piece of state is "who owns this session", which today is implicit in
`_client_key` and becomes explicit (`self.owner: {kind: "line"|"agent", key}`)
so `emit_to_call`, billing attribution and the call log can say who was
speaking when.

**Billing:** the line's minutes and TTS characters bill to the org like an
agent's; the call log gets one record with two owners in sequence. Attribution
per owner is a follow-up, not a blocker.

**Failure mid-swap** (agent socket dies between 1 and 5): `update_config`
returns False → restore the line as owner, answer `{ok:false, reason:"offline"}`.
The caller hears nothing wrong.

---

## 5. Number + extension — what actually happens, and what we can do

**There is no such thing as an extension on the PSTN.** "Dial
`+1 218 663 3772 ext 204`" means: the caller's phone dials the number and,
once the call is **connected**, sends `2 0 4` as DTMF tones. iPhone and
Android both do this natively — a `,` in the number is a ~2 s pause then
auto-send, a `;` waits for the user to tap "Dial"; both end up as keypad tones
on the open call. Sources:
[iPhone extension dialing](https://www.howtogeek.com/263546/how-to-dial-phone-extensions-automatically-with-your-iphone/),
[pause/wait semantics](https://www.sipnex.ca/blog/phone-extensions-explained),
[Android pause/wait](https://bubblyphone.com/hub/phone-extension).

On our side those tones arrive exactly as the in-stream `dtmf` frames Twilio
sends on `<Connect><Stream>` — the same frames `on_dtmf()` now decodes
(Twilio's own note: this is "useful for detecting extensions dialed by callers
after connecting" —
[Media Streams DTMF](https://www.twilio.com/en-us/changelog/twilio-media-streams--connect--stream--dtmf-support-now-generall),
[WebSocket messages](https://www.twilio.com/docs/voice/media-streams/websocket-messages)).
So **yes, it can be detected, and it needs nothing new in Twilio** — only the
DTMF branch plus a timing rule:

- The stream connects → the session opens an **extension window**
  (`extensionWindowMs`, default 2500 ms) during which it stays **silent** and
  collects digits. A `,` pause is ~2 s, so the digits land inside the window;
  `#` closes it early.
- Window closes → `call` fires on the line with `call.extension` already
  resolved (`"204"` or `null`). A caller who dialled no extension waits 2.5 s
  of silence before the line speaks; acceptable for a demo line, configurable
  to 0 for a line that never uses extensions.
- Digits pressed **after** the window are a menu answer (`listen`) or a
  mid-call keypress, never an extension.
- **SIP** carries the extension in the URI user part (`sip:204@…`) — already
  parsed in `sip.py`; `call.extension` returns it with no window at all.
- **How a caller actually dials it** — the part nobody documents well. You
  cannot type `+12186633772#33` and have the `#33` go out by itself: a plain
  dialer sends the whole string to the carrier as one number, and the carrier
  drops or rejects it. The only native ways to send digits *after* connect are
  the pause and the wait:

  | where | what to type / print | what happens |
  |---|---|---|
  | iPhone keypad | `+1 218 663 3772,33` — hold `*` until it becomes `,` | dials, waits ~2 s after connect, sends `3 3` automatically |
  | iPhone keypad, manual | `+1 218 663 3772;33` — hold `#` until it becomes `;` | dials; an on-screen "Dial 33" button appears; tap it when you hear the line |
  | Android (Google Phone) | number → ⋮ → *Add 2-sec pause* / *Add wait* → `33` | same two behaviours |
  | contact card / `tel:` link | `tel:+12186633772,33` (`,,33` for a longer pause) | one tap, pause honoured by iOS and Android |
  | any phone, by hand | dial the number, wait for pickup, press `3 3` | the tones land in the window if pressed within ~2.5 s; otherwise they are a menu answer, which reaches the same place |
  | SIP / intercom | `sip:33@…` | the extension is in the URI; no window, no tones |

  Append `#` (`,33#`) and the window closes the instant it arrives instead of
  waiting out the timeout — optional, but worth printing on a deck.

- **Printed form** everywhere: `+1 218 663 3772, 33` — the comma is the one
  character every dialer turns into a pause. Never print `#33` or `ext. 33` on
  a demo; people type it verbatim and it fails.

- **No extension dialled → the line asks.** `call.extension()` comes back
  `null` after the window and the handler falls through to the menu
  (`say` + `listen`). So the three shapes — dialled with pause, dialled with
  wait and tapped during the menu, or chosen by keypad/voice when asked — all
  end in the same `routeTo`. The only thing the window buys is skipping the
  question for callers who already know where they are going.

Limits, stated plainly: ~2.5 s of silence for extension-less callers; a caller
who types the extension by hand after hearing silence will usually still land
in the window; landlines with pulse dialing do not exist in this audience.

---

## 6. One number for all of Pinecall

**Decided 2026-08-22: one number for EVERY demo** — the nine presentations,
the SDK examples and acme — each reachable by extension, with the menu for
anyone who dials bare. With lines this is one file:

```ts
const EXT = { "1": "pres-restaurantes", "2": "pres-hoteles", "3": "pres-clinicas",
              "4": "pres-gimnasios", "5": "pres-inmobiliarias", "6": "pres-retail",
              "7": "pres-seguros", "8": "pres-lumicrm", "0": "pres-pinecall" };

pc.phone("+12186633772", { stt: "soniox/stt-rt-v5", voice: "elevenlabs/sarah" })
  .on("call", async (call) => {
    const ext = await call.extension();
    let agent = EXT[ext ?? ""];
    if (!agent) {
      await call.say("Pinecall. Para español marque uno. For English, press two.");
      const a = await call.listen({ digits: 1, speech: true, timeout: 5000 });
      // … language, then vertical by a second prompt or the deck's own extension
    }
    const lang = …;
    return call.routeTo(agent, { language: lang, voice: VOICES[lang] });
    // `history` is ON by default (decided 2026-08-22): the agent arrives knowing what the
    // caller said to the line — "you asked for Spanish, so —". Pass `history: false` to start clean.
  });
```

Each deck prints the one number with its extension; `tel:` links dial it with
the pause. The `dev-` override keeps working because `routeTo("pres-x")`
resolves through the same `get_client_for_number`/slug lookup, so a developer's
`dev-berna-pres-hoteles` takes the hand-off on their whitelisted caller id.

What this retires: nine `phoneE164` entries → one; `LANG_BY_NUMBER` and the
`phoneMap` in `presentation-agent.mjs`; the IVR code written into the factory
today (delete, not migrate — the line owns that decision); `RESERVED_NUMBERS`
stays as the guard it is.

---

## 7. What must change where

### sdk-server
| file | change |
|---|---|
| `transports/twilio/webhooks.py` | `on_dtmf` (written); extension window at `on_start` before the first event; `route()` = §4; explicit `self.owner`; the `no_client` branch asks the **line registry** before hanging up |
| `session/manager.py` | line registry (`_line_for_number`), priority in `get_client_for_number` (line > dev > prod); `register_line` / reap rules shared with agents; owner-aware `emit_to_call` |
| `transports/client/handler.py` | verbs: `line.create`, `call.route`, `call.listen` is client-side (no verb), `bot.audio` for phone (`play`) |
| `session/events.py` / `legacy_events.py` | `call.dtmf_received` (written), `call.routed`, `call.started.routed_from`, `call.extension` |
| `client/protocol.py` | the new messages |
| tests | unit: owner swap keeps the stream, extension window timing, line priority, offline target restores the line |

### sdk
| file | change |
|---|---|
| `src/client.ts` | `pc.phone()` |
| `src/domain/line.ts` (new) | `PhoneLine`; `LineCall` = `Call` + `say()` awaitable, `listen`, `extension`, `routeTo`, `forward`, `play` |
| `src/domain/call.ts` | `say()` gains a returned promise resolved on `bot.finished` (non-breaking: still usable un-awaited) |
| `src/protocol/*`, `dispatch/handlers/*` | `line.created`, `call.routed`, `call.dtmf_received` (written), `call.extension` |
| `docs/guides/phone-lines.md` (new), `reference/events.md`, `concepts/agents-and-channels.md`, `docs.json`, `CHANGELOG.md` | the guide, with the three flows above |

### presentations
`verticals.mjs` → one number (+ `extension` per vertical); `agents/line.mjs`
(new) replaces the per-agent phone wiring; `public/live/_shared/phone.js` prints
`number, ext` and a `tel:` with the pause; the factory loses `phoneMap` /
`LANG_BY_NUMBER` / today's IVR.

### playground (later, not in the first cut)
`Phone.line` snapshot so `list_phones` shows "owned by line:+1… (offline)"
instead of "free" when the line process is down — and so the number does not
fall through to layer "nobody answers". Purely observational at first.

---

## 8. Decisions I am making unless you object

1. **A line is its own kind, not an agent with flags.** `pc.phone()` / `line.create`. An agent with `llm: none` already does code-driven replies, but it cannot own a number *before* another agent, cannot swap owner, and drags prompt/tools/skills semantics along. Separate type, shared `Call`.
2. **`routeTo` is an in-place owner swap, never a Twilio redirect.** `forward` stays the word for leaving Pinecall.
3. **`listen`, not `gather`.** Same pipeline as the conversation; keypad and speech are two inputs to one wait.
4. **Extension window is silent and short** (2.5 s default, 0 allowed). Speaking during it would collide with the dialer's tones.
5. **The line bills like an agent** and the call log shows two owners in order. Per-owner attribution is a follow-up.
6. **`routeTo` hands the line's transcript to the agent by default** (`history: true`); opt out per call. Decided 2026-08-22.
7. **The DTMF work written today ships first**, alone: it is the keypad half of everything above and is useful on its own (mid-call "press 9 for a human" inside an agent).

## 9. Open question left

- The **extension digits**: one digit per destination (`0–9`, quick to print,
  caps at ten demos) or two (`10…99`, room to grow, one more keypress)? Affects
  the printed copy only. Proposal: **two digits**, since "every demo" already
  exceeds ten.

Settled: `history` on by default; one number for all demos.

## 10. Phases

1. **Keypad** — the `call.dtmf_received` work (written): deploy, verify with a real press. SDK 0.13.0 candidate; number is yours.
2. **Line, minimal** — `pc.phone`, `say` awaitable, `listen` (digits + speech), `routeTo` owner swap, line priority. One vertical on the line as the proof.
3. **Extension window** + `call.extension`, SIP passthrough, `tel:` with pause on the decks.
4. **Presentations on one number**; delete the factory IVR and the per-vertical numbers; regenerate the landing.
5. **Playground snapshot** of line ownership for `list_phones`; dashboard shows it.

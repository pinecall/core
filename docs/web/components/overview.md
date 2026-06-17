---
title: "Web Components"
description: "Framework-agnostic <pinecall-orb> and <pinecall-modal> Custom Elements — voice (and text) in any framework, no React required."
---

# Web Components

`@pinecall/web` ships native **Custom Elements** so you can drop a Pinecall voice agent into **any** framework — React, Vue, Svelte, Angular, Astro, or plain HTML — with no React dependency. They wrap the same vanilla [`VoiceSession`](/web/core/overview) as the React widget, render in Shadow DOM, and are SSR-safe.

| Import | Element | Needs React |
|---|---|---|
| `@pinecall/web/orb` | `<pinecall-orb>` — a click-to-talk voice orb | ❌ |
| `@pinecall/web/modal` | `<pinecall-modal>` — a glass call modal (orb **or** wave visual, live captions, transcript, text-during-call) | ❌ |
| `@pinecall/web/orb/react` | `<Orb>` — thin React wrapper | ✅ |
| `@pinecall/web/modal/react` | `<CallModal>` — thin React wrapper | ✅ |

```bash
npm install @pinecall/web
```

## Quick start (any framework)

```html
<pinecall-orb agent="mara" name="Mara" preset="midnight"></pinecall-orb>
<pinecall-modal agent="mara" name="Mara" visual="wave"></pinecall-modal>

<script type="module">
  import "@pinecall/web/orb";   // registers <pinecall-orb>
  import "@pinecall/web/modal"; // registers <pinecall-modal>

  // Functions/objects can't be HTML attributes — set them as PROPERTIES:
  const modal = document.querySelector("pinecall-modal");
  modal.tokenProvider = async () => (await fetch("/api/token")).json();
  modal.addEventListener("pinecall:status", (e) => console.log(e.detail));
</script>
```

> Importing the module auto-registers the element (guarded and idempotent; a no-op during SSR). You can also call `definePinecallOrb()` / `definePinecallModal()` explicitly.

## Props, properties & events

**Attributes** (primitives): `agent`, `server`, `name`, `label`, `preset` (`dark` · `midnight` · `aurora` · `sunset` · `light`), `avatar`, and on the modal `visual` (`orb` | `wave`).

**Properties** (functions/objects — set in JS, not as attributes): `config`, `metadata`, `tokenProvider`, `theme`.

**Events**: `pinecall:status` (detail = status), `pinecall:transcript` (detail = messages), `pinecall:error` (detail = message).

**Imperative API**: `connect()`, `disconnect()`, `toggleMute()`, `setMuted()`, `configure()`, `sendText()`, `getState()`; the modal also has `open()` / `close()`.

## `<pinecall-modal>`

A call modal with a launcher button (FAB). Open it and it starts a WebRTC call.

- **`visual="orb"`** — animated orb + status + a single live caption.
- **`visual="wave"`** — a waveform driven by **real `audio.metrics`**, a quoted live caption, an activity sub-status (e.g. `transcribing · Deepgram`), and a Ring → Listen → Think → Speak stepper.
- The **keyboard button** flips to a transcript view: chat bubbles of the whole conversation plus a text input — type during the call and the agent answers in voice and text (via `sendText`).
- Controls: mute (pauses the local mic), hang up, keyboard.

## Theming

Theming uses the same `--vw-*` custom properties as the widget (they inherit through the Shadow boundary), plus modal-specific ones. Use the `preset` attribute, the `theme` property, or plain CSS on the element:

```css
pinecall-modal {
  --vw-color-accent: 205, 88, 178;   /* magenta — also tints the card */
  --pm-user: #34d399;                /* your transcript color */
  --pm-bot: #ffd166;                 /* agent transcript color */
}
```

The card gradient and speaker colors derive from the theme accent by default, so each preset themes the whole modal.

## React wrappers

In React, prefer the wrappers — they bind object/function props cleanly (no refs) and map events to callbacks:

```tsx
import { Orb } from "@pinecall/web/orb/react";
import { CallModal } from "@pinecall/web/modal/react";

<Orb agent="mara" name="Mara"
     tokenProvider={async () => (await fetch("/api/token")).json()}
     onStatus={(s) => console.log(s)} />

<CallModal agent="mara" name="Mara" visual="wave"
           tokenProvider={async () => (await fetch("/api/token")).json()} />
```

## Tokens

Same model as everything else — mint a short-lived token from your backend and hand it back via `tokenProvider`. See [WebRTC in the Browser](/guides/webrtc-browser) and [Security](/security).

## Related

- [`@pinecall/web` (React widget)](/web/widget/overview)
- [`@pinecall/web/core` — VoiceSession](/web/core/overview)
- [`@pinecall/web/chat` — text chat](/web/chat/overview)

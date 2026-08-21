---
title: "Text-to-Speech"
description: "Synthesize speech from text with pc.audio.speech() and pinecall tts — no agent, no call. Streamed, cancellable, with word timestamps."
---

# Text-to-speech

`pc.audio.speech()` turns a string into audio. No agent, no call, no WebSocket —
one HTTP request to the voice server that streams the bytes back **as they are
produced**, so a desktop app can start playing before the sentence is finished.

It is the same TTS stack your agents speak with (ElevenLabs, Cartesia, Rime, …),
reachable on its own. Use it for announcements, notifications, read-aloud,
accessibility, a "preview this voice" button, or anything that needs speech
without a conversation.

- **Billing** — per **character** of input, on your credits. With your own
  provider key configured ([BYOK](/reference/managed-vs-byok)) the characters are
  **not** charged; the provider bills you directly.
- **Where it runs** — Node ≥ 18 and Electron main; a web page or a mobile app
  goes through your own backend (recipes for web, desktop and mobile
  [below](#getting-the-bytes-to-the-player)). The request is a plain
  `fetch`, the result is a Web `ReadableStream`. Keep it **server-side / main
  process**: it needs your API key.
- **Wire contract** — [Audio API reference](/reference/audio-api). The endpoint is
  OpenAI-shaped on purpose; see [Raw HTTP](#raw-http-any-language) below.

---

## The 10-line version

```ts
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });

const r = await pc.audio.speech({
  input: "Hola, tu pedido está listo para retirar.",
  voice: "elevenlabs/sarah",
  language: "es",
  format: "wav",
});
await r.toFile("listo.wav");           // streams to disk as it arrives
const { characters, audioMs } = await r.done;
console.log(`${characters} chars → ${audioMs} ms of audio`);
```

`speech()` resolves **as soon as the response headers arrive** — before any audio
— with a `SpeechResult`:

| Field | What it is |
|---|---|
| `audio` | `ReadableStream<Uint8Array>` — raw bytes in arrival order. Never buffered for you. |
| `format`, `sampleRate`, `channels`, `bitDepth` | What the bytes are: `pcm` / `wav` / `mp3`; 16000 or 24000 Hz; mono; 16-bit. |
| `words` | `AsyncIterable<{ word, start, end }>` — seconds from the start of the audio. Empty unless `timestamps: true`. |
| `done` | `Promise<{ characters, audioMs }>` — resolves when synthesis finishes; rejects on a mid-stream error or a cancel. |
| `cancel()` | Abort the request; the server cancels the synthesis behind it. |
| `arrayBuffer()` / `toFile(path)` | Convenience drains. `toFile` is Node-only and loads `node:fs` lazily, so browser bundles are untouched. |
| `requestId` | The server's request id — quote it when you open a support ticket. |

> **`done` waits for you to drain `audio`.** In the default binary mode the bytes
> are pulled from the socket only as you read `audio` (backpressure reaches the
> server). So `await r.done` on its own will hang: read `audio` to the end,
> or call `arrayBuffer()` / `toFile()`, and *then* await `done`. With
> `timestamps: true` the stream is pumped eagerly and `done` resolves even if you
> never touch the audio.

### Options

```ts
await pc.audio.speech({
  input: "…",                 // 1..5000 characters
  voice: "elevenlabs/sarah",  // "provider/alias" or a raw provider voice id
  model: "elevenlabs/auto",   // optional — "provider/model", "provider/auto", or omit (auto by language)
  language: "es",             // optional ISO-639-1
  format: "pcm",              // "pcm" (default) | "wav" | "mp3" — pcm/wav are s16le mono
  sampleRate: 16000,          // 16000 (default) | 24000, pcm/wav only
  speed: 1.0,                 // optional
  timestamps: false,          // true → word timestamps (see below)
  signal,                     // optional AbortSignal — cancel from outside
});
```

Bound to nothing? The same function is exported top-level:

```ts
import { speech, fetchAudioVoices } from "@pinecall/sdk";
const r = await speech({ apiKey, input, voice });   // apiUrl defaults to https://voice.pinecall.io
```

---

## Streaming playback

The point of a stream is to **start playing on the first chunk**. Ask for `pcm`
(no container, no decoder), hand each chunk to the audio thread as it lands.
Two things are the same whatever you build:

- **The API key never reaches the page or the app.** A browser tab, a webview
  or a mobile bundle can be read by anyone who has it; the key must stay on a
  machine you control — your backend, or the Electron main process. The UI
  talks to *that*, and *that* talks to Pinecall.
- **Playback is the same code everywhere there is Web Audio.** One small
  `AudioWorklet` ring buffer takes s16le chunks and plays them with no gaps;
  the only thing that changes per platform is how the bytes reach it.

### The player: an AudioWorklet ring buffer

s16le in, floats out, silence when it runs dry — this is the whole worklet:

```js
// pcm-player.worklet.js
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];      // Float32Array chunks
    this.offset = 0;      // read position inside queue[0]
    this.port.onmessage = ({ data }) => {
      if (data === "flush") { this.queue = []; this.offset = 0; return; }
      const s16 = new Int16Array(data.buffer, data.byteOffset, data.byteLength >> 1);
      const f32 = new Float32Array(s16.length);
      for (let i = 0; i < s16.length; i++) f32[i] = s16[i] / 32768;
      this.queue.push(f32);
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    let i = 0;
    while (i < out.length && this.queue.length) {
      const head = this.queue[0];
      const n = Math.min(out.length - i, head.length - this.offset);
      out.set(head.subarray(this.offset, this.offset + n), i);
      i += n; this.offset += n;
      if (this.offset >= head.length) { this.queue.shift(); this.offset = 0; }
    }
    for (; i < out.length; i++) out[i] = 0;   // underrun → silence, never a click
    return true;
  }
}
registerProcessor("pcm-player", PcmPlayer);
```

```ts
// player.ts — used as-is by the web, Electron and Capacitor recipes below
let ctx: AudioContext | undefined;
let node: AudioWorkletNode | undefined;

export async function player(sampleRate: number) {
  if (ctx && ctx.sampleRate === sampleRate) return node!;
  ctx = new AudioContext({ sampleRate });            // match the stream — no resampling
  await ctx.audioWorklet.addModule("pcm-player.worklet.js");
  node = new AudioWorkletNode(ctx, "pcm-player", { outputChannelCount: [1] });
  node.connect(ctx.destination);
  return node;
}
export const play = (chunk: Uint8Array) => node?.port.postMessage(chunk, [chunk.buffer]);
export const flush = () => node?.port.postMessage("flush");
export const resume = () => ctx?.resume();          // call from a click/tap — autoplay policy
```

Latency budget: the first chunk arrives a few hundred ms after the request; the
worklet starts playing it on the next 128-frame quantum. Keep the
`AudioContext.sampleRate` equal to `r.sampleRate` so nothing is resampled, and
create/resume the context from a user gesture (browsers and iOS webviews refuse
to start audio otherwise).

### Getting the bytes to the player

Pick your platform — the player above is the same in all three.

<details>
<summary><strong>Web — a plain browser page</strong>: your backend holds the key and streams the audio through</summary>

The page never sees the key: it asks **your** server, which calls
`pc.audio.speech()` and pipes the body straight through. Two ways to play it.

**Simplest — `mp3` and an `<audio>` element.** The browser streams and decodes
it natively; good for notifications, read-aloud, anything where 300–500 ms of
start-up is fine.

```ts
// server.ts (Express; Hono/Fastify are the same three lines)
import express from "express";
import { Readable } from "node:stream";
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });
const app = express();

app.get("/tts", async (req, res) => {
  const r = await pc.audio.speech({
    input: String(req.query.text ?? "").slice(0, 5000),
    voice: "elevenlabs/sarah",
    language: "es",
    format: "mp3",
    signal: AbortSignal.any([AbortSignal.timeout(60_000)]),
  });
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  req.on("close", () => r.cancel());                 // tab closed → stop paying for synthesis
  Readable.fromWeb(r.audio as any).pipe(res);
});
app.listen(3000);
```

```html
<button id="say">Say it</button>
<audio id="out" preload="none"></audio>
<script>
  say.onclick = () => {
    out.src = "/tts?text=" + encodeURIComponent("Tu pedido está listo para retirar.");
    out.play();                                      // inside the click → allowed by autoplay policy
  };
</script>
```

**Lowest latency — `pcm` and the worklet.** Same route with `format: "pcm",
sampleRate: 24000` and `Content-Type: audio/pcm`; the page reads the response
body as a stream and feeds the player:

```ts
import { player, play, flush, resume } from "./player.js";

say.onclick = async () => {
  await player(24000); await resume();
  const res = await fetch("/tts?text=" + encodeURIComponent(text));
  const reader = res.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    play(value);                                     // first chunk plays ~300 ms after the click
  }
};
stop.onclick = () => flush();                        // and abort the fetch to stop the synthesis
```

Per-user auth, rate limits and "who may synthesize what" belong in that route —
it is *your* endpoint. The Pinecall credits are yours too, so cap `text` length
and require a session.

</details>

<details>
<summary><strong>Desktop — Electron</strong>: main holds the key, the renderer plays</summary>

The main process owns the API key and the request; the renderer only ever sees
audio bytes over IPC. (Tauri: same shape — the Rust side calls the
[raw endpoint](#raw-http-any-language) with `response_format: "pcm"` and pushes
`i16` frames into a `rodio::Sink` or `cpal` ring buffer; the webview never sees
the key.)

```ts
// main.ts
import { ipcMain, type WebContents } from "electron";
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });
const live = new Map<string, { cancel(): void }>();

ipcMain.handle("tts:speak", async (e, id: string, input: string, voice = "elevenlabs/sarah") => {
  const r = await pc.audio.speech({ input, voice, format: "pcm", sampleRate: 24000 });
  live.set(id, r);
  e.sender.send("tts:start", { id, sampleRate: r.sampleRate });
  pump(r.audio, e.sender, id).finally(() => live.delete(id));
  return { id, requestId: r.requestId };
});

ipcMain.on("tts:cancel", (_e, id: string) => live.get(id)?.cancel());

async function pump(audio: ReadableStream<Uint8Array>, to: WebContents, id: string) {
  const reader = audio.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      to.send("tts:chunk", { id, chunk: value });   // Uint8Array crosses IPC intact
    }
    to.send("tts:end", { id });
  } catch (err) {
    to.send("tts:error", { id, message: (err as Error).message });
  }
}
```

```ts
// preload.ts
import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("tts", {
  speak: (id: string, text: string, voice?: string) => ipcRenderer.invoke("tts:speak", id, text, voice),
  cancel: (id: string) => ipcRenderer.send("tts:cancel", id),
  on: (ch: string, fn: (p: any) => void) => ipcRenderer.on(`tts:${ch}`, (_e, p) => fn(p)),
});
```

```ts
// renderer.ts
import { player, play, flush } from "./player.js";

window.tts.on("start", async ({ sampleRate }) => { await player(sampleRate); });
window.tts.on("chunk", ({ chunk }) => play(chunk));
window.tts.on("error", ({ message }) => console.error("tts:", message));

document.querySelector("#say")!.addEventListener("click", () => {
  window.tts.speak(crypto.randomUUID(), "Your order is ready.", "elevenlabs/sarah");
});
// Stop: window.tts.cancel(id) in main + flush() here.
```

</details>

<details>
<summary><strong>Mobile — Ionic / Capacitor and React Native</strong>: the web recipe behind a backend, or a file</summary>

A mobile bundle is as public as a web page, so the key lives on your backend
exactly as in the **Web** recipe; the app calls *your* `/tts` route.

**Ionic / Capacitor** — it is a webview, so the **Web** recipe works unchanged:
`<audio src="/tts?text=…">` for mp3, or `fetch` + the worklet for pcm. Two
mobile specifics: start the `AudioContext` (or the first `play()`) inside the
tap handler — iOS refuses audio that does not begin in a user gesture — and
set the Capacitor audio session to playback so it is not muted by the silent
switch (`@capacitor-community/native-audio` or the `AVAudioSession` category in
`AppDelegate`). Background playback needs the `audio` background mode.

**React Native** — there is no Web Audio, so play from a URL or a file:

```ts
// expo-av: stream the mp3 straight from your backend
import { Audio } from "expo-av";
await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
const { sound } = await Audio.Sound.createAsync(
  { uri: `${API}/tts?text=${encodeURIComponent(text)}` },
  { shouldPlay: true },
);
// sound.unloadAsync() when done; react-native-track-player works the same way for background audio.
```

For the shortest start-up on RN fetch the pcm/wav into a file and play it with
`expo-av` from `FileSystem.documentDirectory`; for true streaming with word
timestamps use a native module that accepts raw PCM (e.g. `react-native-audio-api`
or `react-native-pcm-player`) and feed it the chunks from the response stream.

A native CallKit-style experience (a real call to an agent, not TTS playback)
is a different product — see [@pinecall/ionic](/mobile/ionic-overview) and
[@pinecall/react-native](/mobile/react-native).

</details>

### Node without a UI

Pipe the stream into anything that takes s16le on stdin — `ffplay`, `aplay`,
`sox`:

```ts
import { spawn } from "node:child_process";
import { Readable } from "node:stream";

const r = await pc.audio.speech({ input: "Build finished.", voice: "elevenlabs/sarah", sampleRate: 24000 });
const play = spawn("ffplay", ["-nodisp", "-autoexit", "-f", "s16le", "-ar", "24000", "-ch_layout", "mono", "-"], { stdio: ["pipe", "ignore", "ignore"] });
Readable.fromWeb(r.audio as any).pipe(play.stdin);
await r.done;
```

Or skip the code entirely — [`pinecall tts`](#from-the-terminal-pinecall-tts) does
exactly this.

---

## Word timestamps — karaoke, subtitles, highlighting

Pass `timestamps: true`. The wire switches to an event stream; the audio still
flows through `audio`, and `words` yields `{ word, start, end }` (seconds from the
start of the audio) as the provider reports them — usually a little ahead of the
audio they belong to, which is exactly what you want for highlighting.

```ts
const r = await pc.audio.speech({
  input: "Twinkle twinkle little star, how I wonder what you are.",
  voice: "elevenlabs/sarah",
  timestamps: true,
});

// Play the audio (as above) …
void playPcm(r.audio, r.sampleRate);

// … and highlight each word when its time comes.
const t0 = performance.now();
for await (const w of r.words) {
  const due = t0 + w.start * 1000 - performance.now();
  setTimeout(() => highlight(w.word), Math.max(0, due));
}
const { audioMs } = await r.done;
```

For **subtitles**, collect `words` and cut SRT/VTT cues on gaps or every N
words — `end` of the last word in a cue and `start` of the next are already in
audio seconds, so no alignment step is needed.

Not every voice reports word timings. When the provider has none, `words`
completes empty and the audio is unaffected — build the UI so it degrades to
"no highlighting", not to "no speech".

With `timestamps: true`, `done` resolves on the server's final frame whether or
not you have read `audio`, and `characters` / `audioMs` come from the server
rather than being derived from byte counts.

---

## Cancel

`cancel()` aborts the HTTP request and the server cancels the synthesis behind
it. `done` rejects with an `AbortError`, `audio` errors, `words` ends.

```ts
const r = await pc.audio.speech({ input: longText, voice: "elevenlabs/sarah" });
stopButton.onclick = () => r.cancel();

try {
  await r.toFile("long.pcm");
  await r.done;
} catch (err) {
  if ((err as Error).name === "AbortError") console.log("stopped by the user");
  else throw err;
}
```

Prefer an `AbortSignal` when the cancel comes from outside — a route change, a
timeout, a newer utterance superseding this one:

```ts
const ac = new AbortController();
const r = await pc.audio.speech({ input, voice, signal: ac.signal });
setTimeout(() => ac.abort(), 10_000);
```

---

## Choosing a voice and a model

List what `speech()` accepts — it is the same catalog your agents use:

```ts
const es = await pc.audio.voices({ provider: "elevenlabs", language: "es" });
// [{ id, name, alias: "sarah", provider: "elevenlabs", gender, languages: [...], previewUrl }, …]
const voice = `${es[0].provider}/${es[0].alias}`;
```

Or from the terminal: `pinecall voices --provider=elevenlabs --language=es` and
`pinecall voices play elevenlabs/sarah` to hear one.

- **`voice`** is `"provider/alias"` (`elevenlabs/sarah`, `cartesia/ana`) or a raw
  provider voice id (an ElevenLabs `voice_id`, for instance) when you have one.
- **`model`** is optional. Omit it and the server picks the provider's best model
  for `language`; `"elevenlabs/auto"` says the same thing explicitly; a concrete
  `"provider/model"` pins one.
- **Which provider?** ElevenLabs for the widest language and voice coverage and
  the most natural read of long text. **Cartesia** (`sonic-3.5`) when first-byte
  latency is the thing that matters — interactive UIs, rapid short cues. **Rime**
  for ultra-natural expressive English (BYOK only — needs your own Rime key). The
  [TTS providers](/reference/tts-providers) page has the per-provider table.

---

## Errors

Refusals before any audio arrive as a typed `AudioApiError` with `status` and
`code` — branch on `code`, not on the message:

```ts
import { AudioApiError } from "@pinecall/sdk";

try {
  const r = await pc.audio.speech({ input, voice });
} catch (err) {
  if (err instanceof AudioApiError && err.code === "INSUFFICIENT_CREDITS") showTopUp();
  else throw err;
}
```

| HTTP | `code` | Meaning / fix |
|---|---|---|
| 400 | `BAD_REQUEST` | Body malformed — `input` empty, unknown field, bad `sample_rate` |
| 400 | `BAD_MODEL` | `model` is not `provider/model` or `provider/auto` for a known provider |
| 400 | `BAD_VOICE` | Unknown voice — check `pc.audio.voices()` / `pinecall voices` |
| 400 | `FORMAT_UNSUPPORTED` | `response_format` is not `pcm`, `wav` or `mp3` |
| 401 | `MISSING_KEY` / `INVALID_KEY` | No or wrong `Authorization: Bearer` |
| 402 | `SUBSCRIPTION_REQUIRED` / `INSUFFICIENT_CREDITS` | Top up credits or upgrade at [platform.pinecall.io](https://platform.pinecall.io) |
| 413 | `INPUT_TOO_LONG` | More than 5000 characters — split the text |
| 429 | `RATE_LIMITED` | Back off and retry |
| 502 | `UPSTREAM_ERROR` | The TTS provider failed — retry, or try another voice/model |
| 0 | `NETWORK_ERROR` | The voice server could not be reached |

A failure **after** streaming started (the provider drops mid-sentence) cannot
change the HTTP status any more: `done` rejects with an `AudioApiError` whose
`status` is `200` and whose `code` is the server's (typically `UPSTREAM_ERROR`);
`audio` errors and `words` ends. Treat both paths the same way in your UI.

---

## From the terminal: `pinecall tts`

```bash
pinecall tts "Hola, tu pedido está listo." --voice elevenlabs/sarah --lang es -o listo.wav
echo "Build finished" | pinecall tts -o done.mp3            # text from stdin; format from the extension
pinecall tts "Testing" --format wav | ffplay -nodisp -autoexit -   # raw bytes to a pipe
pinecall tts "Twinkle twinkle" --words -o t.pcm              # start<TAB>end<TAB>word on stderr
```

Audio goes to the file or to a **non-TTY** stdout — never to a terminal (it
refuses and prints usage instead). Word timestamps, the summary line
(request id, characters, audio ms, elapsed) and errors go to stderr, so a pipe
stays clean. See the [CLI reference](/reference/cli#pinecall-tts).

---

## Raw HTTP (any language)

The endpoint is deliberately shaped like OpenAI's `POST /v1/audio/speech`, so a
client that already speaks that dialect works with a new base URL and key:

```bash
curl -sS https://voice.pinecall.io/v1/audio/speech \
  -H "Authorization: Bearer $PINECALL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":"Hola mundo","voice":"elevenlabs/sarah","language":"es","response_format":"wav"}' \
  -o hola.wav
```

Add `"timestamps": true` and the response is `text/event-stream` with one JSON
object per `data:` line (`start` → `audio` (base64) / `word` → `done` →
`[DONE]`). The exact body, headers and frames are in the
[Audio API reference](/reference/audio-api).

> **Using the `openai` npm client?** The binary mode maps 1:1 onto
> `audio.speech.create` — `input`, `voice`, `model`, `response_format`, `speed`
> mean the same thing and the body is the audio. Point it at the voice server and
> pass a Pinecall voice; `model` is required by that client's types, so send
> `"elevenlabs/auto"` (or a concrete `provider/model`):
>
> ```ts
> import OpenAI from "openai";
> const tts = new OpenAI({ apiKey: process.env.PINECALL_API_KEY!, baseURL: "https://voice.pinecall.io/v1" });
> const res = await tts.audio.speech.create({ model: "elevenlabs/auto", voice: "elevenlabs/sarah", input: "Hola mundo", response_format: "wav" });
> await fs.writeFile("hola.wav", Buffer.from(await res.arrayBuffer()));
> ```
>
> What that client cannot express — `language`, `sample_rate`, `timestamps` —
> needs `pc.audio.speech()` or the raw request above.

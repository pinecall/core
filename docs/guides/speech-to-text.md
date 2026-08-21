---
title: "Speech-to-Text"
description: "Transcribe a file or a live microphone with pc.audio.transcribe(), pc.audio.transcribeStream() and pinecall stt — no agent, no call. Partials, finals, speaker diarization."
---

# Speech-to-text

`pc.audio.transcribe()` turns an audio file into text. `pc.audio.transcribeStream()`
turns a live PCM stream into text **as it is spoken** — interim *partials* that
keep correcting themselves and committed *finals*. No agent, no call, no
conversation: one HTTP request, or one WebSocket, to the voice server.

It is the same STT stack your agents listen with (ElevenLabs Scribe, Deepgram,
Soniox), reachable on its own. Use it for meeting notes, voice memos, dictation,
subtitles, call recordings with **who said what**, or a "hold to talk" field in a
desktop app.

- **Billing** — per **minute** of audio, on your credits (a stream reports the
  `audioSeconds` it heard and the `billedMinutes` it charged on `done`). With
  your own provider key
  configured ([BYOK](/reference/managed-vs-byok)) the minutes are **not**
  charged; the provider bills you directly.
- **Where it runs** — Node ≥ 18 and Electron main. `transcribe()` is a plain
  `fetch` with a multipart body; `transcribeStream()` needs the `ws` package
  (Node only — the key travels in the `Authorization` header, never in the
  URL). Keep both **server-side / main process**: they need your API key.
- **Wire contract** — [Audio API reference](/reference/audio-api#post-v1audiotranscriptions).
  The batch endpoint is OpenAI-shaped on purpose; see
  [Raw HTTP](#raw-http-any-language) below.

---

## The 10-line version

```ts
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });

const t = await pc.audio.transcribe("meeting.m4a", {   // a path, bytes, or a Blob/File
  language: "es",                                       // omit → auto-detect
  diarize: true,                                        // who said what
  format: "verbose_json",                               // words + segments (+ speakers)
});
for (const s of t.segments!) console.log(`[speaker ${s.speaker}] ${s.text}`);
console.log(`${t.duration.toFixed(1)} s · ${t.language} · ${t.requestId}`);
```

`transcribe()` resolves with a `Transcription`:

| Field | What it is |
|---|---|
| `text` | The whole transcript. |
| `language` | Detected (or requested) ISO-639-1 code. `""` with `format: "text"`. |
| `duration` | Audio length in seconds — what you are billed on. `0` with `format: "text"`. |
| `model` | The model that ran. Only with `format: "verbose_json"`. |
| `words` | `[{ word, start, end, speaker? }]` — seconds from the start of the audio. Only with `verbose_json`. |
| `segments` | `[{ id, start, end, text, speaker? }]` — sentence-ish chunks. Only with `verbose_json`. |
| `requestId` | The server's request id — quote it when you open a support ticket. |

### Options

```ts
await pc.audio.transcribe(input, {
  model: "elevenlabs/scribe_v1",  // default · deepgram/nova-3 · deepgram/nova-2 · soniox/stt-async-preview
  language: "es",                 // optional ISO-639-1; omit to auto-detect
  diarize: true,                  // optional — speaker labels on words and segments (default false)
  format: "json",                 // "json" (default: text+language+duration) | "verbose_json" | "text"
  filename: "call.wav",           // optional — name sent with the file part; the server infers the container
  contentType: "audio/wav",       // optional — inferred from filename / path when omitted
  signal,                         // optional AbortSignal
});
```

`input` is bytes (`Uint8Array` / `ArrayBuffer`), a `Blob`/`File`, or — Node only
— a **path**, read lazily through `node:fs/promises` so a browser bundle that
only ever sends bytes never pays for `fs`. Containers: wav, mp3, m4a, webm, ogg,
flac (and raw pcm/µ-law if you name it so); **max 25 MB** per request — split
longer recordings.

Bound to nothing? The same functions are exported top-level:

```ts
import { transcribe, transcribeStream } from "@pinecall/sdk";
const t = await transcribe(bytes, { apiKey, filename: "a.wav" });   // apiUrl defaults to https://voice.pinecall.io
```

---

## Speaker diarization — who said what

Pass `diarize: true` and ask for `format: "verbose_json"`: every word and every
segment carries a `speaker` label. Labels are **numeric strings** (`"0"`, `"1"`,
…) that are stable **within one request** — speaker `"0"` of one file has
nothing to do with speaker `"0"` of the next, and there are no names: map them
to people yourself (by who spoke first, by channel, by a voice prompt).

```ts
const t = await pc.audio.transcribe("support-call.wav", { diarize: true, format: "verbose_json" });

// Turns — consecutive segments by the same speaker folded together.
const turns: { speaker: string; text: string; start: number }[] = [];
for (const s of t.segments ?? []) {
  const last = turns[turns.length - 1];
  if (last && last.speaker === s.speaker) last.text += " " + s.text.trim();
  else turns.push({ speaker: s.speaker ?? "?", text: s.text.trim(), start: s.start });
}
for (const turn of turns) console.log(`${turn.start.toFixed(1).padStart(6)}  [speaker ${turn.speaker}] ${turn.text}`);
```

Which model to ask for:

| | Batch (`transcribe`) | Live (`transcribeStream`) |
|---|---|---|
| **Soniox** | `soniox/stt-async-preview` — the most accurate labels; 60 languages in one model | `soniox/stt-rt-v5` — labels on `final` segments |
| **Deepgram** | `deepgram/nova-3` / `nova-2` | `deepgram/nova-3` — labels on `final` segments |
| **ElevenLabs** | `elevenlabs/scribe_v1` (the default) | `elevenlabs/scribe_v2_realtime` — **no** diarization: `DIARIZE_UNSUPPORTED` |

With `diarize: true` and `format: "json"` the request is accepted but the answer
has no per-speaker detail (that format has no `segments`) — ask for
`verbose_json`, or `text` through [`pinecall stt --diarize`](#from-the-terminal-pinecall-stt),
which fetches `verbose_json` under the hood and prints `[speaker N]` lines.

---

## Live transcription — `transcribeStream()`

`transcribeStream()` opens the WebSocket **immediately** and returns a
`TranscribeStream`. Write raw PCM into it as you capture it; the server answers
with `partial` frames (the current hypothesis, replaced by the next) and
`final` frames (committed text, with timings and a speaker label when
diarized). Bytes written before the server says `ready` are buffered and sent
in order, so you can start writing at once.

```ts
const stream = pc.audio.transcribeStream({
  model: "deepgram/nova-3",   // default · elevenlabs/scribe_v2_realtime · soniox/stt-rt-v5
  language: "es",             // optional; omit to auto-detect
  sampleRate: 16000,          // 8000 | 16000 (default) | 24000 | 48000 — the rate of the PCM YOU write
  encoding: "linear16",       // "linear16" (default, s16le mono) | "mulaw"
  diarize: true,              // soniox / deepgram only
});

stream.on("ready",   ({ requestId, model, sampleRate }) => console.log("listening", model, sampleRate));
stream.on("partial", (text) => process.stdout.write(`\r… ${text}`));
stream.on("final",   ({ text, speaker, start, end }) => console.log(`\n[speaker ${speaker}] ${text}`));
stream.on("error",   (err) => console.error(err.code, err.message));

mic.on("data", (pcm: Buffer) => stream.write(pcm));       // s16le mono @ sampleRate

// Later — the user let go of the button:
const { audioSeconds, billedMinutes } = await stream.end();
```

| Member | What it does |
|---|---|
| `write(chunk)` | Send audio (`Uint8Array` / `ArrayBuffer`, s16le mono at `sampleRate`). Buffered until `ready`. |
| `finalize()` | Ask the server to commit what it has heard **now** — a `final` follows. Use it when the user pauses, or before you swap the UI, without closing the stream. |
| `end()` | No more audio: the server flushes, sends `done` and closes (1000). Resolves with `{ audioSeconds, billedMinutes }`. |
| `close()` | Hang up now (close 1000) without waiting for `done`. A pending `end()` rejects with `CLOSED`. |
| `ready` | `Promise<void>` — resolves on the server's `ready`, rejects on a refusal (bad key, bad args). |
| `requestId` | Filled on `ready`. |
| events | `ready`, `partial`, `final`, `done`, `error`, `close` — `on` / `off` / `once`. |
| `for await (const item of stream)` | `{ type: "partial", text }` and `{ type: "final", segment }` in order; ends on `done`, throws on `error`. |

```ts
// The iterator form — the whole stream as one loop.
for await (const item of stream) {
  if (item.type === "partial") ui.setDraft(item.text);
  else ui.commit(item.segment.text, item.segment.speaker);
}
```

**Partial vs final.** A partial is a guess about the utterance in progress —
show it greyed out and *replace* it with every new partial. A final is done:
append it to the transcript and clear the draft. Providers differ in how eagerly
they commit; `finalize()` forces the issue when your UI needs a clean cut (the
user pressed Enter, a pause longer than a second, a field lost focus).

**Closing.** `end()` is the polite way: it waits for the last `final` and
brings back the billing. `close()` is for "the window is gone" — nothing after
it. Either way `close` fires last, with the socket's close code (`1000` after
`done`, `1008` after an auth/argument refusal, `1011` after an upstream
failure).

### From a desktop app (Electron)

The renderer captures the microphone and turns it into **PCM16 chunks**; the
main process holds the API key and owns the stream; partials and finals travel
back over IPC. The mirror image of the [TTS playback section](/guides/text-to-speech#electron-main-holds-the-key-the-renderer-plays).

The capture worklet — floats in from the mic, s16le out over the port, in
~100 ms chunks:

```js
// pcm-capture.worklet.js
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(1600);   // 100 ms @ 16 kHz
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);   // transfer, no copy
        this.buf = new Int16Array(1600);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
```

```ts
// renderer.ts
let ctx: AudioContext | undefined;
let node: AudioWorkletNode | undefined;
let micStream: MediaStream | undefined;

async function startListening() {
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  ctx = new AudioContext({ sampleRate: 16000 });          // match the stream — the worklet sees 16 kHz floats
  await ctx.audioWorklet.addModule("pcm-capture.worklet.js");
  node = new AudioWorkletNode(ctx, "pcm-capture", { numberOfOutputs: 0 });
  node.port.onmessage = ({ data }) => window.stt.audio(new Uint8Array(data));   // ArrayBuffer → IPC
  ctx.createMediaStreamSource(micStream).connect(node);
  await window.stt.start({ language: "es", diarize: false });
}

async function stopListening() {
  micStream?.getTracks().forEach((t) => t.stop());
  await ctx?.close();
  const { audioSeconds } = await window.stt.stop();       // resolves on the server's `done`
  console.log(`${audioSeconds.toFixed(1)} s transcribed`);
}

window.stt.on("partial", ({ text }) => draft.textContent = text);
window.stt.on("final", ({ text, speaker }) => {
  draft.textContent = "";
  transcript.append(Object.assign(document.createElement("p"), { textContent: speaker ? `[${speaker}] ${text}` : text }));
});
window.stt.on("error", ({ code, message }) => showToast(`${code}: ${message}`));
```

```ts
// preload.ts
import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("stt", {
  start: (opts: { language?: string; diarize?: boolean }) => ipcRenderer.invoke("stt:start", opts),
  audio: (chunk: Uint8Array) => ipcRenderer.send("stt:audio", chunk),
  finalize: () => ipcRenderer.send("stt:finalize"),
  stop: () => ipcRenderer.invoke("stt:stop"),
  on: (ch: string, fn: (p: any) => void) => ipcRenderer.on(`stt:${ch}`, (_e, p) => fn(p)),
});
```

```ts
// main.ts
import { ipcMain } from "electron";
import { Pinecall, type TranscribeStream } from "@pinecall/sdk";

const pc = new Pinecall({ apiKey: process.env.PINECALL_API_KEY! });
let live: TranscribeStream | undefined;

ipcMain.handle("stt:start", async (e, opts: { language?: string; diarize?: boolean }) => {
  live?.close();
  const s = pc.audio.transcribeStream({ sampleRate: 16000, ...opts });
  live = s;
  s.on("partial", (text) => e.sender.send("stt:partial", { text }));
  s.on("final", (seg) => e.sender.send("stt:final", { text: seg.text, speaker: seg.speaker, start: seg.start, end: seg.end }));
  s.on("error", (err) => e.sender.send("stt:error", { code: err.code, message: err.message }));
  await s.ready;                                          // rejects on a bad key / bad args
  return { requestId: s.requestId };
});

ipcMain.on("stt:audio", (_e, chunk: Uint8Array) => live?.write(chunk));   // Uint8Array crosses IPC intact
ipcMain.on("stt:finalize", () => live?.finalize());
ipcMain.handle("stt:stop", async () => {
  const s = live; live = undefined;
  return s ? await s.end() : { audioSeconds: 0, billedMinutes: 0 };
});
```

Latency: at 16 kHz a 100 ms chunk is 3200 bytes; the first partial lands a few
hundred ms after speech starts. Keep the `AudioContext.sampleRate` equal to
`sampleRate` so no resampling happens in between. (`getUserMedia` at 16 kHz
works on Chromium / Electron; a browser that refuses the rate hands you 48 kHz
floats — downsample in the worklet, or pass `sampleRate: 48000` and let the
server do it.)

**Tauri / native** — same shape: the Rust side opens the
[WebSocket](#raw-http-any-language) with the `Authorization` header, writes
`i16` frames from `cpal`, and forwards `partial` / `final` JSON to the webview;
the key never leaves the native side.

### Node without a UI

Anything that produces s16le mono on stdout can be piped in — `sox`, `ffmpeg`,
`arecord`:

```ts
import { spawn } from "node:child_process";

const mic = spawn("sox", ["-d", "-r", "16000", "-c", "1", "-b", "16", "-e", "signed", "-t", "raw", "-"], { stdio: ["ignore", "pipe", "ignore"] });
const stream = pc.audio.transcribeStream({ sampleRate: 16000 });
mic.stdout.on("data", (chunk: Buffer) => stream.write(chunk));
stream.on("final", ({ text }) => console.log(text));
process.on("SIGINT", async () => { mic.kill(); console.error(await stream.end()); });
```

Or skip the code entirely — [`pinecall stt --stream`](#from-the-terminal-pinecall-stt)
does exactly this.

---

## Choosing a model

The model is `provider/model`; omit it and the server uses the default for the
mode. Live and batch take **different** model lists — a realtime model cannot
transcribe a file and vice versa.

| Model | Mode | Latency | Languages | Diarization | Good for |
|---|---|---|---|---|---|
| `elevenlabs/scribe_v1` | batch (default) | — | 90+, auto-detect | yes | Recordings, voice memos: high accuracy, wide language coverage |
| `deepgram/nova-3` | batch + live (default live) | low | 60+ incl. Hindi, Thai, CJK | yes | The all-round live model; fast batch |
| `deepgram/nova-2` | batch | — | 30+ | yes | Older Nova; English-heavy recordings |
| `soniox/stt-async-preview` | batch | — | 60, one model | **best** | Meetings and calls where who-said-what matters; code-switching |
| `elevenlabs/scribe_v2_realtime` | live | low | 90+ | no | Live dictation in many languages (the agents' default for Arabic) |
| `soniox/stt-rt-v5` | live | low | 60, one model, switches mid-sentence | yes | Live multilingual with speakers |

Price tier: all of the above run on Pinecall's managed keys and are billed per
audio minute from the same credits; the exact per-minute rate of each model is
in `GET /api/rates/models` and on the
[Managed vs BYOK](/reference/managed-vs-byok) page. With your own ElevenLabs /
Deepgram / Soniox key configured, the provider bills you and Pinecall charges
nothing for the minutes. The per-provider tuning knobs your **agents** accept
(endpointing, keyterms, `context`, …) are on the
[STT providers](/reference/stt-providers) page; the standalone endpoints take
only `language` and `diarize`.

---

## Errors

Refusals arrive as a typed `AudioApiError` with `status` and `code` — branch on
`code`, not on the message. `transcribe()` throws; `transcribeStream()` emits
`error` (and rejects `ready` / `end()`, and makes the iterator throw).

```ts
import { AudioApiError } from "@pinecall/sdk";

try {
  await pc.audio.transcribe(file, { diarize: true, format: "verbose_json" });
} catch (err) {
  if (err instanceof AudioApiError && err.code === "FILE_TOO_LARGE") return splitAndRetry(file);
  throw err;
}
```

| HTTP | `code` | Meaning / fix |
|---|---|---|
| 400 | `BAD_REQUEST` | Malformed request — missing file part, bad `language`, bad `sample_rate` / `encoding` |
| 400 | `BAD_MODEL` | `model` is not one of the allowed `provider/model` for this mode |
| 400 | `DIARIZE_UNSUPPORTED` | This model has no speaker labels — drop `diarize` or pick Soniox / Deepgram |
| 401 | `MISSING_KEY` / `INVALID_KEY` | No or wrong `Authorization: Bearer` |
| 402 | `SUBSCRIPTION_REQUIRED` / `INSUFFICIENT_CREDITS` | Top up credits or upgrade at [platform.pinecall.io](https://platform.pinecall.io) |
| 413 | `FILE_TOO_LARGE` | More than 25 MB — trim, compress (mp3/ogg) or split |
| 415 | `UNSUPPORTED_MEDIA` | The container is not one the server decodes — send wav, mp3, m4a, webm, ogg or flac |
| 429 | `RATE_LIMITED` | Back off and retry |
| 502 | `UPSTREAM_ERROR` | The STT provider failed — retry, or try another model |
| 504 | `UPSTREAM_TIMEOUT` | The STT provider timed out — retry, or send a shorter file |
| 0 | `NETWORK_ERROR` | The voice server could not be reached, or the socket dropped before `done` |
| 0 | `CLOSED` | The stream was closed (by you or the server) before `done` |

On the socket a refusal is an `error` frame with the same codes (the server
then closes `1008` for auth/arguments, `1011` for upstream); the `AudioApiError`
carries the frame's `code`. A socket that drops without a frame is a
`NETWORK_ERROR`.

---

## From the terminal: `pinecall stt`

```bash
pinecall stt meeting.m4a                                    # plain text on stdout
pinecall stt call.wav --diarize                             # [speaker 0] … / [speaker 1] … lines
pinecall stt talk.mp3 --format srt -o talk.srt              # subtitles (srt | vtt) from segments
pinecall stt memo.wav --format verbose_json --lang es       # words + segments as JSON
pinecall stt a.wav --model soniox/stt-async-preview --diarize --format json
```

Live, from the microphone — raw s16le mono PCM on stdin:

```bash
sox -d -r 16000 -c 1 -b 16 -e signed -t raw - | pinecall stt --stream
ffmpeg -f avfoundation -i :0 -ac 1 -ar 16000 -f s16le - | pinecall stt --stream --lang es   # macOS
ffmpeg -f alsa -i default -ac 1 -ar 16000 -f s16le - | pinecall stt --stream --diarize        # Linux
pinecall stt --stream --rate 48000 --model soniox/stt-rt-v5 < recording.raw
```

The transcript goes to stdout (or `-o`); the summary line (request id, audio
seconds, model, elapsed), partials (one rewriting line, only when stderr is a
TTY) and errors go to stderr, so a pipe stays clean. Finals are one line each on
stdout — `[speaker N] text` with `--diarize`. Ctrl-C or stdin EOF ends the
stream politely and prints the audio seconds and billed minutes. See the
[CLI reference](/reference/cli#pinecall-stt).

---

## Raw HTTP (any language)

The batch endpoint is deliberately shaped like OpenAI's
`POST /v1/audio/transcriptions` — multipart with `file`, `model`, `language`,
`response_format` — so a client that already speaks that dialect works with a
new base URL and key. `diarize` is a Pinecall addition.

```bash
curl -sS https://voice.pinecall.io/v1/audio/transcriptions \
  -H "Authorization: Bearer $PINECALL_API_KEY" \
  -F file=@call.wav \
  -F model=soniox/stt-async-preview \
  -F language=es \
  -F diarize=true \
  -F response_format=verbose_json
```

> **Using the `openai` npm client?** `audio.transcriptions.create` maps onto the
> batch endpoint: `file`, `model`, `language` and `response_format` (`json` |
> `text` | `verbose_json`) mean the same thing, and `model` is required by that
> client's types, so name one:
>
> ```ts
> import OpenAI from "openai";
> import fs from "node:fs";
> const stt = new OpenAI({ apiKey: process.env.PINECALL_API_KEY!, baseURL: "https://voice.pinecall.io/v1" });
> const r = await stt.audio.transcriptions.create({ file: fs.createReadStream("call.wav"), model: "elevenlabs/scribe_v1", language: "es" });
> console.log(r.text);
> ```
>
> What that client cannot express — `diarize`, the `speaker` labels on `words` /
> `segments`, and the live WebSocket — needs `pc.audio.transcribe()` /
> `transcribeStream()` or the raw requests.

The live endpoint is a WebSocket —
`wss://voice.pinecall.io/v1/audio/transcriptions/stream?model=&language=&sample_rate=&encoding=&diarize=`
with `Authorization: Bearer` on the upgrade. You send binary frames (the audio)
and two text frames (`{"type":"finalize"}`, `{"type":"stop"}`); the server sends
`ready` → `partial` / `final` … → `done`, or `error`. The exact frames, query
parameters and close codes are in the
[Audio API reference](/reference/audio-api#ws-v1audiotranscriptionsstream).

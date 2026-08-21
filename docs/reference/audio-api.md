---
title: "Audio API"
description: "Wire contract for standalone text-to-speech: POST /v1/audio/speech and GET /v1/audio/voices on the voice server — body, response modes, headers, error codes."
---

# Audio API

The HTTP surface behind [`pc.audio.speech()`](/guides/text-to-speech) and
`pinecall tts`. Standalone text-to-speech on the voice server — no agent, no
call. This page is the **wire contract**; the guide is the tutorial.

Base URL: `https://voice.pinecall.io` (the SDK's `apiUrl`). Auth: your API key as
`Authorization: Bearer <api key>`. Billed per character of `input`; with your own
provider key ([BYOK](/reference/managed-vs-byok)) the characters are not charged.

---

## `POST /v1/audio/speech`

`POST {apiUrl}/v1/audio/speech`, `Authorization: Bearer <api key>`, JSON body:

```
input            string, required, 1..5000 chars
voice            string, required: "provider/alias" ("elevenlabs/sarah") or a raw provider voice id
model?           "provider/model" | "provider/auto" | omitted (auto by language)
language?        ISO-639-1 ("es")
response_format? "pcm" (default) | "wav" | "mp3"      (pcm/wav = s16le mono @ sample_rate)
sample_rate?     16000 (default) | 24000
speed?           number
timestamps?      boolean (default false)
```

### Response — `timestamps=false` (binary)

`timestamps=false` → 200 chunked body, `Content-Type: audio/pcm` (+ `X-Sample-Rate`, `X-Channels`, `X-Bit-Depth`) | `audio/wav` | `audio/mpeg`; always `X-Pinecall-Request-Id`.

The body is the audio, streamed as it is produced. The SDK maps
`Content-Type` → `result.format`, `X-Sample-Rate` → `result.sampleRate`,
`X-Pinecall-Request-Id` → `result.requestId`. When the server also sends
`X-Pinecall-Characters` / `X-Pinecall-Audio-Ms` the SDK uses them for
`result.done`; otherwise `characters` falls back to `input.length` and `audioMs`
is derived from the byte count for pcm/wav (0 for mp3).

> In this mode the SDK pulls the body only as you read `result.audio`
> (backpressure reaches the socket), so `result.done` resolves only once
> `result.audio` has been drained — read it to the end, or use `arrayBuffer()` /
> `toFile()`, before awaiting `done`.

### Response — `timestamps=true` (event stream)

`timestamps=true` → 200 `text/event-stream`, JSON per `data:` line: `{type:'start',request_id,format,sample_rate}` → `{type:'audio',data:<base64>}` / `{type:'word',word,start,end}` (seconds) → `{type:'done',characters,audio_ms}` → `data: [DONE]`; mid-stream failure `{type:'error',code,error}`.

```
data: {"type":"start","request_id":"req_01J…","format":"pcm","sample_rate":16000}

data: {"type":"audio","data":"AAD//wEA…"}

data: {"type":"word","word":"hola","start":0.0,"end":0.42}

data: {"type":"audio","data":"…"}

data: {"type":"done","characters":10,"audio_ms":900}

data: [DONE]
```

The SDK decodes `audio` frames into `result.audio`, routes `word` frames to
`result.words`, resolves `result.done` on the `done` frame, and closes both on
`[DONE]`. An `error` frame rejects `done` (as an `AudioApiError` with
`status: 200` and the frame's `code`), errors `audio` and ends `words`. In this
mode the SDK pumps the stream eagerly, so words flow and `done` resolves even if
`audio` is never read. The SDK sends `Accept: text/event-stream` for this mode
and `Accept: audio/*` otherwise.

### Errors (before streaming)

Errors before streaming: JSON `{error, code}` with 400 BAD_REQUEST|BAD_MODEL|BAD_VOICE|FORMAT_UNSUPPORTED, 401 MISSING_KEY|INVALID_KEY, 402 SUBSCRIPTION_REQUIRED|INSUFFICIENT_CREDITS, 413 INPUT_TOO_LONG, 429 RATE_LIMITED, 502 UPSTREAM_ERROR. Aborting the request cancels synthesis server-side.

| HTTP | `code` |
|---|---|
| 400 | `BAD_REQUEST`, `BAD_MODEL`, `BAD_VOICE`, `FORMAT_UNSUPPORTED` |
| 401 | `MISSING_KEY`, `INVALID_KEY` |
| 402 | `SUBSCRIPTION_REQUIRED`, `INSUFFICIENT_CREDITS` |
| 413 | `INPUT_TOO_LONG` |
| 429 | `RATE_LIMITED` |
| 502 | `UPSTREAM_ERROR` |

In the SDK these arrive as `AudioApiError { status, code, message }` thrown from
`speech()`. Two client-side codes exist too: `NETWORK_ERROR` (`status: 0`, the
server could not be reached) and `MISSING_KEY` (`status: 0`, no `apiKey` given).

### Cancel

Aborting the request (`result.cancel()`, or the `signal` you passed) cancels
synthesis server-side. `done` rejects with an `AbortError`.

---

## `GET /v1/audio/voices`

`GET {apiUrl}/v1/audio/voices?provider=&language=` → same shape as `/api/sdk/voices` (`{success, voices, total}`; reuse `mapVoice` from src/api/voices.ts).

Both query parameters are optional. The SDK (`pc.audio.voices()` /
`fetchAudioVoices()`) maps each row to a `Voice`:

```ts
interface Voice {
  id: string;            // provider voice id
  name: string;
  alias?: string;        // → use as "provider/alias" in `voice`
  provider: string;
  gender?: string;
  style?: string;
  languages: { code: string; name: string; flag?: string; nativeName?: string; region?: string }[];
  description?: string;
  previewUrl?: string;
}
```

---

## SDK surface

```ts
import { speech, fetchAudioVoices, AudioApiError } from "@pinecall/sdk";
import type { SpeechOptions, SpeechResult, SpeechWord, SpeechDone, SpeechFormat } from "@pinecall/sdk";

interface SpeechOptions {
  input: string; voice: string; model?: string; language?: string;
  format?: "pcm" | "wav" | "mp3"; sampleRate?: 16000 | 24000; speed?: number;
  timestamps?: boolean; signal?: AbortSignal;
}
interface SpeechWord { word: string; start: number; end: number }     // seconds
interface SpeechDone { characters: number; audioMs: number }
interface SpeechResult {
  requestId: string; format: "pcm" | "wav" | "mp3"; sampleRate: number; channels: 1; bitDepth: 16;
  audio: ReadableStream<Uint8Array>;      // raw bytes as they arrive (base64-decoded in SSE mode)
  words: AsyncIterable<SpeechWord>;       // empty when timestamps=false or the provider has none
  done: Promise<SpeechDone>;
  cancel(): void;                         // aborts the request
  arrayBuffer(): Promise<ArrayBuffer>;
  toFile(path: string): Promise<void>;    // Node only — node:fs imported lazily
}

function speech(opts: SpeechOptions & { apiKey: string; apiUrl?: string }): Promise<SpeechResult>;
function fetchAudioVoices(opts?: { provider?: string; language?: string; apiKey?: string; apiUrl?: string }): Promise<Voice[]>;
class AudioApiError extends PinecallError { status: number; code: string }
```

`pc.audio.speech(opts)` and `pc.audio.voices(opts)` are the same two functions
bound to the client's `apiKey` / `apiUrl`. Body field mapping: `format` →
`response_format`, `sampleRate` → `sample_rate`; everything else is sent under
its own name, and omitted options are omitted from the body.

---

## Shape compatibility

The binary mode is deliberately the shape of OpenAI's `POST /v1/audio/speech`
(`input`, `voice`, `model`, `response_format`, `speed`; the body is the audio), so
an OpenAI-dialect client pointed at `https://voice.pinecall.io/v1` with a Pinecall
key and a Pinecall voice works for that mode. `language`, `sample_rate` and
`timestamps` are Pinecall additions. See the
[guide](/guides/text-to-speech#raw-http-any-language) for the `curl` and
`openai` examples.

---
title: "Audio API"
description: "Wire contract for standalone speech on the voice server: POST /v1/audio/speech, GET /v1/audio/voices, POST /v1/audio/transcriptions and WS /v1/audio/transcriptions/stream — bodies, frames, headers, error codes."
---

# Audio API

The HTTP and WebSocket surface behind [`pc.audio.speech()`](/guides/text-to-speech)
/ `pinecall tts` and [`pc.audio.transcribe()` / `pc.audio.transcribeStream()`](/guides/speech-to-text)
/ `pinecall stt`. Standalone text-to-speech and speech-to-text on the voice
server — no agent, no call. This page is the **wire contract**; the guides are
the tutorials.

Base URL: `https://voice.pinecall.io` (the SDK's `apiUrl`). Auth: your API key as
`Authorization: Bearer <api key>`. TTS is billed per character of `input`, STT
per minute of audio; with your own provider key
([BYOK](/reference/managed-vs-byok)) neither is charged.

| Endpoint | What | SDK |
|---|---|---|
| [`POST /v1/audio/speech`](#post-v1audiospeech) | Text → audio (binary or event stream) | `pc.audio.speech()` |
| [`GET /v1/audio/voices`](#get-v1audiovoices) | The voice catalog | `pc.audio.voices()` |
| [`POST /v1/audio/transcriptions`](#post-v1audiotranscriptions) | Audio file → transcript (multipart, OpenAI shape, diarization) | `pc.audio.transcribe()` |
| [`WS /v1/audio/transcriptions/stream`](#ws-v1audiotranscriptionsstream) | Live PCM → partial / final frames | `pc.audio.transcribeStream()` |

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

## `POST /v1/audio/transcriptions`

`POST {apiUrl}/v1/audio/transcriptions` — multipart/form-data, `Authorization: Bearer <api key>`

```
file             required; audio file (wav/mp3/m4a/webm/ogg/flac…), max 25 MB → 413 FILE_TOO_LARGE
model?           "provider/model" | "provider" | omitted → "elevenlabs/scribe_v1". Allowed: elevenlabs/scribe_v1, deepgram/nova-3, deepgram/nova-2, soniox/stt-async-preview
language?        ISO-639-1; omitted → auto-detect
diarize?         "true"|"false" (default false)
response_format? "json" (default) | "verbose_json" | "text"
```

`json` → `{text, language, duration}` (seconds) · `verbose_json` → `{text, language, duration, model, words:[{word,start,end,speaker?}], segments:[{id,start,end,text,speaker?}]}` · `text` → text/plain body. Always `X-Pinecall-Request-Id`. Errors JSON `{error, code}`: 400 BAD_REQUEST|BAD_MODEL|DIARIZE_UNSUPPORTED, 401 MISSING_KEY|INVALID_KEY, 402 SUBSCRIPTION_REQUIRED|INSUFFICIENT_CREDITS, 413 FILE_TOO_LARGE, 415 UNSUPPORTED_MEDIA, 429 RATE_LIMITED, 502 UPSTREAM_ERROR, 504 UPSTREAM_TIMEOUT.

```json
// response_format=verbose_json, diarize=true
{
  "text": "Hola qué tal. Muy bien gracias.",
  "language": "es",
  "duration": 3.2,
  "model": "soniox/stt-async-preview",
  "words": [
    { "word": "Hola", "start": 0.0, "end": 0.4, "speaker": "0" },
    { "word": "Muy", "start": 1.8, "end": 2.0, "speaker": "1" }
  ],
  "segments": [
    { "id": 0, "start": 0.0, "end": 0.9, "text": "Hola qué tal.", "speaker": "0" },
    { "id": 1, "start": 1.8, "end": 2.9, "text": "Muy bien gracias.", "speaker": "1" }
  ]
}
```

| HTTP | `code` |
|---|---|
| 400 | `BAD_REQUEST`, `BAD_MODEL`, `DIARIZE_UNSUPPORTED` |
| 401 | `MISSING_KEY`, `INVALID_KEY` |
| 402 | `SUBSCRIPTION_REQUIRED`, `INSUFFICIENT_CREDITS` |
| 413 | `FILE_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA` |
| 429 | `RATE_LIMITED` |
| 502 | `UPSTREAM_ERROR` |
| 504 | `UPSTREAM_TIMEOUT` |

The SDK (`pc.audio.transcribe()` / `transcribe()`) sends the file as the `file`
part (a `Blob` named after `filename` / the path, typed from `contentType` or
the extension, `audio/wav` as the last resort), `format` → `response_format`,
`diarize` → `"true"`/`"false"`, `model` / `language` under their own names;
omitted options are omitted from the form. `Accept` is `text/plain` for
`format: "text"` and `application/json` otherwise. The answer is mapped to a
`Transcription` (`speaker` normalised to a string, `X-Pinecall-Request-Id` →
`requestId`); a `text/plain` answer becomes `{ text, language: "", duration: 0 }`.
Refusals throw `AudioApiError { status, code }`; `NETWORK_ERROR` (`status: 0`)
when the server is unreachable, `MISSING_KEY` (`status: 0`) with no `apiKey`;
an aborted `signal` throws an `AbortError`.

---

## `WS /v1/audio/transcriptions/stream`

`WS {wsUrl}/v1/audio/transcriptions/stream?model=&language=&sample_rate=&encoding=&diarize=`

`model` default deepgram/nova-3 (allowed: deepgram/nova-3, elevenlabs/scribe_v2_realtime, soniox/stt-rt-v5); `sample_rate` 16000 default (8000|16000|24000|48000); `encoding` linear16 (default) | mulaw; `diarize` true|false (soniox/deepgram only). Auth: `Authorization: Bearer` header (Node `ws` supports headers) — `?api_key=` exists as a fallback, the SDK must NOT use it (the key would be in URLs/logs).

Server → `{type:'ready',request_id,model,sample_rate,encoding,diarize}` · `{type:'partial',text}` · `{type:'final',text,start?,end?,language?,speaker?,words?:[{word,start,end,speaker?}]}` · `{type:'done',request_id,audio_seconds,billed_minutes}` then close 1000 · `{type:'error',code,error}` then close 1008 (auth/args) or 1011 (upstream).

Client → binary frames = audio bytes; text `{type:'finalize'}` (commit what it has), `{type:'stop'}` (finish → done → close).

```
← {"type":"ready","request_id":"req_01J…","model":"deepgram/nova-3","sample_rate":16000,"encoding":"linear16","diarize":false}
→ <binary: 3200 bytes of s16le>
→ <binary: 3200 bytes of s16le>
← {"type":"partial","text":"hola qu"}
← {"type":"partial","text":"hola qué tal"}
← {"type":"final","text":"Hola qué tal.","start":0.0,"end":0.9,"language":"es","speaker":"0"}
→ {"type":"finalize"}
← {"type":"final","text":"Muy bien.","start":1.8,"end":2.4,"speaker":"1"}
→ {"type":"stop"}
← {"type":"done","request_id":"req_01J…","audio_seconds":12.4,"billed_minutes":1}
← close 1000
```

| Close code | When |
|---|---|
| `1000` | After `done` (normal), or the client's own `close()` |
| `1008` | After an `error` frame for auth / arguments (`MISSING_KEY`, `INVALID_KEY`, `BAD_MODEL`, `BAD_REQUEST`, `DIARIZE_UNSUPPORTED`, `SUBSCRIPTION_REQUIRED`, `INSUFFICIENT_CREDITS`, `RATE_LIMITED`) |
| `1011` | After an `error` frame for an upstream failure (`UPSTREAM_ERROR`, `UPSTREAM_TIMEOUT`) |

A refused handshake (HTTP 401 / 402 / 429 before the upgrade) is reported by the
SDK as an `AudioApiError` with that status.

The SDK (`pc.audio.transcribeStream()` / `transcribeStream()`) derives `ws(s)://`
from `apiUrl`, puts only the options you gave on the query (`sampleRate` →
`sample_rate`), sends the key in the `Authorization` header, opens the socket at
construction and buffers `write()` until `ready`; `finalize()` / `end()` send the
two text frames, `end()` resolves on `done`. Frames become events (`ready`,
`partial`, `final`, `done`, `error`, `close`) and async-iterator items (`{type:
'partial', text}` / `{type: 'final', segment}`); `speaker` is normalised to a
string. An `error` frame → `AudioApiError` with the frame's `code` (`status`
200); a close without `done` and without a frame → `NETWORK_ERROR` (non-1000) or
`CLOSED` (the client's own `close()` / a clean 1000 before done).

---

## SDK surface

```ts
import { speech, fetchAudioVoices, transcribe, transcribeStream, AudioApiError } from "@pinecall/sdk";
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

```ts
import type {
  TranscribeOptions, Transcription, TranscriptWord, TranscriptSegment, TranscriptionModel, TranscribeInput,
  TranscribeStreamOptions, TranscribeStream, TranscribeStreamEvents, TranscribeStreamItem,
  StreamModel, StreamFinal, StreamReady, StreamDone,
} from "@pinecall/sdk";

type TranscriptionModel = "elevenlabs/scribe_v1" | "deepgram/nova-3" | "deepgram/nova-2" | "soniox/stt-async-preview" | (string & {});
interface TranscribeOptions {
  model?: TranscriptionModel; language?: string; diarize?: boolean;
  format?: "json" | "verbose_json" | "text"; filename?: string; contentType?: string; signal?: AbortSignal;
}
interface TranscriptWord { word: string; start: number; end: number; speaker?: string }        // seconds
interface TranscriptSegment { id: number; start: number; end: number; text: string; speaker?: string }
interface Transcription {
  requestId: string; text: string; language: string; duration: number;
  model?: string; words?: TranscriptWord[]; segments?: TranscriptSegment[];                    // verbose_json only
}
type TranscribeInput = Uint8Array | ArrayBuffer | Blob | string;                               // string = a path (Node)
function transcribe(input: TranscribeInput, opts: TranscribeOptions & { apiKey: string; apiUrl?: string }): Promise<Transcription>;

type StreamModel = "deepgram/nova-3" | "elevenlabs/scribe_v2_realtime" | "soniox/stt-rt-v5" | (string & {});
interface TranscribeStreamOptions {
  model?: StreamModel; language?: string; sampleRate?: 8000 | 16000 | 24000 | 48000;
  encoding?: "linear16" | "mulaw"; diarize?: boolean;
}
interface StreamReady { requestId: string; model: string; sampleRate: number }
interface StreamFinal { text: string; start?: number; end?: number; language?: string; speaker?: string; words?: TranscriptWord[] }
interface StreamDone { audioSeconds: number; billedMinutes: number }
interface TranscribeStreamEvents {
  ready: (info: StreamReady) => void; partial: (text: string) => void; final: (seg: StreamFinal) => void;
  done: (info: StreamDone) => void; error: (err: AudioApiError) => void; close: (code: number) => void;
}
type TranscribeStreamItem = { type: "partial"; text: string } | { type: "final"; segment: StreamFinal };
interface TranscribeStream {
  readonly requestId: string;             // filled on `ready`
  readonly ready: Promise<void>;
  write(chunk: Uint8Array | ArrayBuffer): void;   // buffered until ready
  finalize(): void;                               // → {type:'finalize'}
  end(): Promise<StreamDone>;                     // → {type:'stop'}; resolves on `done`
  close(): void;                                  // close 1000 now
  on<K extends keyof TranscribeStreamEvents>(ev: K, fn: TranscribeStreamEvents[K]): this;
  off<K extends keyof TranscribeStreamEvents>(ev: K, fn: TranscribeStreamEvents[K]): this;
  once<K extends keyof TranscribeStreamEvents>(ev: K, fn: TranscribeStreamEvents[K]): this;
  [Symbol.asyncIterator](): AsyncIterator<TranscribeStreamItem>;
}
function transcribeStream(opts: TranscribeStreamOptions & { apiKey: string; apiUrl?: string }): TranscribeStream;   // Node only (ws)
```

`pc.audio.transcribe(input, opts)` and `pc.audio.transcribeStream(opts)` are the
same two functions bound to the client's `apiKey` / `apiUrl`.

---

## Shape compatibility

The binary mode is deliberately the shape of OpenAI's `POST /v1/audio/speech`
(`input`, `voice`, `model`, `response_format`, `speed`; the body is the audio), so
an OpenAI-dialect client pointed at `https://voice.pinecall.io/v1` with a Pinecall
key and a Pinecall voice works for that mode. `language`, `sample_rate` and
`timestamps` are Pinecall additions. See the
[guide](/guides/text-to-speech#raw-http-any-language) for the `curl` and
`openai` examples.

`POST /v1/audio/transcriptions` is likewise the shape of OpenAI's
`POST /v1/audio/transcriptions` (multipart `file`, `model`, `language`,
`response_format` = `json` | `verbose_json` | `text`), so `audio.transcriptions.create`
works for batch when pointed at the same base URL. `diarize` and the `speaker`
labels are Pinecall additions; the live WebSocket has no OpenAI counterpart. See
the [guide](/guides/speech-to-text#raw-http-any-language).

# Vercel AI SDK — UI message stream protocol + `useChat` resume

Research note for the *Streaming research* milestone (card tk-041797). Read-only;
every claim below cites a file in `~/research/ai` (shallow clone of
`vercel/ai`, HEAD `9d9a73f` "Version Packages (#19317)", 2026-08-23,
`packages/ai` at version **7.0.77**). Line numbers are from that checkout.

**What is open source and what is not.** Everything in `vercel/ai` is OSS and
was read directly: the chunk union, the SSE framing, the reducer, the `Chat`
class, the React hook, the Next.js examples and the docs under `content/`.
The *resume* story depends on a second package, **`resumable-stream`**
(github.com/vercel/resumable-stream, MIT). It is **not** in `~/research`; I
unpacked `resumable-stream@2.2.12` from npm (the exact version pinned by
`examples/next/package.json:19`) into the session scratchpad and read its
`dist/runtime.js`. Citations to it are marked **[rs]** and are from the
published build, not a repo clone. Redis itself and Vercel's `after()` runtime
are not read; anything about them is marked *inferred*.

---

## 1. The chunk catalogue (`ui-message-chunks.ts`)

One file defines the wire vocabulary twice: a Zod union used to **validate
inbound** chunks on the client (`uiMessageChunkSchema`, lines 23-218) and the
TypeScript union (`UIMessageChunk`, lines 229-407). They are kept in sync by
hand. The TypeScript union, quoted whole
(`packages/ai/src/ui-message-stream/ui-message-chunks.ts:229-407`):

```ts
export type UIMessageChunk<
  METADATA = unknown,
  DATA_TYPES extends UIDataTypes = UIDataTypes,
> =
  | { type: 'text-start'; id: string; providerMetadata?: ProviderMetadata; }
  | { type: 'text-delta'; delta: string; id: string; providerMetadata?: ProviderMetadata; }
  | { type: 'text-end'; id: string; providerMetadata?: ProviderMetadata; }
  | { type: 'reasoning-start'; id: string; providerMetadata?: ProviderMetadata; }
  | { type: 'reasoning-delta'; id: string; delta: string; providerMetadata?: ProviderMetadata; }
  | { type: 'reasoning-end'; id: string; providerMetadata?: ProviderMetadata; }
  | { type: 'custom'; kind: `${string}.${string}`; providerMetadata?: ProviderMetadata; }
  | { type: 'error'; errorText: string; }
  | { type: 'tool-input-available'; toolCallId: string; toolName: string; input: unknown;
      providerExecuted?: boolean; providerMetadata?: ProviderMetadata;
      toolMetadata?: JSONObject; dynamic?: boolean; title?: string; }
  | { type: 'tool-input-error'; toolCallId: string; toolName: string; input: unknown;
      providerExecuted?: boolean; providerMetadata?: ProviderMetadata;
      toolMetadata?: JSONObject; dynamic?: boolean; errorText: string; title?: string; }
  | { type: 'tool-approval-request'; approvalId: string; toolCallId: string;
      isAutomatic?: boolean; signature?: string; }
  | { type: 'tool-approval-response'; approvalId: string; approved: boolean; reason?: string;
      providerExecuted?: boolean; providerMetadata?: ProviderMetadata; }
  | { type: 'tool-output-available'; toolCallId: string; output: unknown;
      providerExecuted?: boolean; providerMetadata?: ProviderMetadata;
      toolMetadata?: JSONObject; dynamic?: boolean; preliminary?: boolean; }
  | { type: 'tool-output-error'; toolCallId: string; errorText: string;
      providerExecuted?: boolean; providerMetadata?: ProviderMetadata;
      toolMetadata?: JSONObject; dynamic?: boolean; }
  | { type: 'tool-output-denied'; toolCallId: string; }
  | { type: 'tool-input-start'; toolCallId: string; toolName: string;
      providerExecuted?: boolean; providerMetadata?: ProviderMetadata;
      toolMetadata?: JSONObject; dynamic?: boolean; title?: string; }
  | { type: 'tool-input-delta'; toolCallId: string; inputTextDelta: string; }
  | { type: 'source-url'; sourceId: string; url: string; title?: string;
      providerMetadata?: ProviderMetadata; }
  | { type: 'source-document'; sourceId: string; mediaType: string; title: string;
      filename?: string; providerMetadata?: ProviderMetadata; }
  | { type: 'file'; url: string; mediaType: string; providerMetadata?: ProviderMetadata; }
  | { type: 'reasoning-file'; url: string; mediaType: string; providerMetadata?: ProviderMetadata; }
  | DataUIMessageChunk<DATA_TYPES>
  | { type: 'start-step'; }
  | { type: 'finish-step'; }
  | { /** Removes all message parts added during the current step. */ type: 'reset-step'; }
  | { type: 'start'; messageId?: string; messageMetadata?: METADATA; }
  | { type: 'finish'; finishReason?: FinishReason; messageMetadata?: METADATA; }
  | { type: 'abort'; reason?: string; }
  | { type: 'message-metadata'; messageMetadata: METADATA; };
```

The `data-*` member is generic over the app's declared data types
(`ui-message-chunks.ts:220-227`):

```ts
export type DataUIMessageChunk<DATA_TYPES extends UIDataTypes> = ValueOf<{
  [NAME in keyof DATA_TYPES & string]: {
    type: `data-${NAME}`;
    id?: string;
    data: DATA_TYPES[NAME];
    transient?: boolean;
  };
}>;
```

On the wire the Zod side accepts it by prefix only
(`ui-message-chunks.ts:170-179`):

```ts
z.looseObject({
  type: z.custom<`data-${string}`>(
    (value): value is `data-${string}` =>
      typeof value === 'string' && value.startsWith('data-'),
    { message: 'Type must start with "data-"' },
  ),
  id: z.string().optional(),
  data: z.unknown(),
  transient: z.boolean().optional(),
}),
```

and `finishReason` is a closed enum on the wire
(`ui-message-chunks.ts:196-205`): `'stop' | 'length' | 'content-filter' |
'tool-calls' | 'error' | 'other'`, optional.

Things worth registering about the catalogue:

- Every object is `z.looseObject` — **extra fields** on a known chunk pass
  validation, but an **unknown `type`** (other than `data-*`) **fails** the
  union and the transport throws (`packages/ai/src/ui/default-chat-transport.ts:26-33`:
  `if (!chunk.success) { throw chunk.error; }`). Forward compatibility exists
  only through the `data-*` escape hatch, not through "ignore unknown types".
- There is **no sequence number, no timestamp, no message-level id** on a chunk.
  Identity is per-*part*: `id` for text/reasoning/data parts, `toolCallId` for
  tool parts, `sourceId` for sources, `approvalId` for approvals. The only
  stream-level id is `start.messageId` (line 391-393).
- The spec asked for "tool-input-*", "tool-output-*": the full tool family in
  7.0.77 is `tool-input-start`, `tool-input-delta`, `tool-input-available`,
  `tool-input-error`, `tool-approval-request`, `tool-approval-response`,
  `tool-output-available`, `tool-output-error`, `tool-output-denied` — nine
  kinds, plus `dynamic: true` switching the reducer to a separate part type
  (see §3). `reset-step`, `custom`, `reasoning-file` are newer than the list
  in the card's spec and are included above.

## 2. SSE framing

**Writer** — the whole thing is eleven lines
(`packages/ai/src/ui-message-stream/json-to-sse-transform-stream.ts:6-17`):

```ts
export class JsonToSseTransformStream extends TransformStream<unknown, string> {
  constructor() {
    super({
      transform(part, controller) {
        controller.enqueue(`data: ${JSON.stringify(part)}\n\n`);
      },
      flush(controller) {
        controller.enqueue('data: [DONE]\n\n');
      },
    });
  }
}
```

So: one SSE event per chunk, **`data:` field only**. Verified: **no `id:`
field, no `event:` field, no `retry:`**, and no keep-alive comment lines are
ever written by this package. (`grep -rln "Last-Event-ID\|lastEventId"
packages/` hits only `packages/google/src/interactions/stream-google-interactions.ts`
and `packages/mcp/src/tool/mcp-http-transport.ts` — provider/MCP clients
consuming *other* servers' SSE, not the UI message stream.) The docs' sentence
"SSE format for improved standardization, keep-alive through ping, reconnect
capabilities" (`content/docs/04-ai-sdk-ui/50-stream-protocol.mdx:117`)
describes what SSE *can* do, not what this writer does.

**Headers** (`packages/ai/src/ui-message-stream/ui-message-stream-headers.ts:1-7`):

```ts
export const UI_MESSAGE_STREAM_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no', // disable nginx buffering
};
```

Applied by `createUIMessageStreamResponse`
(`create-ui-message-stream-response.ts:39-43`) and
`pipeUIMessageStreamToResponse` (`pipe-ui-message-stream-to-response.ts:43-51`).
The **client never checks** `x-vercel-ai-ui-message-stream` — `grep` across
`packages/ai/src/ui` and `packages/react` finds no reader of it; the docs tell
custom backends to set it (`50-stream-protocol.mdx:119-122`), but nothing
enforces it. It is a version marker for humans and proxies.

**Reader** (`packages/provider-utils/src/parse-json-event-stream.ts:11-33`):

```ts
export function parseJsonEventStream<T>({ stream, schema }) {
  return stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())
    .pipeThrough(
      new TransformStream<EventSourceMessage, ParseResult<T>>({
        async transform({ data }, controller) {
          // ignore the 'DONE' event that e.g. OpenAI sends:
          if (data === '[DONE]') {
            return;
          }
          controller.enqueue(await safeParseJSON({ text: data, schema }));
        },
      }),
    );
}
```

Only `data` is destructured from the parsed event; `id`/`event` are dropped
on the floor. `[DONE]` is **swallowed, not surfaced** — the client learns the
response is over from the HTTP body closing, not from `[DONE]`. Consequence
for semantics: `[DONE]` is transport punctuation; the *logical* end of a
message is the `finish` chunk (optional: `sendFinish = true` default in
`to-ui-message-stream.ts:27`, suppressed when `false` at
`to-ui-message-chunk.ts:358-361`). A server can legitimately end the HTTP
stream with no `finish` chunk at all (multi-step agents chain several
`streamText` calls into one response with `sendStart/sendFinish` false on the
inner ones), and the client's `status` still goes to `ready` because
`consumeStream` returned (`chat.ts:796-823`).

**Ordering / batching:** none. One JSON object per event, in write order;
there is no `[...]` batch frame. `createUIMessageStream`'s `merge()` interleaves
several producer streams into one by racing reads
(`create-ui-message-stream.ts:96-112`) — order across merged streams is
arrival order.

## 3. The reducer: chunks → `UIMessage.parts`

`processUIMessageStream` (`packages/ai/src/ui/process-ui-message-stream.ts:82-1009`)
is a `TransformStream` that mutates a `StreamingUIMessageState` in place and
re-emits every chunk unchanged (`:1004` `controller.enqueue(chunk)`) — so the
same function is used on the **client** (in `Chat.makeRequest`,
`chat.ts:796-812`) and on the **server** (inside `handleUIMessageStreamFinish`,
`handle-ui-message-stream-finish.ts:163-167`, to build the message handed to
`onEnd`/`onStepEnd`). The state (`process-ui-message-stream.ts:34-50`):

```ts
export type StreamingUIMessageState<UI_MESSAGE extends UIMessage> = {
  message: UI_MESSAGE;
  activeTextParts: Record<string, TextUIPart>;
  activeReasoningParts: Record<string, ReasoningUIPart>;
  partialToolCalls: Record<string, { text: string; index: number; toolName: string;
                                     dynamic?: boolean; title?: string; toolMetadata?: JSONObject; }>;
  finishReason?: FinishReason;
};
```

Every mutation ends with `write()`; on the client `write` is the only place
React state changes (`chat.ts:772-792`: `setStatus('streaming')`, then
`replaceMessage` if the in-flight message id equals the last message's id,
else `pushMessage`). Throttling is applied **outside** the reducer, on the
subscription: `useChat({ throttle })` →
`chat['~registerMessagesCallback'](updateMessages, throttleWaitMs)`
(`packages/react/src/use-chat.ts:161-164`) → `throttleit` wraps the callback
(`packages/react/src/chat.react.ts:111-122`, `packages/react/src/throttle.ts:3-8`).
The reducer always runs at wire speed; only the notification is throttled,
and `undefined` means no throttle (`use-chat.ts:48-52`).

### 3.1 Text and reasoning — start/delta/end keyed by `id`

`text-start` creates `{type:'text', text:'', state:'streaming'}` and parks it
in `activeTextParts[chunk.id]` (`:427-438`); `text-delta` appends to that part
(`:440-456`) and **throws `UIMessageStreamError`** if the id is unknown
(`:442-450` "Ensure a \"text-start\" chunk is sent before any \"text-delta\"
chunks"); `text-end` flips `state:'done'` and deletes the active entry
(`:458-475`). Reasoning is identical (`:488-538`). `finish-step` drops all
active text/reasoning maps without touching parts (`:883-888`) — the next
step's text becomes a *new* part. There is no "replace the whole text"
chunk; the wire is delta-only.

### 3.2 Tool parts — the state machine

The part type is `ToolUIPart` = `{ type: \`tool-${NAME}\` } & UIToolInvocation`
(`packages/ai/src/ui/ui-messages.ts:389-393`), and the states are the
discriminated union at `ui-messages.ts:296-387`:

```
input-streaming → input-available → (approval-requested → approval-responded →)
               → output-available | output-error | output-denied
```

with `input` typed `DeepPartial` while streaming (`ui-messages.ts:298-299`) and
`preliminary?: boolean` on `output-available` (`:348`) for streaming tool
results. How chunks drive it, in `process-ui-message-stream.ts`:

| chunk | lines | effect |
|---|---|---|
| `tool-input-start` | 582-622 | records `partialToolCalls[toolCallId] = {text:'', index, toolName, …}`; `updateToolPart({state:'input-streaming', input: undefined})` → **pushes** a new part (`:262-288`) |
| `tool-input-delta` | 624-664 | appends `inputTextDelta` to the buffered text, `parsePartialJson` (`:638`), `updateToolPart({state:'input-streaming', input: partialArgs})` → **in-place update** (`:227-260`) |
| `tool-input-available` | 666-703 | `state:'input-available'`, full `input`; then `await onToolCall(...)` (blocking, skipped when `providerExecuted`, `:693-701`) |
| `tool-input-error` | 705-744 | `state:'output-error'` with `rawInput` (skips the output phase entirely) |
| `tool-approval-request` | 746-758 | `getToolInvocation(toolCallId)` (throws if absent, `:148-154`), `state:'approval-requested'`, `approval:{id,…}` |
| `tool-approval-response` | 760-787 | looked up **by approvalId** (`:159-175`), `state:'approval-responded'` |
| `tool-output-denied` | 789-794 | `state:'output-denied'` |
| `tool-output-available` | 796-835 | `getToolInvocation` then `updateToolPart({state:'output-available', input: <kept>, output, preliminary})` |
| `tool-output-error` | 837-875 | `state:'output-error'`, `errorText`, `input`/`rawInput` kept |

The upsert itself (`:216-222`, `:227-233`) — find by `toolCallId` **within the
current step** (`getCurrentStepParts`, `:111-123`, scans back to the last
`step-start` part), else push:

```ts
const part =
  existingPart ??
  (getCurrentStepParts().find(
    part => isStaticToolUIPart(part) && part.toolCallId === options.toolCallId,
  ) as ToolUIPart<InferUIMessageTools<UI_MESSAGE>> | undefined);
...
if (part != null) {
  part.state = options.state;
  anyPart.input = anyOptions.input;
  anyPart.output = anyOptions.output;
  anyPart.errorText = anyOptions.errorText;
  anyPart.rawInput = anyOptions.rawInput;
  anyPart.preliminary = anyOptions.preliminary;
```

Note it is a **full overwrite of the state fields** on every transition, not a
merge — an `output-available` that arrives without `input` clears `input`
unless the caller passes it back (which every call site does, e.g. `:821`
`input: (toolInvocation as any).input`). Output chunks (`tool-output-*`,
approvals) look the part up across the **whole message** if it is not in the
current step (`:136-146`), so a tool started in step 1 can resolve in step 2.
`dynamic: true` routes to `updateDynamicToolPart` (`:292-401`) producing
`{type:'dynamic-tool', toolName, …}` instead of `tool-${name}`; the reducer
honours the *existing* part's kind on `tool-input-error` to avoid duplicates
(`:705-716`).

**Order dependence:** `tool-output-available` for an unknown `toolCallId`
**throws** (`:148-154`). The stream is assumed complete and ordered; there is
no "I missed the start, synthesise a part" path. Same for `text-delta` without
`text-start`. This matters for any resume that does not replay from the top
(see §4).

### 3.3 `data-*` parts — upsert by `(type, id)`, transient vs persistent

The `default:` arm (`process-ui-message-stream.ts:944-1001`), quoted:

```ts
default: {
  if (isDataUIMessageChunk(chunk)) {
    // validate data chunk if dataPartSchemas is provided
    if (dataPartSchemas?.[chunk.type] != null) { ... await validateTypes({...}) }

    const dataChunk = chunk as DataUIMessageChunk<InferUIMessageData<UI_MESSAGE>>;

    // transient parts are not added to the message state
    if (dataChunk.transient) {
      onData?.(dataChunk);
      break;
    }

    const existingUIPart =
      dataChunk.id != null
        ? (state.message.parts.find(
            chunkArg =>
              dataChunk.type === chunkArg.type &&
              dataChunk.id === chunkArg.id,
          ) as DataUIPart<InferUIMessageData<UI_MESSAGE>> | undefined)
        : undefined;

    if (existingUIPart != null) {
      existingUIPart.data = dataChunk.data;
    } else {
      state.message.parts.push(dataChunk);
    }

    onData?.(dataChunk);
    write();
  }
}
```

Three rules fall out:

1. **Persistent, no id** → always appended (one part per chunk).
2. **Persistent, with id** → find `(type, id)` across the **whole message**
   (not just the current step), **replace `data` wholesale** — no merge, no
   patch. Position in `parts` is where it first appeared. The stored part is
   the chunk object itself (`:994`), so it keeps `id` and loses nothing.
3. **`transient: true`** → never enters `parts`; only `onData` sees it
   (`:975-978`). The docs are explicit that transient parts "are **only**
   available through the `onData` callback"
   (`content/docs/04-ai-sdk-ui/20-streaming-data.mdx:225`).

`onData` fires for **every** data chunk, transient or not (`:976`, `:997`).
`reset-step` (`:890-905`) splices away all parts since the last `step-start`,
including data parts, and resets the active maps.

Also relevant: `message-metadata` / `start.messageMetadata` /
`finish.messageMetadata` are **deep-merged** into `message.metadata`
(`:403-424`, `mergeObjects`) — metadata is the one thing that merges rather
than replaces.

### 3.4 `start` / `finish` / `abort` / `error`

- `start` (`:907-918`): takes `messageId` if present, merges metadata, and
  `write({updateStatus:false})` so status does not flip to `streaming` on a
  bare `start`.
- `finish` (`:920-929`): stores `finishReason`, merges metadata. It does **not**
  close anything — the stream may continue (multi-step).
- `abort`: the reducer has **no case for it** — it falls to `default`, is not a
  data chunk, so nothing happens in the reducer; it is re-emitted and the
  server-side wrapper flags `isAborted` (`handle-ui-message-stream-finish.ts:86-88`)
  for `onEnd({isAborted})` (`:128-137`).
- `error` (`:939-942`): `onError(new Error(chunk.errorText))` — on the client
  that callback `throw`s (`chat.ts:804-806`), so one `error` chunk aborts the
  whole read, sets `status:'error'`, and the partial message stays as is
  (`chat.ts:824-853`).

## 4. Resume, traced end to end

### 4.1 Client: `useChat({ resume: true })`

`packages/react/src/use-chat.ts:233-237`:

```ts
useEffect(() => {
  if (resume) {
    chatRef.current.resumeStream();
  }
}, [resume, chatRef]);
```

That is the entirety of the hook's involvement: **one attempt on mount**
(and whenever `resume` flips or the `Chat` instance is recreated — which
happens when `id` changes, `use-chat.ts:128-136`). There is no retry, no
backoff, no reconnect on `visibilitychange`, and **no reconnect after a
mid-stream drop**: a network error during a normal `sendMessage` lands in
`status:'error'` with `isDisconnect: true` in `onFinish`
(`chat.ts:840-847`, `:857-864`) and the app must call `resumeStream()` itself.

`Chat.resumeStream` (`packages/ai/src/ui/chat.ts:482-484`) is
`makeRequest({trigger:'resume-stream'})`. In `makeRequest` (`:657-710`):

```ts
if (trigger === 'resume-stream') {
  try {
    const reconnect = await this.transport.reconnectToStream({
      chatId: this.id, abortSignal: abortController.signal, metadata, headers, body,
    });
    ...
    if (reconnect == null) {
      this.setStatus({ status: 'ready' });
      clearActiveResumeRequest();
      return; // no active stream found, so we do not resume
    }
    resumeStream = reconnect;
```

Overlapping resumes: a new `resume-stream` aborts the previous one's
controller (`:642-645`) and only the latest is allowed to mutate state
(`isCurrentRequest`, `:647-649`; tested at `chat.test.ts:1111`).

Then the resumed stream is fed to the **same** `processUIMessageStream` with a
**fresh** state (`:722-729`):

```ts
state: createStreamingUIMessageState({
  lastMessage:
    trigger === 'resume-stream' || trigger === 'regenerate-message'
      ? undefined
      : this.state.snapshot(lastMessage),
  messageId: this.generateId(),
}),
```

i.e. the client does **not** continue a half-built assistant message; it
rebuilds it from whatever the resumed stream contains. It lands in the right
slot only because the replayed `start` chunk carries `messageId` and `write`
does `replaceMessage` when `response.state.message.id === this.lastMessage?.id`
(`:781-791`) — so a page that loaded a persisted partial assistant message
with that id gets it overwritten by the replay. If the server's replay does
**not** start from the top, the reducer throws on the first `text-delta`
(§3.1) — this is why the design below replays the whole stream.

### 4.2 Transport: `GET {api}/{chatId}/stream`

`ChatTransport.reconnectToStream` contract (`packages/ai/src/ui/chat-transport.ts:58-85`):
returns `ReadableStream<UIMessageChunk>` "if an active stream is found",
`null` "if no active stream exists … (e.g., response already completed)".
`HttpChatTransport.reconnectToStream` (`http-chat-transport.ts:215-269`):

```ts
const api = preparedRequest?.api ?? `${this.api}/${options.chatId}/stream`;
...
const response = await fetch(api, { method: 'GET', headers, credentials, signal: options.abortSignal });

// no active stream found, so we do not resume
if (response.status === 204) {
  return null;
}
```

Plain `GET`, **no cursor of any kind** in URL, headers or body — no
`Last-Event-ID`, no offset, no "parts I already have". `prepareReconnectToStreamRequest`
lets the app change the URL/headers (`:227-235`), still with no cursor
argument available to it. The response body goes through the same
`processResponseStream` (SSE → JSON → Zod) as a fresh `POST`.

### 4.3 Server: `POST /api/chat` + `consumeSseStream` + `resumable-stream`

The reference wiring is `examples/next/app/api/chat/route.ts:83-107`:

```ts
return createUIMessageStreamResponse({
  stream: toUIMessageStream({
    stream: result.stream,
    originalMessages: messages,
    generateMessageId: generateId,
    ...
    onFinish: ({ messages }) => {
      saveChat({ id, messages, activeStreamId: null });
    },
  }),
  async consumeSseStream({ stream }) {
    const streamId = generateId();

    // send the sse stream into a resumable stream sink as well:
    const streamContext = createResumableStreamContext({ waitUntil: after });
    await streamContext.createNewResumableStream(streamId, () => stream);

    // update the chat with the streamId
    saveChat({ id, activeStreamId: streamId });
  },
});
```

and the resume route `examples/next/app/api/chat/[id]/stream/route.ts:6-27`:

```ts
const chat = await readChat(id);
if (chat.activeStreamId == null) {
  // no content response when there is no active stream
  return new Response(null, { status: 204 });
}
const streamContext = createResumableStreamContext({ waitUntil: after });
return new Response(
  await streamContext.resumeExistingStream(chat.activeStreamId),
  { headers: UI_MESSAGE_STREAM_HEADERS },
);
```

`consumeSseStream` is a **tee of the already-SSE-encoded text**
(`create-ui-message-stream-response.ts:28-37`):

```ts
let sseStream = stream.pipeThrough(new JsonToSseTransformStream());
if (consumeSseStream) {
  const [stream1, stream2] = sseStream.tee();
  sseStream = stream1;
  consumeSseStream({ stream: stream2 }); // no await (do not block the response)
}
```

So what the resume layer sees is **strings of `data: {...}\n\n`**, not chunks —
`resumable-stream` is typed `ReadableStream<string>` throughout
(**[rs]** `dist/types.d.ts:38,47,56`).

**What `resumable-stream` actually does** (**[rs]** `dist/runtime.js`, v2.2.12):

- `createNewResumableStream` sets a Redis key
  `"${keyPrefix}:sentinel:${streamId}" = "1"` with `EX: 24*60*60`
  (`runtime.js:39-41`), then builds a `ReadableStream` whose `start()` **eagerly
  reads the source to completion** regardless of whether anyone reads the
  returned stream (`:98-146` — the `read()` loop; `controller.enqueue` failures
  are swallowed at `:129-135` "If we cannot enqueue, the stream is already
  closed, but we WANT to continue"). Every chunk is pushed to an **in-process
  array** `const chunks = []` (`:75`, `:128`) and published to every currently
  attached listener channel (`:136-141`). Completion sets the sentinel to
  `"DONE"` (`:115-117`), publishes a `DONE_MESSAGE` string to listeners
  (`:119-122`) and resolves the `waitUntil` promise (`:78-80`, `:124`).
- `resumeExistingStream` reads the sentinel (`:64-71`): missing → `undefined`,
  `"DONE"` → `null` (the example turns both into `204`), otherwise
  `resumeStream(ctx, streamId, skipCharacters)`.
- `resumeStream` (`:168-234`) subscribes to a fresh
  `chunk:${listenerId}` channel and publishes `{listenerId, skipCharacters}`
  on `request:${streamId}` (`:223-226`). The **producer process** — still
  alive because of `waitUntil` — answers by publishing
  `chunks.join("").slice(parsedMessage.skipCharacters || 0)` as one message
  (`:84-97`), then forwards live chunks. If nobody answers within **1000 ms**
  the resume fails with `"Timeout waiting for ack"` (`:179-189`).

Consequences, all verified in that file:

1. **The buffer is not in Redis.** Redis holds a 24 h sentinel and acts as a
   pub/sub bus; the replay buffer lives in the memory of the function
   invocation that started the generation. If that process is gone (cold
   serverless instance reaped, deploy, crash, `waitUntil` not honoured), the
   sentinel still says `"1"`, `resumeExistingStream` returns a stream, and the
   client gets a 1 s timeout error instead of a 204. The AI SDK docs say
   "Redis to store the UIMessage stream" (`03-chatbot-resume-streams.mdx:34`)
   — that is loose; what is stored is the *existence* of the stream. *Inferred*
   (cannot read Vercel's `after()`): the design assumes the platform keeps the
   invocation alive until the `waitUntil` promise resolves.
2. **Replay is always from the top** in the AI SDK path: `skipCharacters`
   exists in the library but `HttpChatTransport.reconnectToStream` never sends
   one, and the route never passes one. The cursor the library *does* offer is
   a **character offset into the SSE text**, not an event index — a client
   would have to count bytes of `data:` lines it had consumed.
3. **Finished streams are not resumable.** Sentinel `"DONE"` → `null` → 204.
   After completion the app is expected to have persisted the final `UIMessage`
   (`onFinish → saveChat`, `route.ts:93-95`) and to load it as `messages` on
   the next page render; "history" and "live" are two different mechanisms.
4. **Multiple listeners are fine** (each gets its own channel, `:84-97`);
   the docs say so (`03-chatbot-resume-streams.mdx:400`).
5. The 24 h TTL is the only GC; `activeStreamId` in the app's DB must be
   cleared on finish (`route.ts:94`) or on the next `POST` (`route.ts:63`),
   otherwise the next page load resumes a stale id (docs call this out at
   `03-chatbot-resume-streams.mdx:403`).

### 4.4 Keeping the generation alive on disconnect: `consumeStream` / `onFinish`

Two distinct mechanisms:

- **`consumeSseStream: consumeStream`** (`content/docs/06-advanced/02-stopping-streams.mdx:165-206`).
  Because `createUIMessageStreamResponse` **tees**, the second branch must be
  drained or backpressure stalls the first. `consumeStream`
  (`packages/ai/src/util/consume-stream.ts:13-44`) just reads to exhaustion
  (`while (true) { const { done } = await reader.read(); if (done) break; }`).
  Passing it as `consumeSseStream` means the generation is pulled to its end
  even after the client's branch is cancelled → `onEnd`/`onFinish` fires with
  the complete message and `isAborted` set correctly. `streamText`'s own
  `result.consumeStream()` (`generate-text/stream-text.ts:2767-2780`,
  documented at `stream-text-result.ts:352-360` "effectively removes the
  backpressure and allows the stream to finish, triggering the `onEnd`
  callback") is the same idea one layer down.
- **`resumable-stream`'s eager `read()` loop** (§4.3) does the same draining
  *and* buffers — so in the resume setup `consumeSseStream` is the resumable
  sink, not `consumeStream`.

Either way the rule the docs now state in bold is: **client-side abort is a
disconnect, not a cancel** (`content/docs/09-troubleshooting/15-abort-breaks-resumable-streams.mdx:10-12`,
`03-chatbot-resume-streams.mdx:10-19`). `useChat().stop()` aborts the fetch
(`chat.ts:605-611`) — nothing reaches the server; real cancellation needs a
separate endpoint that writes a flag the producer polls (`examples/next/app/api/chat/route.ts:65-81`
polls `canceledAt` once per second via `throttle(onChunk)`, and the `DELETE`
at `[id]/stream/route.ts:30-43` sets it).

`onFinish` on the **server** (`handleUIMessageStreamFinish`,
`handle-ui-message-stream-finish.ts:121-138`) receives
`{isAborted, isContinuation, responseMessage, messages, finishReason}` and is
called from both `flush()` and `cancel()` of the final transform
(`:180-187`) — so it runs on client cancel too, as long as something drains
the stream. The server-side `onFinish` is where the final message is
persisted; there is no server-held log to read back.

### 4.5 What is NOT resumable (summary)

- A stream whose producer invocation died (timeout error, not 204).
- A finished stream (204 — history comes from the app's DB, a different path).
- A *partial* resume: no event cursor on the AI SDK side; `skipCharacters` is
  byte-offset and unused by `useChat`.
- Anything the tee did not see: `transient` data chunks **are** in the SSE
  text and are replayed, but the reducer still drops them from `parts` — so a
  reconnecting client re-fires `onData` for every transient chunk since the
  start of the message (no dedupe key exists for them).
- A mid-stream network drop in a normal (non-resume-flag) session — no
  automatic reconnect; the hook surfaces `isDisconnect` and stops.

## 5. Client ergonomics worth noting

- `status: 'submitted' | 'streaming' | 'ready' | 'error'` (`chat.ts:132`);
  `resume-stream` deliberately checks for an active stream **before** flipping
  to `submitted` "to avoid a brief flash" (`chat.ts:657-659`).
- `onFinish({message, messages, isAbort, isDisconnect, isError, finishReason})`
  (`chat.ts:178-185`) — the disconnect/abort/error trichotomy is a good shape.
- `onData(dataPart)` (`chat.ts:163-165`) is the side channel for transient
  parts; `dataPartSchemas` validates `data-*` payloads per type at the reducer
  (`process-ui-message-stream.ts:946-967`).
- The React hook keeps callbacks in a `latestRef` so a long-lived `Chat`
  sees fresh closures (`use-chat.ts:74-122`), recreates `Chat` only when `id`
  changes (`:128-136`), and uses `useSyncExternalStore` with a cached snapshot
  ref (`:139-188`) — the same discipline as `@pinecall/web/log/react`.

---

## For Pinecall

Counterparts named: the WS attach handler is
`sdk-server/src/pinecall/server/handlers/calls_api.py:739` (`attach`) with
`_attach_backlog` at `:664` and the `log.gap`/`log.caught_up` markers at
`:329`/`:658`; the browser side is `webrtc/src/log/transport.ts` (`tail`
`:206-341`, `poll` `:355-421`, `observe` `:435-518`), `webrtc/src/log/react.tsx`
(`useCall` `:56-101`, `useAgentCalls` `:122-170`) and the reducer vendored in
`webrtc/src/log/vendor/view.ts`; the envelope is `sdk/docs/guides/call-log.md`
("The entry envelope").

1. **`data-*` upsert-by-`(type,id)` is the right shape for `call.log()` custom
   entries — but only half of it transfers.** Vercel's rule is: `id` absent →
   append; `id` present → find `(type,id)` anywhere in the message and
   **replace `data` wholesale**; `transient:true` → never stored, callback
   only (`process-ui-message-stream.ts:974-999`). For Pinecall the *wire* must
   stay append-only — every custom entry gets its own `seq` — and the upsert
   belongs in the **reducer projection** (`CallLogView`), exactly where Vercel
   puts it. Concretely: a `call.log` entry of `{ kind, id?, data }` is appended
   to the log; `CallLogView` keeps `state.custom` as an ordered map keyed by
   `kind + "/" + id` (id-less entries get their `seq` as id), replacing `data`
   on a repeat. Replay/late-join then converges automatically because the
   replay *is* the same sequence of upserts — something Vercel gets only by
   replaying from byte 0.

2. **Map `transient` onto our existing `ephemeral` flag rather than inventing a
   third concept.** Vercel's transient = "reaches `onData`, not `parts`"; ours
   = "a late reader may skip it, the durable entry follows". They are the same
   intent (progress ticks, spinners) and our flag already has server-side
   meaning for backlog replay. `call.log(kind, data, { ephemeral: true })`
   should therefore (a) still get a `seq`, (b) be skippable by `_attach_backlog`
   like other ephemeral entries, (c) reach an `onEntry`/`onCustom` callback on
   `useCall` but not `state.custom`. Do **not** copy Vercel's "transient parts
   are re-fired on every resume with no dedupe key" — ours are deduped by
   `seq` for free.

3. **Keep `data` replacement wholesale, not merged.** Vercel merges only
   `messageMetadata` (`mergeObjects`, `:403-424`) and replaces everything else.
   A replace rule is what makes "the latest entry wins" provable on resume;
   a merge rule makes the final state depend on which entries were skipped.
   If a producer wants a patch it sends the full new value.

4. **`[DONE]` is nothing; `finish` is not the end either — `call.summary`
   is strictly stronger, keep it.** `[DONE]` is swallowed by the parser
   (`parse-json-event-stream.ts:24-27`) and the client reads "over" from the
   HTTP body closing; `finish` is optional (`sendFinish`) and a stream may
   carry several. Our guarantee "`call.summary` is always the last entry;
   seeing it means the log is complete and sealed" (call-log.md) is a
   *logical* terminator carried in-band with a `seq`, which survives transport
   changes (WS → poll) and late reads. For the SSE attach, do **not** emit a
   `[DONE]` frame as the completion signal; end the body after `call.summary`
   (and for an agent log, never). If a sentinel is wanted for proxies, it is
   decoration, not semantics.

5. **What their resume lacks that our `seq` cursor has — this is the headline
   comparison.** Vercel: no cursor on the client (`http-chat-transport.ts:236-251`),
   replay from the top because the reducer throws on a mid-stream `text-delta`
   (`process-ui-message-stream.ts:442-450`), buffer held in the *producer
   process's memory* with Redis as a pub/sub bus and a 24 h sentinel
   (**[rs]** `runtime.js:39-41, 75, 84-97`), a 1 s "Timeout waiting for ack"
   when that process is gone (`:179-189`), a *character* offset as the only
   partial-resume primitive and nothing sends it, finished streams are 204 and
   history is a different store. Ours: `after=<seq>` on the same URL for live,
   late, reconnect and history; idempotent apply (`view.apply` dedupes by
   `seq`); `log.gap` + snapshot when the hot buffer moved on; transport
   plurality with one reducer. The SSE attach should therefore expose the
   cursor **both** as `?after=` and as `Last-Event-ID` (set `id: <seq>` on
   every frame) so `EventSource`'s native reconnect carries it for free —
   something Vercel explicitly does not do (`json-to-sse-transform-stream.ts:10`
   writes `data:` only). That makes a bare `new EventSource(url)` a correct
   resuming client with zero JS, which `useChat` cannot claim.

6. **Copy the "abort is a disconnect, not a cancel" doctrine and its two
   mechanisms.** (a) Server: the generation must not be coupled to the
   observer's socket — in Pinecall that is already structural ("observers never
   slow the call", `slow_consumer` close in call-log.md), so the `tee +
   consumeStream` trick is unnecessary; note it as a non-goal. (b) Client: a
   supervise verb (`end`, `takeover`) is the explicit cancel; `close()` on a
   `tail` must never send one. `transport.ts:252-259` (`stop`) already has this split;
   keep it when adding an SSE pipe.

7. **Reconnect ergonomics: we are ahead, keep it, and steal `throttle` and
   `onFinish`'s trichotomy.** `useChat({resume:true})` is one attempt on mount
   (`use-chat.ts:233-237`) with no retry/backoff/visibility handling; `tail()`
   already has backoff-with-cap, `document.hidden` deferral and cursor-carrying
   resume (`transport.ts:266-278`). What to add: `useCall({ throttle })`
   implemented exactly like Vercel — wrap the **subscription callback**, never
   the reducer (`chat.react.ts:111-122`, `throttle.ts:3-8`), default
   `undefined` = off — and a `reconnectOnMount` flag whose meaning is "if the
   view is warm (`lastSeq > 0`) reopen from it", i.e. our `cursor(view,
   after)` default (`transport.ts:150-152`) made explicit. Also expose a
   terminal callback shaped like `onFinish({ isAbort, isDisconnect, isError })`
   (`chat.ts:178-185`) — `tail`'s `onClose({code, reason, willReconnect})` is
   close but does not say *why*.

8. **Do not copy "unknown type throws".** Vercel's Zod union rejects any chunk
   `type` it does not know (`default-chat-transport.ts:26-33`) except `data-*`.
   Our §1 forward-compat rule (unknown types ignored, `applyFrame` in
   `transport.ts:158-181`) is better for a log that outlives client versions;
   `call.log` custom entries ride under one known type (`call.log`) with
   `data.kind`, so they never hit the unknown path — the equivalent of
   Vercel's `data-*` prefix without a prefix.

9. **Tool state machine: our `tool.call` → `tool.result` pair is enough; skip
   the 9-state ladder but borrow `preliminary` and `output-error`.** Vercel
   needs `input-streaming`/`input-delta` because the LLM streams tool JSON to
   the browser; Pinecall tools run server-side and the observer sees them
   after the fact. Two small adoptions for `CallToolCall`: a `preliminary`
   boolean on `tool.result` for tools that stream partial results
   (`ui-messages.ts:348`), and an explicit error state (`errorText`) rather
   than overloading `result` (`ui-messages.ts:357-372`). Keep the lookup rule
   "result for an unknown call id" **lenient** (create a stub row) — Vercel
   throws (`process-ui-message-stream.ts:148-154`) because it can assume a
   from-the-top stream; we cannot after a `log.gap`.

10. **Server-side filters: no precedent here.** The UI message stream has no
    server-side filtering at all — `sendReasoning`/`sendSources`/`sendStart`/
    `sendFinish` (`to-ui-message-stream.ts:24-27`) are *producer* toggles, not
    per-subscriber filters, and the resume replay cannot filter because it is
    byte-level. Nothing to copy; design `?types=` / `?ephemeral=0` on
    `/v1/attach` from the LangGraph/AG-UI notes instead.

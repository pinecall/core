# AG-UI — events, encoders, state snapshot/delta, client runtime

Research note for the Streaming research milestone (card tk-4b4bab). Read-only
study of `~/research/ag-ui` at commit `821b8c2` (2026-08-22). Every claim below
cites a path and line range under `~/research/ag-ui/`; code is quoted verbatim.

**Path note.** The card spec says `typescript-sdk/packages/...`; in this clone
the TypeScript SDK lives at `sdks/typescript/packages/{core,encoder,proto,client}`
and the LangGraph bridge at `integrations/langgraph/{typescript,python}`. All
citations use the real paths.

**What is open source.** Everything cited here is in the public repo (MIT,
`LICENSE`): the spec (`docs/`), the TS/Python SDKs, and the LangGraph
integration. The thing the LangGraph integration talks TO — LangGraph Platform
(`client.runs.stream`, `client.threads.getState`) — is a hosted product whose
server is not in this repo; anything about its behaviour is marked *inferred
from client*. CopilotKit (the main AG-UI consumer, mentioned in the docs) is not
in this clone and is not described.

---

## 0. Shape of the protocol in one paragraph

AG-UI is a **run-scoped, request/response event stream**: the client POSTs a
`RunAgentInput` (thread id, run id, full message history, tools, context, state)
and the server answers with a stream of typed events that starts with
`RUN_STARTED` and ends with `RUN_FINISHED` or `RUN_ERROR`. State is carried by
`STATE_SNAPSHOT` (replace wholesale) and `STATE_DELTA` (JSON Patch). There is
**no sequence number, no cursor, no resume**: a dropped stream is recovered by
starting a new run, and the end-of-run `MESSAGES_SNAPSHOT` resynchronises the
client. The client runtime is an RxJS pipeline: `run()` → chunk expansion →
`verify` (ordering state machine) → `apply` (reducer with subscriber hooks) →
messages/state on the agent object.

---

## 1. Event catalogue (quoted from `@ag-ui/core`)

### 1.1 The enum and the base event

`sdks/typescript/packages/core/src/events.ts:13-62`:

```ts
export enum EventType {
  TEXT_MESSAGE_START = "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END = "TEXT_MESSAGE_END",
  TEXT_MESSAGE_CHUNK = "TEXT_MESSAGE_CHUNK",
  TOOL_CALL_START = "TOOL_CALL_START",
  TOOL_CALL_ARGS = "TOOL_CALL_ARGS",
  TOOL_CALL_END = "TOOL_CALL_END",
  TOOL_CALL_CHUNK = "TOOL_CALL_CHUNK",
  TOOL_CALL_RESULT = "TOOL_CALL_RESULT",
  /** @deprecated Use REASONING_START instead. Will be removed in 1.0.0. */
  THINKING_START = "THINKING_START",
  /** @deprecated ... */ THINKING_END = "THINKING_END",
  /** @deprecated ... */ THINKING_TEXT_MESSAGE_START = "THINKING_TEXT_MESSAGE_START",
  /** @deprecated ... */ THINKING_TEXT_MESSAGE_CONTENT = "THINKING_TEXT_MESSAGE_CONTENT",
  /** @deprecated ... */ THINKING_TEXT_MESSAGE_END = "THINKING_TEXT_MESSAGE_END",
  STATE_SNAPSHOT = "STATE_SNAPSHOT",
  STATE_DELTA = "STATE_DELTA",
  MESSAGES_SNAPSHOT = "MESSAGES_SNAPSHOT",
  ACTIVITY_SNAPSHOT = "ACTIVITY_SNAPSHOT",
  ACTIVITY_DELTA = "ACTIVITY_DELTA",
  RAW = "RAW",
  CUSTOM = "CUSTOM",
  RUN_STARTED = "RUN_STARTED",
  RUN_FINISHED = "RUN_FINISHED",
  RUN_ERROR = "RUN_ERROR",
  STEP_STARTED = "STEP_STARTED",
  STEP_FINISHED = "STEP_FINISHED",
  REASONING_START = "REASONING_START",
  REASONING_MESSAGE_START = "REASONING_MESSAGE_START",
  REASONING_MESSAGE_CONTENT = "REASONING_MESSAGE_CONTENT",
  REASONING_MESSAGE_END = "REASONING_MESSAGE_END",
  REASONING_MESSAGE_CHUNK = "REASONING_MESSAGE_CHUNK",
  REASONING_END = "REASONING_END",
  REASONING_ENCRYPTED_VALUE = "REASONING_ENCRYPTED_VALUE",
}
```

Every event extends one base (`events.ts:64-74`):

```ts
export const BaseEventSchema = z
  .object({
    type: z.nativeEnum(EventType),
    timestamp: z.number().optional(),
    rawEvent: z.any().optional(),
    metadata: OptionalMetadataSchema,
  })
  .passthrough();
```

`metadata` is `z.record(z.any()).optional()` (`core/src/metadata.ts:33,55`),
open by key with one reserved key `"ag-ui"` (`metadata.ts:11`); consumers merge
it into the message the event builds, last write wins, no recursion
(`metadata.ts:73-84`). Note what the base event does **not** have: no sequence
number, no run/thread id (only the lifecycle events carry those), no
per-event id. `.passthrough()` means unknown keys survive parsing.

The closed union is `EventSchemas = z.discriminatedUnion("type", [...])` at
`events.ts:361-395` (34 members), and `AGUIEvent = z.infer<typeof EventSchemas>`
(`events.ts:398`).

### 1.2 Lifecycle

`events.ts:230-236, 277-313`:

```ts
export const RunStartedEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RUN_STARTED),
  threadId: z.string(),
  runId: z.string(),
  parentRunId: z.string().optional(),
  input: RunAgentInputSchema.optional(),
});

export const RunFinishedEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RUN_FINISHED),
  threadId: z.string(),
  runId: z.string(),
  result: z.any().optional(),
  outcome: RunFinishedOutcomeSchema.nullable()
    .optional()
    .transform((v) => v ?? undefined),
  usage: z.array(TokenUsageSchema).optional(),
});

export const RunErrorEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RUN_ERROR),
  message: z.string(),
  code: z.string().optional(),
  usage: z.array(TokenUsageSchema).optional(),
});

export const StepStartedEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.STEP_STARTED),
  stepName: z.string(),
});

export const StepFinishedEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.STEP_FINISHED),
  stepName: z.string(),
});
```

`RunFinished.outcome` is a discriminated union `{type:"success"}` |
`{type:"interrupt", interrupts:[...min 1]}` (`events.ts:238-254`); the
`Interrupt` shape is `types.ts:206-214`, and a client resumes an interrupt by
sending `resume: ResumeEntry[]` in the NEXT `RunAgentInput`
(`types.ts:216-223, 239`). This "resume" is interrupt resolution, **not**
stream resumption — see §3.3.

### 1.3 Text messages

`events.ts:76-100`:

```ts
export const TextMessageStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TEXT_MESSAGE_START),
  messageId: z.string(),
  role: TextMessageRoleSchema.default("assistant"),
  name: z.string().optional(),
});

export const TextMessageContentEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TEXT_MESSAGE_CONTENT),
  messageId: z.string(),
  delta: z.string(),
});

export const TextMessageEndEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TEXT_MESSAGE_END),
  messageId: z.string(),
});

export const TextMessageChunkEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TEXT_MESSAGE_CHUNK),
  messageId: z.string().optional(),
  role: TextMessageRoleSchema.optional(),
  delta: z.string().optional(),
  name: z.string().optional(),
});
```

`TextMessageRoleSchema` is `developer | system | assistant | user`
(`events.ts:6-11`) — "any role except tool". `*_CHUNK` is a producer
convenience that the client expands into START/CONTENT/END (see §4.2).

### 1.4 Tool calls

`events.ts:126-171`:

```ts
export const ToolCallStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TOOL_CALL_START),
  toolCallId: z.string(),
  toolCallName: z.string(),
  parentMessageId: z.string().nullable().optional().transform((v) => v ?? undefined),
});

export const ToolCallArgsEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TOOL_CALL_ARGS),
  toolCallId: z.string(),
  delta: z.string(),
});

export const ToolCallEndEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TOOL_CALL_END),
  toolCallId: z.string(),
});

export const ToolCallResultEventSchema = BaseEventSchema.extend({
  messageId: z.string(),
  type: z.literal(EventType.TOOL_CALL_RESULT),
  toolCallId: z.string(),
  content: z.string(),
  role: z.literal("tool").optional(),
});

export const ToolCallChunkEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TOOL_CALL_CHUNK),
  toolCallId: z.string().optional(),
  toolCallName: z.string().optional(),
  parentMessageId: z.string().nullable().optional().transform((v) => v ?? undefined),
  delta: z.string().optional(),
});
```

Arguments are streamed as **string fragments of JSON** (`delta`), assembled by
the client (it uses `untruncate-json` to give subscribers partial args,
`client/src/apply/default.ts:49`). The result is a separate event carrying its
own `messageId` (it becomes a `role:"tool"` message, `types.ts:148-156`).

### 1.5 State

`events.ts:188-201`:

```ts
export const StateSnapshotEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.STATE_SNAPSHOT),
  snapshot: StateSchema,
});

export const StateDeltaEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.STATE_DELTA),
  delta: z.array(z.any()), // JSON Patch (RFC 6902)
});

export const MessagesSnapshotEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.MESSAGES_SNAPSHOT),
  messages: z.array(MessageSchema),
});
```

`StateSchema = z.any()` (`types.ts:242`) — state is opaque JSON. `MessageSchema`
is a `discriminatedUnion("role", ...)` over developer/system/assistant/user/
tool/activity/reasoning (`types.ts:174-182`).

### 1.6 Activity

`events.ts:203-216`:

```ts
export const ActivitySnapshotEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.ACTIVITY_SNAPSHOT),
  messageId: z.string(),
  activityType: z.string(),
  content: z.record(z.any()),
  replace: z.boolean().optional().default(true),
});

export const ActivityDeltaEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.ACTIVITY_DELTA),
  messageId: z.string(),
  activityType: z.string(),
  patch: z.array(z.any()),
});
```

An activity is a non-chat "progress card" that lives in the message list as a
`role:"activity"` message (`types.ts:158-164`); same snapshot/patch pattern as
state, scoped to one `messageId`.

### 1.7 Reasoning

`events.ts:315-359`:

```ts
export const ReasoningEncryptedValueSubtypeSchema = z.union([
  z.literal("tool-call"),
  z.literal("message"),
]);

export const ReasoningStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.REASONING_START),
  messageId: z.string(),
});

export const ReasoningMessageStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.REASONING_MESSAGE_START),
  messageId: z.string(),
  role: z.literal("reasoning"),
});

export const ReasoningMessageContentEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.REASONING_MESSAGE_CONTENT),
  messageId: z.string(),
  delta: z.string(),
});

export const ReasoningMessageEndEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.REASONING_MESSAGE_END),
  messageId: z.string(),
});

export const ReasoningMessageChunkEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.REASONING_MESSAGE_CHUNK),
  messageId: z.string().optional(),
  delta: z.string().optional(),
});

export const ReasoningEndEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.REASONING_END),
  messageId: z.string(),
});

export const ReasoningEncryptedValueEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.REASONING_ENCRYPTED_VALUE),
  subtype: ReasoningEncryptedValueSubtypeSchema,
  entityId: z.string(),
  encryptedValue: z.string(),
});
```

The five `THINKING_*` events (`events.ts:105-124, 176-186`) are the deprecated
predecessors; `BackwardCompatibility_0_0_45` middleware rewrites them
(`client/src/agent/agent.ts:119-124`).

### 1.8 Special

`events.ts:218-228`:

```ts
export const RawEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RAW),
  event: z.any(),
  source: z.string().optional(),
});

export const CustomEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.CUSTOM),
  name: z.string(),
  value: z.any(),
});
```

`RAW` is "the upstream framework's native event, untouched" (the LangGraph
bridge emits one per LangGraph chunk, §5). `CUSTOM` is the one extension point:
a name + any value, never verified (§4.3), never reduced (§4.4) — subscribers
only.

---

## 2. Transport: SSE, protobuf, Accept negotiation, WebSocket

### 2.1 Server side — `@ag-ui/encoder`

The whole encoder is 69 lines, `sdks/typescript/packages/encoder/src/encoder.ts`:

```ts
export class EventEncoder {
  private acceptsProtobuf: boolean;

  constructor(params?: EventEncoderParams) {
    this.acceptsProtobuf = params?.accept ? this.isProtobufAccepted(params.accept) : false;
  }

  getContentType(): string {
    if (this.acceptsProtobuf) {
      return proto.AGUI_MEDIA_TYPE;
    } else {
      return "text/event-stream";
    }
  }

  encode(event: BaseEvent): string {
    return this.encodeSSE(event);
  }

  encodeSSE(event: BaseEvent): string {
    return `data: ${JSON.stringify(event)}\n\n`;
  }

  encodeBinary(event: BaseEvent): Uint8Array {
    if (this.acceptsProtobuf) {
      return this.encodeProtobuf(event);
    } else {
      const sseString = this.encodeSSE(event);
      const encoder = new TextEncoder();
      return encoder.encode(sseString);
    }
  }

  encodeProtobuf(event: BaseEvent): Uint8Array {
    const messageBytes = proto.encode(event);
    const length = messageBytes.length;
    const buffer = new ArrayBuffer(4 + length);
    const dataView = new DataView(buffer);
    dataView.setUint32(0, length, false);   // big-endian
    const result = new Uint8Array(buffer);
    result.set(messageBytes, 4);
    return result;
  }

  private isProtobufAccepted(acceptHeader: string): boolean {
    const preferred = preferredMediaTypes(acceptHeader, [proto.AGUI_MEDIA_TYPE]);
    return preferred.includes(proto.AGUI_MEDIA_TYPE);
  }
}
```
(`encoder.ts:9-69`; comments elided.)

So the **SSE frame is exactly `data: <json>\n\n`** — one line, no `event:`
field, no `id:` field, no `retry:`. `preferredMediaTypes` is a vendored copy of
jshttp `negotiator` (`encoder/src/media-type.ts:1-41`), i.e. real RFC 7231
q-value negotiation against one provided type. `AGUI_MEDIA_TYPE =
"application/vnd.ag-ui.event+proto"` (`proto/src/index.ts:3`).

**Protobuf framing:** `[uint32 big-endian length][Event bytes]` per event
(`encoder.ts:43-60`). The `Event` message is a `oneof` (`proto/src/proto/events.proto:168-189`):

```proto
message Event {
  oneof event {
    TextMessageStartEvent text_message_start = 1;
    TextMessageContentEvent text_message_content = 2;
    TextMessageEndEvent text_message_end = 3;
    ToolCallStartEvent tool_call_start = 4;
    ToolCallArgsEvent tool_call_args = 5;
    ToolCallEndEvent tool_call_end = 6;
    StateSnapshotEvent state_snapshot = 7;
    StateDeltaEvent state_delta = 8;
    MessagesSnapshotEvent messages_snapshot = 9;
    RawEvent raw = 10;
    CustomEvent custom = 11;
    RunStartedEvent run_started = 12;
    RunFinishedEvent run_finished = 13;
    RunErrorEvent run_error = 14;
    StepStartedEvent step_started = 15;
    StepFinishedEvent step_finished = 16;
    TextMessageChunkEvent text_message_chunk = 17;
    ToolCallChunkEvent tool_call_chunk = 18;
  }
}
```

with `StateDeltaEvent.delta` a `repeated JsonPatchOperation`
(`events.proto:85-88`) and (`patch.proto:10-24`):

```proto
enum JsonPatchOperationType { ADD = 0; REMOVE = 1; REPLACE = 2; MOVE = 3; COPY = 4; TEST = 5; }

message JsonPatchOperation {
  JsonPatchOperationType op = 1;
  string path = 2;
  optional string from = 3;
  optional google.protobuf.Value value = 4;
}
```

**The binary transport covers a SUBSET of the catalogue.** The repo pins this in
a test, `proto/src/__tests__/metadata.test.ts:119-150`:

```ts
  const NOT_REPRESENTABLE = [
    EventType.TOOL_CALL_RESULT,
    EventType.ACTIVITY_SNAPSHOT,
    EventType.ACTIVITY_DELTA,
    EventType.REASONING_START,
    EventType.REASONING_MESSAGE_START,
    EventType.REASONING_MESSAGE_CONTENT,
    EventType.REASONING_MESSAGE_END,
    EventType.REASONING_MESSAGE_CHUNK,
    EventType.REASONING_END,
    EventType.REASONING_ENCRYPTED_VALUE,
    EventType.THINKING_START, ... EventType.THINKING_TEXT_MESSAGE_END,
  ];
  it.each(NOT_REPRESENTABLE)("%s does not cross the binary transport", (type) => {
    const bytes = encode({ type, metadata: { a: 1 } } as any);
    expect(bytes.length).toBe(0);
    expect(() => decode(bytes)).toThrow();
```

`proto.encode` validates against `EventSchemas` and on failure **warns and
encodes the unvalidated event anyway** (`proto/src/proto.ts:223-237`).

The **Python encoder ignores `accept` entirely** and only emits SSE
(`sdks/python/ag_ui/encoder/encoder.py:13-36`):

```python
    def __init__(self, accept: str = None):
        pass

    def get_content_type(self) -> str:
        return "text/event-stream"

    def _encode_sse(self, event: BaseEvent) -> str:
        return f"data: {event.model_dump_json(by_alias=True)}\n\n"
```

The FastAPI endpoint helper reads `request.headers.get("accept")`, builds the
encoder, and returns `StreamingResponse(..., media_type=encoder.get_content_type())`
(`integrations/langgraph/python/ag_ui_langgraph/endpoint.py:14-31`).

### 2.2 Client side — `@ag-ui/client`

`HttpAgent` POSTs the `RunAgentInput` and asks for SSE only
(`client/src/agent/http.ts:26-37, 64-67`):

```ts
  protected requestInit(input: RunAgentInput): RequestInit {
    return {
      method: "POST",
      headers: {
        ...this.headers,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(input),
      signal: this.abortController.signal,
    };
  }
  ...
  run(input: RunAgentInput): Observable<BaseEvent> {
    const httpEvents = runHttpRequest(() => this.fetch(this.url, this.requestInit(input)));
    return transformHttpEventStream(httpEvents, this.debugLogger);
  }
```

So the official TS client never requests protobuf; the negotiation exists
server-side for other clients. `runHttpRequest` is a `fetch` + `getReader()`
loop emitting `{type:"headers"}` then `{type:"data", data: Uint8Array}` chunks
(`client/src/run/http-request.ts:22-92`); a non-2xx response becomes an `Error`
with `.status` and `.payload` (`:28-45`). The parser is chosen **by response
`content-type`**, exact match (`client/src/transform/http.ts:33-52`):

```ts
      if (event.type === HttpEventType.HEADERS && !parserInitialized) {
        parserInitialized = true;
        const contentType = event.headers.get("content-type");
        ...
        if (contentType === proto.AGUI_MEDIA_TYPE) {
          parseProtoStream(bufferSubject).subscribe({...});
        } else {
          parseSSEStream(bufferSubject, log).subscribe({
            next: (json) => {
              try {
                const parsedEvent = EventSchemas.parse(json);
```

Every SSE event is **validated with Zod** (`transform/http.ts:55`); an invalid
event errors the whole stream (`:62-64`). An `AbortError` is turned into a
synthetic `RUN_ERROR {code:"abort"}` and completes the stream (`:67-75`).

The SSE parser (`client/src/transform/sse.ts:5-12, 40-42, 70-93`):

```ts
/**
 * Parses a stream of HTTP events into a stream of JSON objects using Server-Sent Events (SSE) format.
 * Strictly follows the SSE standard where:
 * - Events are separated by double newlines ('\n\n')
 * - Only 'data:' prefixed lines are processed
 * - Multi-line data events are supported and joined
 * - Non-data fields (event, id, retry) are ignored
 */
...
        const events = buffer.split(/\n\n/);
        buffer = events.pop() || "";
...
    for (const line of lines) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length > 0) {
        const jsonStr = dataLines.join("\n");
        const json = JSON.parse(jsonStr);
```

**`id:`, `event:` and `retry:` are explicitly ignored** — there is nothing for
an `EventSource`-style `Last-Event-ID` to hang on. (It does not use
`EventSource` at all; it is a POST + `fetch` body reader.)

The protobuf parser mirrors the encoder: accumulate bytes, read a 4-byte
big-endian length, `proto.decode` the slice, repeat
(`client/src/transform/proto.ts:6-10, 49-81`).

### 2.3 WebSocket

**Not implemented in the SDK.** The architecture doc says the protocol is
"Transport Agnostic ... supporting various transport mechanisms including
Server-Sent Events (SSE), webhooks, WebSockets, and more"
(`docs/concepts/architecture.mdx:31-35`), but the only transport shipped is
HTTP POST → SSE/protobuf body. `AbstractAgent.connect()` exists as the hook for
"persistent connections" and throws by default
(`client/src/agent/agent.ts:260-262`; `docs/sdk/js/client/abstract-agent.mdx:156-166, 205-214`):

```ts
  protected connect(input: RunAgentInput): Observable<BaseEvent> {
    throw new AGUIConnectNotImplementedError();
  }
```

`connectAgent()` runs the same pipeline as `runAgent()` minus middleware
(`agent.ts:263-330`). Grep for `websocket|reconnect|last-event-id` in
`client/src` (excluding tests) returns nothing.

---

## 3. State: STATE_SNAPSHOT vs STATE_DELTA vs MESSAGES_SNAPSHOT; resume

### 3.1 What the spec says a producer MUST do

The spec is soft. `docs/concepts/state.mdx:45-56`:

> Snapshots are typically used:
> - At the beginning of an interaction to establish the initial state
> - After connection interruptions to ensure synchronization
> - When major state changes occur that require a complete refresh
> - To establish a new baseline for future delta updates
>
> When a frontend receives a `STATE_SNAPSHOT` event, it should replace its
> existing state model entirely with the contents of the snapshot.

and `state.mdx:229-235`:

> 1. **Use snapshots judiciously**: Full snapshots should be sent only when
>    necessary to establish a baseline.
> 2. **Prefer deltas for incremental changes** ...

`docs/concepts/events.mdx:465-480` on deltas:

> Frontends should apply these patches in sequence to maintain an accurate state
> representation. If a frontend detects inconsistencies after applying patches, it
> may request a fresh `StateSnapshot`.

There is **no rule that a snapshot must precede the first delta**: the client
starts from `input.state` (the state it sent), so a run that emits only deltas
patches the client's own copy (§3.2). The "may request a fresh StateSnapshot"
has no wire mechanism — there is no event or verb for it; in practice it means
"start a new run".

### 3.2 How the client applies them

`client/src/apply/default.ts:131-141` seeds the reducer from what the client sent:

```ts
export const defaultApplyEvents = (input, events$, agent, subscribers, debugLogger) => {
  let messages = structuredClone_(agent.messages);
  let state = structuredClone_(input.state);
```

`STATE_SNAPSHOT` replaces (`default.ts:631-638`):

```ts
          if (mutation.stopPropagation !== true) {
            const { snapshot } = event as StateSnapshotEvent;
            // Replace state with the literal snapshot
            state = snapshot;
            applyMutation({ state });
          }
```

`STATE_DELTA` patches with `fast-json-patch`, validate=true, mutate=false, and on
failure **warns and keeps the old state** — the stream is not aborted and no
resync is requested (`default.ts:659-675`):

```ts
            try {
              // Apply the JSON Patch operations to the current state without mutating the original
              const result = jsonpatch.applyPatch(state, delta, true, false);
              state = result.newDocument;
              applyMutation({ state });
            } catch (error: unknown) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              console.warn(
                `Failed to apply state patch:\nCurrent state: ${JSON.stringify(state, null, 2)}\nPatch operations: ${JSON.stringify(delta, null, 2)}\nError: ${errorMessage}`,
              );
```

`MESSAGES_SNAPSHOT` is **not** a blind replace — it is an edit-based merge that
preserves client-only messages (`default.ts:695-751`, comment trimmed):

```ts
            // Edit-based merge: update existing messages with snapshot data while
            // preserving client-only messages the backend leaves out of the snapshot.
            const snapshotMap = new Map(newMessages.map((m) => [m.id, m]));
            ...
            const snapshotHasActivity = newMessages.some((m) => m.role === "activity");
            const snapshotHasReasoning = newMessages.some((m) => m.role === "reasoning");
            const isPreservedClientOnly = (m: Message) =>
              (m.role === "activity" && !snapshotHasActivity) ||
              (m.role === "reasoning" && !snapshotHasReasoning);

            // Step 1 + 2: Keep preserved client-only messages as-is, keep
            // messages present in the snapshot (replaced with snapshot version),
            // drop everything else.
            messages = messages
              .filter((m) => isPreservedClientOnly(m) || snapshotMap.has(m.id))
              .map((m) => (isPreservedClientOnly(m) ? m : snapshotMap.get(m.id)!));

            // Step 3: Append messages from the snapshot that we don't have yet.
            const existingIds = new Set(messages.map((m) => m.id));
            for (const snapshotMsg of newMessages) {
              if (!existingIds.has(snapshotMsg.id)) {
                messages.push(snapshotMsg);
              }
            }
```

The rule in the comment: "once [the snapshot] carries any activity the backend
is declaring the complete activity set, and one it leaves out has been removed"
(`default.ts:704-712`). `ACTIVITY_DELTA` is the same JSON Patch applied to one
activity message's `content`, with the same warn-and-continue on failure
(`default.ts:869-898`).

`compactEvents()` (for storing/replaying a run) folds every `STATE_SNAPSHOT` +
`STATE_DELTA` within a run into ONE `STATE_SNAPSHOT` of the final state
(`client/src/compact/compact.ts:76-87, 364-392`):

```ts
  for (const event of stateEvents) {
    if (event.type === EventType.STATE_SNAPSHOT) {
      state = structuredClone_(event.snapshot);
    } else {
      const result = jsonpatch.applyPatch(state, structuredClone_(event.delta), true, false);
      state = result.newDocument;
    }
  }
```

### 3.3 Resume / cursor — stated plainly

**There is no resume and no cursor in AG-UI.**

- The wire has no sequence number (`BaseEventSchema`, §1.1) and the SSE frame
  has no `id:` (`encoder.ts:28-30`); the parser drops `id:` if a server sent one
  (`sse.ts:12`).
- The client has no reconnect logic (`client/src`, grep above); a dropped body
  surfaces as a stream error / abort → synthetic `RUN_ERROR`
  (`transform/http.ts:67-75`).
- The word `resume` in the protocol means **interrupt resolution**: a new run
  with `RunAgentInput.resume: ResumeEntry[]` addressing `RUN_FINISHED.outcome.interrupts`
  (`types.ts:216-240`; `docs/concepts/events.mdx:119-124`;
  `agent.ts:401-417` refuses a run that leaves pending interrupts unaddressed).
- Recovery after a drop is "start a new run; the end-of-run snapshot re-syncs
  you". The LangGraph bridge documents exactly this failure mode
  (`integrations/langgraph/typescript/src/agent.ts:680-692`):

  > If an SSE stream dropped before MESSAGES_SNAPSHOT, the client never learned
  > the persisted message IDs and resends the new user turn with a freshly
  > generated UUID, making the checkpoint legitimately longer than the input
  > even though this is a continuation. ... Otherwise fall through to a normal
  > continuation stream so the end-of-run MESSAGES_SNAPSHOT re-syncs the client.

  (LangGraph Platform's own SSE resume — `stream_resumable` / `joinStream` — is
  a Platform feature; this bridge does not call it. Nothing more can be said
  from this repo; *inferred from client*.)

So AG-UI's answer to "I missed events" is **snapshot the whole thing at the
next run boundary**, not "replay from N".

---

## 4. Client runtime

### 4.1 `run()` → Observable, the pipeline

`AbstractAgent.run(input): Observable<BaseEvent>` is abstract
(`client/src/agent/agent.ts:142`). `runAgent()` builds the pipeline
(`agent.ts:196-247`):

```ts
      const pipeline = pipe(
        () => {
          if (this.middlewares.length === 0) {
            return this.run(input);
          }
          const chainedAgent = this.middlewares.reduceRight(
            (nextAgent: AbstractAgent, middleware) =>
              ({
                run: (i: RunAgentInput) => middleware.run(i, nextAgent),
                get messages() { return nextAgent.messages; },
                get state() { return nextAgent.state; },
              }) as AbstractAgent,
            this,
          );
          return chainedAgent.run(input);
        },
        transformChunks(this.debugLogger),
        verifyEvents(this.debugLogger),
        (source$) => source$.pipe(takeUntil(this.activeRunDetach$!)),
        (source$) => this.apply(input, source$, subscribers),
        (source$) => this.processApplyEvents(input, source$, subscribers),
        catchError((error) => { ...; return this.onError(input, error, subscribers); }),
        finalize(() => { ...; void this.onFinalize(input, subscribers); ... }),
      );

      await lastValueFrom(pipeline(of(null)));
```

Order: **middleware → chunk expansion → verify → (detach guard) → apply →
commit to `this.messages` / `this.state` + `onMessagesChanged` / `onStateChanged`**
(`agent.ts:352-383`). `runAgent` resolves with `{ result, newMessages }` — the
messages added during the run (`agent.ts:248-251`). `prepareRunAgentInput`
sends the FULL history minus `activity` messages every run (`agent.ts:385-399`).

### 4.2 Chunk expansion

`transformChunks` (`client/src/chunks/transform.ts:55-127`) keeps a `mode:
"text" | "tool" | "reasoning"` and the open ids; a `TEXT_MESSAGE_CHUNK` with a
new `messageId` closes the previous stream with a synthetic `*_END` and opens a
new one with a synthetic `*_START`; any non-chunk event first flushes the
pending stream (`transform.ts:114-127, 131-161`). Middleware always sees the
expanded form (`middleware/middleware.ts:30-34`, `transformChunks(false)`).

### 4.3 `verify` — the ordering state machine

`client/src/verify/verify.ts:6-372`. State held in closure:
`activeMessages: Map<messageId>`, `activeToolCalls: Map<toolCallId>`,
`activeSteps: Map<stepName>`, `runStarted`, `runFinished`, `runError`,
`firstEventReceived`, plus the legacy `activeThinkingStep(Message)` flags
(`verify.ts:11-21`). Each violation is `throwError(new AGUIError(...))`, which
**aborts the stream**. The rules, quoted:

1. First event (`verify.ts:68-73`):
   ```ts
        if (!firstEventReceived) {
          firstEventReceived = true;
          if (eventType !== EventType.RUN_STARTED && eventType !== EventType.RUN_ERROR) {
            return throwError(() => new AGUIError(`First event must be 'RUN_STARTED'`));
          }
   ```
2. Nothing after `RUN_ERROR` except a new `RUN_STARTED` (`verify.ts:45-52`):
   ```ts
        if (runError && eventType !== EventType.RUN_STARTED) {
          return throwError(() => new AGUIError(
                `Cannot send event type '${eventType}': The run has already errored with 'RUN_ERROR'. No further events can be sent.`));
   ```
3. Nothing after `RUN_FINISHED` except `RUN_ERROR` or a new `RUN_STARTED`
   (`verify.ts:54-66`).
4. No `RUN_STARTED` while a run is active (`verify.ts:74-90`); a new
   `RUN_STARTED` after FINISHED/ERROR resets all maps (`resetRunState`,
   `:24-33`) — one stream may carry several runs (replay of a stored thread).
5. Text messages, keyed by `messageId` (`verify.ts:95-144`): START with an
   already-active id → error; CONTENT / END for an id that is not active →
   error; END removes the id. **Interleaving different ids is legal** (it is a
   map, not a single slot).
6. Tool calls, keyed by `toolCallId`, same three rules (`verify.ts:147-196`).
7. Steps, keyed by `stepName`, same rules (`verify.ts:199-222`).
8. `RUN_FINISHED` refused while any step / message / tool call is open
   (`verify.ts:231-270`):
   ```ts
            if (activeMessages.size > 0) {
              const unfinishedMessages = Array.from(activeMessages.keys()).join(", ");
              return throwError(() => new AGUIError(
                    `Cannot send 'RUN_FINISHED' while text messages are still active: ${unfinishedMessages}`));
   ```
9. `RUN_ERROR` "can happen at any time" (`verify.ts:272-276`); `CUSTOM` always
   passes (`:278-280`); the legacy THINKING events have a single-slot rule
   (`:283-364`).
10. **Everything else passes unverified** (`verify.ts:366-368`, `default:
    return of(event)`): `TOOL_CALL_RESULT`, `STATE_*`, `MESSAGES_SNAPSHOT`,
    `ACTIVITY_*`, `RAW`, all `REASONING_*`. So a `TOOL_CALL_RESULT` for an
    unknown `toolCallId`, or a `STATE_DELTA` before any snapshot, is legal at
    this layer; the reducer tolerates them (§3.2).

The doc-level statement is weaker than the code: "Events should be processed
in the order they are received ... Implementations should be resilient to
out-of-order delivery" (`docs/concepts/events.mdx:834-840`). The code is not
resilient — `verify` throws.

### 4.4 Subscribers and middleware

`AgentSubscriber` (`client/src/agent/subscriber.ts:57-216`) is an object of
optional hooks: run lifecycle (`onRunInitialized/onRunFailed/onRunFinalized`),
a catch-all `onEvent`, one hook per event type (`onTextMessageContentEvent`
receives `textMessageBuffer`, `onToolCallArgsEvent` receives `partialToolCallArgs`,
`onStateSnapshotEvent`, `onStateDeltaEvent`, `onMessagesSnapshotEvent`,
`onCustomEvent`, `onRawEvent` ...), and state-change notifications
(`onMessagesChanged`, `onStateChanged`, `onNewMessage`, `onNewToolCall`,
`:203-214`). Every hook may return an `AgentStateMutation`
(`subscriber.ts:38-42`):

```ts
export interface AgentStateMutation {
  messages?: Message[];
  state?: State;
  stopPropagation?: boolean;
}
```

The reducer runs the subscribers FIRST and only then its own default handling,
and `stopPropagation: true` suppresses the default (`apply/default.ts:163-189`
and each `case`). Hooks may be async; they run sequentially (`concatMap`).

Middleware wraps `run()` (`client/src/middleware/middleware.ts:9-34`):

```ts
export type MiddlewareFunction = (
  input: RunAgentInput,
  next: AbstractAgent,
) => Observable<BaseEvent>;

export abstract class Middleware {
  abstract run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent>;
  protected runNext(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    return next.run(input).pipe(transformChunks(false));
  }
```

`runNextWithState` (`:40-79`) feeds a private `defaultApplyEvents` to hand each
event to the middleware WITH the messages/state after it — i.e. middleware can
see reduced state without owning the reducer. Middlewares are registered with
`agent.use(...)` (`agent.ts:150-156`); three back-compat rewriters are
auto-installed by version (`agent.ts:115-130`).

**No throttling anywhere in the client**: `apply` emits one mutation per event
and `processApplyEvents` notifies subscribers per mutation (`agent.ts:352-383`).
Any render throttling is the consumer's job (CopilotKit; not in this repo).

---

## 5. LangGraph integration: stream modes → AG-UI events

`integrations/langgraph/typescript/src/agent.ts` (2212 lines). `run()` wraps
`runAgentStream` in an Observable (`agent.ts:397-407`). Default stream modes
requested from LangGraph Platform (`agent.ts:430-437`):

```ts
    const streamMode =
      input.forwardedProps?.streamMode ??
      ([
        "events",
        "values",
        "updates",
        "messages-tuple",
      ] satisfies StreamMode[]);
```

Per-chunk dispatch (`agent.ts:878-1134`), the mapping:

| LangGraph chunk | AG-UI |
|---|---|
| loop start | `RUN_STARTED {threadId, runId}` (`:871-875`) |
| `event === "error"` | `RUN_ERROR {message, rawEvent}` then `break` (`:938-948`) |
| `"updates"` | **skipped** (`:950-952`) |
| `"values"` / `"values\|<subgraph>"` | merged into `latestStateValues`, no event yet (`:954-968`) |
| `on_chain_end` output | also merged into `latestStateValues` (`:1036-1058`) |
| node change (`metadata.langgraph_node`) | `STEP_FINISHED {stepName: prev}` + `STEP_STARTED {stepName: next}` via `handleNodeChange` (`:2105-2125, 2144-2155`) |
| state differs from last sent, or node changed/exited, **and no text message is in progress, and no predict-state tool call is streaming** | `STATE_SNAPSHOT {snapshot, rawEvent: chunk}` (`:1101-1126`) |
| every chunk | `RAW {event: chunkData}` (`:1129-1132`) |
| `on_chat_model_stream` | `TEXT_MESSAGE_START/CONTENT/END`, `TOOL_CALL_START/ARGS/END`, `REASONING_*`, `REASONING_ENCRYPTED_VALUE` (`:1218-1420`) |
| `messages-tuple` `[AIMessageChunk, metadata]` | same text/tool events, only if `events` mode produced nothing (`:1202-1210, 1603-1700`) |
| `on_tool_end` | `TOOL_CALL_RESULT {messageId, toolCallId, content}` (`:1487-1590`) |
| `on_custom_event` name `manually_emit_message` / `manually_emit_tool_call` / `manually_emit_state` | expanded to the corresponding START/CONTENT/END triple or `STATE_SNAPSHOT`, THEN also a `CUSTOM {name, value, rawEvent}` (`:1425-1485`; names at `types.ts:141-146`) |
| run end | `client.threads.getState(threadId)` → `STATE_SNAPSHOT` + `MESSAGES_SNAPSHOT` (`getStateAndMessagesSnapshots`, `:1184-1200`), then `RUN_FINISHED {threadId, runId, usage?}` or an interrupt outcome (`:1137-1178`) |

The condition for an in-run snapshot, quoted (`agent.ts:1101-1126`):

```ts
        const hasStateDiff =
          JSON.stringify(updatedState) !== JSON.stringify(state);
        // Suppress STATE_SNAPSHOT while a message is in progress, or while a
        // predict_state tool call is streaming args (modelMadeToolCall=true).
        ...
        if (
          !this.activeRun!.modelMadeToolCall &&
          (hasStateDiff ||
            this.activeRun!.prevNodeName != this.activeRun!.nodeName ||
            this.activeRun!.exitingNode) &&
          !Boolean(this.getMessageInProgress(this.activeRun!.id))
        ) {
          state = updatedState;
          this.activeRun!.prevNodeName = this.activeRun!.nodeName;
          this.dispatchEvent({
            type: EventType.STATE_SNAPSHOT,
            snapshot: this.getStateSnapshot(state),
            rawEvent: chunk,
          });
        }
```

and the end-of-run pair (`agent.ts:1184-1200`):

```ts
  private async getStateAndMessagesSnapshots(threadId: string): Promise<void> {
    const state: ThreadState<State> =
      await this.client.threads.getState(threadId);
    this.dispatchEvent({
      type: EventType.STATE_SNAPSHOT,
      snapshot: this.getStateSnapshot(state),
    });
    const checkpointMessages: LangGraphMessage[] =
      (state.values as State).messages ?? [];
    this.dispatchEvent({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: langchainMessagesToAgui(checkpointMessages),
    });
  }
```

`getStateSnapshot` filters state keys to the graph's output schema
(`agent.ts:1829-1841`). **The LangGraph bridge never emits `STATE_DELTA`**
(`grep STATE_DELTA integrations/langgraph/typescript/src/agent.ts` → no hits;
same for `python/ag_ui_langgraph/agent.py`). The reference integration is
snapshot-only: whole-state snapshots at node boundaries, a final
state+messages snapshot at run end.

---

## For Pinecall

Pinecall counterparts: the envelope and closed vocabulary in
`docs/guides/call-log.md` and `webrtc/src/log/vendor/types.ts:252-331`
(`LOG_EVENT_TYPES`); the reducer `CallLogView` (`webrtc/src/log/vendor/view.ts`);
transports `tail/poll/observe` (`webrtc/src/log/transport.ts`); hooks
`useCall/useAgentCalls` (`webrtc/src/log/react.tsx`); the WS attach handler and
`_snapshot`/`_gap_entry` in
`sdk-server/src/pinecall/server/handlers/calls_api.py:272-336, 738-845`.

1. **Do not rename our vocabulary; ship an adapter.** AG-UI names are
   `SCREAMING_SNAKE` run-scoped events with `messageId`/`toolCallId` keys; ours
   are dotted call-scoped facts with `seq`. The one-day-AG-UI-client story is a
   pure function `CallLogView entries → AGUIEvent[]` (a `@pinecall/web/log/agui`
   subpath or an `@pinecall/sdk/log` helper), not a wire change. The mapping is
   mechanical and worth writing down now so the vocabulary stays mappable:
   `call.started` → `RUN_STARTED {threadId: call, runId: call}`;
   `call.ended`/`call.summary` → `RUN_FINISHED {result: summary}`;
   `user.message` (final) → `TEXT_MESSAGE_START{role:"user"}/CONTENT/END`;
   `bot.speaking`/`bot.word`/`bot.finished` → `TEXT_MESSAGE_START/CONTENT/END`
   (bot.word deltas ARE `TEXT_MESSAGE_CONTENT`);
   `tool.call` → `TOOL_CALL_START{toolCallId: data.id, toolCallName}` +
   `TOOL_CALL_ARGS{delta: JSON.stringify(args)}` + `TOOL_CALL_END`;
   `tool.result` → `TOOL_CALL_RESULT{toolCallId, content}`;
   `log.gap.data.snapshot` → `STATE_SNAPSHOT`;
   everything voice-specific (`turn.*`, `audio.metrics`, `handoff.*`,
   `supervisor.*`, `skill.*`, `docs.sources`) → `CUSTOM {name: type, value: data}`.
   What it requires of us: **stable ids** on `bot.*` and `tool.*` entries
   (`data.id`) — verify is keyed by id, not by position (§4.3).

2. **Keep `seq`; it is the thing AG-UI lacks.** Their base event has only
   `timestamp` and `metadata` (§1.1); their resume story is "there is none, snapshot
   at the next run" (§3.3). Our `after=<seq>` cursor is strictly stronger. When
   the SSE attach lands, emit `id: <seq>` on every frame (the SSE field AG-UI's
   own parser ignores) so a vanilla `EventSource` reconnects with
   `Last-Event-ID` and the handler treats it exactly as `?after=`. Same
   handler, same `_attach_backlog` (`calls_api.py:664-685`), one more way to
   spell the cursor.

3. **Negotiate, do not multiply endpoints.** AG-UI's encoder picks
   `text/event-stream` vs protobuf from `Accept` with real q-value parsing
   (§2.1) and the client picks its parser from the response `content-type`
   (§2.2). Do the same on `GET /v1/calls/{id}/events`: `Accept:
   text/event-stream` → stream (backlog then live, `log.caught_up` in-band),
   otherwise the existing JSON page. Skip protobuf: AG-UI's own binary format
   covers only 18 of 34 events and its reference client never asks for it
   (`metadata.test.ts:119-150`, `http.ts:32`).

4. **What the `verify` state machine teaches our closed vocabulary.** Three
   rules are worth enforcing in `CallLogView` tests (dev-mode assertions, never
   a throw on the hot path — their throw aborts the whole stream, §4.3): (a) a
   terminal entry closes the log — nothing after `call.summary` (we already
   say "always the last entry"; assert it); (b) every open/close pair is keyed
   by id and may interleave — `tool.result` without a matching `tool.call`,
   `bot.word` without a `bot.speaking`, are findings; (c) the terminal entry
   is refused while something is open — `call.summary` with a tool call still
   pending is a producer bug we should see in CI, not in a dashboard. Note AG-UI
   leaves `TOOL_CALL_RESULT`, `STATE_*`, `REASONING_*` unverified (§4.3 item 10)
   — their vocabulary grew faster than their verifier; ours is closed precisely
   so the exhaustiveness `never` in `view.ts:792-796` cannot drift.

5. **Snapshot yes, delta no.** Their spec allows JSON Patch deltas, but the
   reference LangGraph bridge emits **snapshots only**, suppressed while a
   message is streaming (§5), and their compactor collapses every run's state
   events into one final snapshot (§3.2). Our log entries ARE the deltas — the
   log is the patch stream, with a cursor. So: no `call.state` delta entry. The
   snapshot belongs exactly where it already is, `log.gap.data.snapshot`
   (`calls_api.py:272-305`), whose shape should grow to hydrate every
   `CallLogState` field the reducer owns (`phase`, `messages`, `toolCalls`
   incl. open ones, `turns`, `live`) so a gapped client lands complete — today
   `_snapshot` returns `{phase, messages, open_tools}` only, and `view.ts:784-789`
   records the gap but does not hydrate from it. If a standalone snapshot entry
   is ever wanted (a late joiner who does not want the backlog), make it
   replace-wholesale like `STATE_SNAPSHOT`, minted by the transport like
   `log.gap`, never a patch.

6. **Custom entries: mirror `CUSTOM {name, value}`.** For `call.log()` add ONE
   closed type, `log.custom`, with `data: {name: string, value: unknown}` —
   a 1:1 image of AG-UI's `CUSTOM`, which `verify` always passes and the reducer
   never interprets (subscribers only, §4.3/§4.4). The reducer keeps ignoring it
   (it is a known type with no state effect); consumers read it through a hook.
   Do not mint `custom.<name>` types — the vocabulary stays closed and the
   adapter in (1) maps it without a table.

7. **A subscriber seam, not middleware.** AG-UI's per-event hooks returning a
   mutation + `stopPropagation` (§4.4) are more than a log viewer needs, but the
   catch-all `onEvent` with the reduced state after it is cheap and is how a
   dashboard reacts to `log.custom` or `tool.result` without re-deriving state:
   an `onEntry?(entry, state)` option on `observe()`/`useCall`. Skip the
   middleware chain (`use()`): it exists to rewrite deprecated event shapes
   across versions; our vocabulary is closed and versionless.

8. **`useCall` throttle is our decision, not theirs.** The AG-UI client emits
   one mutation per event and never coalesces (§4.4); CopilotKit throttles
   upstream and is not in the repo. The LangGraph `useStream` report
   (tk-2b8817) is the reference for throttle/`reconnectOnMount`; nothing in
   AG-UI bears on it except the negative: snapshot-at-next-run is what you get
   without a cursor, and our reconnect already carries `after=lastSeq`
   (`transport.ts:282-284`).

9. **`MESSAGES_SNAPSHOT`'s merge rule is the right rule for hydrating from a
   gap snapshot.** It merges by id and preserves client-side-only messages
   rather than wiping (§3.2). When `CallLogView` starts hydrating from
   `log.gap.data.snapshot`, merge by `seq`/`data.id` (the dedupe the view already
   does, `view.ts:360-375`), never replace the arrays — an interim `user.message`
   the snapshot does not carry must survive.

10. **Chunk events are a producer convenience we do not need.** `*_CHUNK` exists
    so a producer can skip START/END bookkeeping, expanded client-side
    (§4.2). Our producer is one server with a known lifecycle; `bot.speaking` →
    `bot.word` → `bot.finished` is already the expanded form. Skip.

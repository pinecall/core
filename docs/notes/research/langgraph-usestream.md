# LangGraph `useStream` — React hook internals

Research note for the Streaming milestone. Read-only study of the React client
in the LangGraph JS SDK, written so the Pinecall call log can copy the good
decisions and skip the ones that only make sense for a text-agent/thread model.

**Sources.** `~/research/langgraphjs` at commit `f8bdf16d` (2026-08-21, "fix(sdk):
drop unused svelte and vue peer dependencies (#2727)"). All paths below are
relative to `~/research/langgraphjs/libs/`. Two hooks exist today:

| package | entry | what |
|---|---|---|
| `@langchain/langgraph-sdk/react` (v1, still shipped) | `sdk/src/react/stream.tsx` → `stream.lgp.tsx` (hosted) / `stream.custom.tsx` (bring-your-own transport) | the `reconnectOnMount` / `throttle` / `joinStream` / branching hook this note is about |
| `@langchain/react` (v2) | `sdk-react/src/use-stream.ts` over `sdk/src/stream/controller.ts` | rewrite on a "session-based" thread stream; drops `reconnectOnMount`, `throttle`, branching. Covered in §10 |

**What is open source vs not.** Everything quoted here is OSS (MIT) client code.
The LangGraph *Platform* server that answers `POST /threads/{id}/runs/stream` and
`GET /threads/{id}/runs/{run}/stream` is closed; whenever a server behaviour is
stated below it is marked **inferred from client**. The OSS `langgraph-api`
dev server (`libs/langgraph-api`) is a separate card (lgwire) and is not used as
evidence here.

**Pinecall counterparts** referenced in §11: `webrtc/src/log/react.tsx`
(`useCall`, `useAgentCalls`), `webrtc/src/log/transport.ts` (`tail`, `poll`,
`observe`), `sdk/docs/guides/call-log.md` (the envelope: `seq`, `type`,
`ephemeral`, `log.gap`, `log.caught_up`).

---

## 1. Entry point and the two implementations

`useStream` is a thin dispatcher; the implementation is chosen ONCE per mount
(`useState`) from whether `transport` is present:

```ts
// sdk/src/react/stream.tsx:15-55
function isCustomOptions<...>(options: UseStreamOptions<StateType, Bag> | UseStreamCustomOptions<StateType, Bag>)
  : options is UseStreamCustomOptions<StateType, Bag> {
  return "transport" in options;
}

export function useStream<T = Record<string, unknown>, Bag extends BagTemplate = BagTemplate>(
  options: ResolveStreamOptions<T, InferBag<T, Bag>>
): ResolveStreamInterface<T, InferBag<T, Bag>>;

export function useStream<T = Record<string, unknown>, Bag extends BagTemplate = BagTemplate>(
  options: UseStreamCustomOptions<StateRecord<InferStateType<T>>, InferBag<T, Bag>>
): ResolveStreamInterface<T, InferBag<T, Bag>>;

export function useStream(options: any): any {
  // Store this in useState to make sure we're not changing the implementation in re-renders
  const [isCustom] = useState(isCustomOptions(options));
  if (isCustom) { return useStreamCustom(options); }
  return useStreamLGP(options);
}
```

Both implementations share one framework-free engine: `StreamManager`
(`sdk/src/ui/manager.ts`) fed by an `AsyncGenerator<{event, data}>`, plus
`MessageTupleManager` (`sdk/src/ui/messages.ts`) for chunk accumulation. A
framework-agnostic twin of the React hook, `StreamOrchestrator`
(`sdk/src/ui/orchestrator.ts`), backs the Vue/Svelte/Angular adapters and
duplicates the same reconnect logic (`orchestrator.ts:71-79, 795-830, 955`).

---

## 2. The options type — verbatim

`sdk/src/ui/types.ts:1067-1301` (JSDoc trimmed only where it is a prose paragraph;
every field and signature is intact):

```ts
export interface UseStreamOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
> {
  /** The ID of the assistant to use. */
  assistantId: string;
  /** Client used to send requests. */
  client?: Client;
  /** The URL of the API to use. */
  apiUrl?: ClientConfig["apiUrl"];
  /** The API key to use. */
  apiKey?: ClientConfig["apiKey"];
  /** Custom call options, such as custom fetch implementation. */
  callerOptions?: ClientConfig["callerOptions"];
  /** Default headers to send with requests. */
  defaultHeaders?: ClientConfig["defaultHeaders"];
  /** Specify the key within the state that contains messages. Defaults to "messages". */
  messagesKey?: string;
  /** Callback that is called when an error occurs. */
  onError?: (error: unknown, run: RunCallbackMeta | undefined) => void;
  /** Callback that is called when the stream is finished. ... */
  onFinish?: (state: ThreadState<StateType>, run: RunCallbackMeta | undefined) => void;
  /** Callback that is called when a new stream is created. */
  onCreated?: (run: RunCallbackMeta) => void;
  /** Callback that is called when an update event is received. */
  onUpdateEvent?: (
    data: UpdatesStreamEvent<GetUpdateType<Bag, StateType>>["data"],
    options: {
      namespace: string[] | undefined;
      mutate: (update: Partial<StateType> | ((prev: StateType) => Partial<StateType>)) => void;
    }
  ) => void;
  /** Callback that is called when a custom event is received. */
  onCustomEvent?: (
    data: CustomStreamEvent<GetCustomEventType<Bag>>["data"],
    options: {
      namespace: string[] | undefined;
      mutate: (update: Partial<StateType> | ((prev: StateType) => Partial<StateType>)) => void;
    }
  ) => void;
  /** Callback that is called when a metadata event is received. */
  onMetadataEvent?: (data: MetadataStreamEvent["data"]) => void;
  /** Callback that is called when a LangChain event is received. */
  onLangChainEvent?: (data: EventsStreamEvent["data"]) => void;
  /** @internal This API is experimental and subject to change. */
  onDebugEvent?: (data: DebugStreamEvent["data"], options: { namespace: string[] | undefined }) => void;
  /** Callback that is called when a checkpoints event is received. */
  onCheckpointEvent?: (data: CheckpointsStreamEvent<StateType>["data"], options: { namespace: string[] | undefined }) => void;
  /** Callback that is called when a tasks event is received. */
  onTaskEvent?: (data: TasksStreamEvent<StateType, GetUpdateType<Bag, StateType>>["data"], options: { namespace: string[] | undefined }) => void;
  /** Callback that is called when a tool lifecycle event is received. */
  onToolEvent?: (
    data: ToolsStreamEvent["data"],
    options: {
      namespace: string[] | undefined;
      mutate: (update: Partial<StateType> | ((prev: StateType) => Partial<StateType>)) => void;
    }
  ) => void;
  /** Callback that is called when the stream is stopped by the user. ... */
  onStop?: (options: {
    mutate: (update: Partial<StateType> | ((prev: StateType) => Partial<StateType>)) => void;
  }) => void;
  /** The ID of the thread to fetch history and current values from. */
  threadId?: string | null;
  /** Callback that is called when the thread ID is updated (ie when a new thread is created). */
  onThreadId?: (threadId: string) => void;
  /** Will reconnect the stream on mount */
  reconnectOnMount?: boolean | (() => RunMetadataStorage);
  /** Initial values to display immediately when loading a thread. ... */
  initialValues?: StateType | null;
  /**
   * Whether to fetch the history of the thread.
   * If true, the history will be fetched from the server. Defaults to 10 entries.
   * If false, only the last state will be fetched from the server.
   * @default true
   */
  fetchStateHistory?: boolean | { limit: number };
  /** Manage the thread state externally. */
  thread?: UseStreamThread<StateType>;
  /**
   * Throttle the stream.
   * If a number is provided, the stream will be throttled to the given number of milliseconds.
   * If `true`, updates are batched in a single macrotask.
   * If `false`, updates are not throttled or batched.
   * @default true
   */
  throttle?: number | boolean;
  /** Headless tool implementations to execute locally when the agent interrupts ... */
  tools?: AnyHeadlessToolImplementation[];
  /** Callback for headless tool lifecycle events. */
  onTool?: OnToolCallback;
}
```

The storage contract behind `reconnectOnMount` is a private interface
(`sdk/src/ui/types.ts:1315-1319`) — note the key is a template-literal type:

```ts
interface RunMetadataStorage {
  getItem(key: `lg:stream:${string}`): string | null;
  setItem(key: `lg:stream:${string}`, value: string): void;
  removeItem(key: `lg:stream:${string}`): void;
}
```

Per-call options (`sdk/src/ui/types.ts:1324-1382`):

```ts
export interface SubmitOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  ContextType extends Record<string, unknown> = Record<string, unknown>,
> {
  config?: ConfigWithConfigurable<ContextType>;
  context?: ContextType;
  checkpoint?: Omit<Checkpoint, "thread_id"> | null;
  command?: Command;
  interruptBefore?: "*" | string[];
  interruptAfter?: "*" | string[];
  metadata?: Metadata;
  multitaskStrategy?: MultitaskStrategy;
  onCompletion?: OnCompletionBehavior;
  onDisconnect?: DisconnectMode;
  feedbackKeys?: string[];
  streamMode?: Array<StreamMode>;
  runId?: string;
  optimisticValues?:
    | Partial<StateType>
    | ((prev: StateType) => Partial<StateType>);
  /** @default false */
  streamSubgraphs?: boolean;
  /**
   * Mark the stream as resumable. All events emitted during the run will be temporarily persisted
   * in order to be re-emitted if the stream is re-joined.
   * @default false
   */
  streamResumable?: boolean;
  /** @default "async" */
  durability?: Durability;
  /** The ID to use when creating a new thread. ... */
  threadId?: string;
  /** Callback that is called when an error occurs during this specific submit call. ... */
  onError?: (error: unknown, run: RunCallbackMeta | undefined) => void;
}
```

The custom-transport variant keeps a `Pick` of those (`sdk/src/ui/types.ts:1414-1447`)
plus `transport: UseStreamTransport<StateType, Bag>`, whose only method is
`stream(payload) => Promise<AsyncGenerator<{ id?: string; event: string; data: unknown }>>`
(`types.ts:1405-1412`). `reconnectOnMount`, `fetchStateHistory`, `thread`,
`assistantId`/`client` are NOT in the custom pick — resume is hosted-only.

---

## 3. The return type — verbatim

`sdk/src/react/types.tsx:75-167` (`UseStream`) extends `StreamBase`
(`sdk/src/ui/types.ts:101-260`):

```ts
export interface StreamBase<
  StateType = Record<string, unknown>,
  ToolCall = DefaultToolCall,
  InterruptType = unknown,
  SubagentStates extends Record<string, unknown> = DefaultSubagentStates,
> {
  values: StateType;
  error: unknown;
  isLoading: boolean;
  messages: Message<ToolCall>[];
  toolCalls: ToolCallWithResult<ToolCall>[];
  getToolCalls: (message: AIMessage<ToolCall>) => ToolCallWithResult<ToolCall>[];
  interrupt: Interrupt<InterruptType> | undefined;
  interrupts: Interrupt<InterruptType>[];
  subagents: Map<string, SubagentStreamInterface<SubagentStates[keyof SubagentStates], ToolCall, keyof SubagentStates & string>>;
  activeSubagents: SubagentStreamInterface<...>[];
  getSubagent: (toolCallId: string) => SubagentStreamInterface<...> | undefined;
  getSubagentsByType: {
    <TName extends keyof SubagentStates & string>(type: TName): SubagentStreamInterface<SubagentStates[TName], ToolCall, TName>[];
    (type: string): SubagentStreamInterface<Record<string, unknown>, ToolCall>[];
  };
  getSubagentsByMessage: (messageId: string) => SubagentStreamInterface<...>[];
  switchThread: (newThreadId: string | null) => void;
}

export interface UseStream<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
  SubagentStates extends Record<string, unknown> = DefaultSubagentStates,
> extends StreamBase<StateType, GetToolCallsType<StateType>, GetInterruptType<Bag>, SubagentStates> {
  isThreadLoading: boolean;
  stop: () => Promise<void>;
  submit: (
    values: GetUpdateType<Bag, StateType> | null | undefined,
    options?: SubmitOptions<StateType, GetConfigurableType<Bag>>
  ) => Promise<void>;
  branch: string;
  setBranch: (branch: string) => void;
  history: ThreadState<StateType>[];
  /** @experimental */
  experimental_branchTree: Sequence<StateType>;
  getMessagesMetadata: (
    message: Message<GetToolCallsType<StateType>>,
    index?: number
  ) => MessageMetadata<StateType> | undefined;
  toolProgress: ToolProgress[];
  client: Client;
  assistantId: string;
  joinStream: (
    runId: string,
    lastEventId?: string,
    options?: {
      streamMode?: StreamMode | StreamMode[];
      filter?: (event: { id?: string; event: StreamEvent; data: unknown }) => boolean;
    }
  ) => Promise<void>;
}
```

`UseStreamCustom` is a `Pick` of that minus everything thread/branch/join
(`react/types.tsx:169-194`). `MessageMetadata` (`ui/types.ts:954-981`):

```ts
export type MessageMetadata<StateType extends Record<string, unknown>> = {
  messageId: string;
  firstSeenState: ThreadState<StateType> | undefined;
  branch: string | undefined;
  branchOptions: string[] | undefined;
  /** @remarks This metadata only exists temporarily in browser memory during streaming and is not persisted after completion. */
  streamMetadata: Record<string, unknown> | undefined;
};
```

The newer typed surface that `ResolveStreamInterface` resolves to is
`BaseStream` (`sdk/src/ui/stream/base.ts:52-209`) — same members, plus a
`queue: QueueInterface<...>` declared at `base.ts:206-209` that the React
implementation never populates (no `queue` anywhere in
`react/stream.lgp.tsx` / `stream.custom.tsx`).

Implementation detail worth copying: the returned object uses **getters** for
the derived fields and marks the expensive ones non-enumerable so a
`{...stream}` spread does not evaluate them (`react/stream.lgp.tsx:803-971`):

```ts
// react/stream.lgp.tsx:954-971
const nonEnumerableAccessors = ["history", "experimental_branchTree", "toolProgress", "subagents", "activeSubagents"] as const;
for (const key of nonEnumerableAccessors) {
  const descriptor = Object.getOwnPropertyDescriptor(streamHandle, key);
  if (descriptor?.get) {
    Object.defineProperty(streamHandle, key, { ...descriptor, enumerable: false });
  }
}
```

Each getter also calls `trackStreamMode(...)` (`stream.lgp.tsx:229-237`,
`805, 885, 890, 896, 901, 911, 929…`) — reading `stream.messages` records that
the NEXT submit must ask the server for `messages-tuple` + `values`; the stream
modes actually requested are the union of the explicit `streamMode`, the
tracked set, and one mode per registered `on*Event` callback
(`stream.lgp.tsx:247-265, 555-559`). That is "server-side filters driven by what
the UI reads" — the client never subscribes to a channel nobody consumes.

---

## 4. `reconnectOnMount` — what is persisted, where, when it rejoins

### 4.1 Storage resolution

```ts
// react/stream.lgp.tsx:183-190
const reconnectOnMountRef = useRef(options.reconnectOnMount);
const runMetadataStorage = useMemo(() => {
  if (typeof window === "undefined") return null;
  const storage = reconnectOnMountRef.current;
  if (storage === true) return window.sessionStorage;
  if (typeof storage === "function") return storage();
  return null;
}, []);
```

- `true` → **`window.sessionStorage`**, not localStorage (same in the orchestrator:
  `ui/orchestrator.ts:78`). A function returns any object with the three-method
  `RunMetadataStorage` shape (§2).
- Resolved once per mount (`useRef` + empty deps): flipping the option later
  does nothing.

### 4.2 What is written, and when

On `submit()`, when the server acknowledges the run:

```ts
// react/stream.lgp.tsx:574-575
const streamResumable = submitOptions?.streamResumable ?? !!runMetadataStorage;
// react/stream.lgp.tsx:588-590
onDisconnect: submitOptions?.onDisconnect ?? (streamResumable ? "continue" : "cancel"),
// react/stream.lgp.tsx:599-611
onRunCreated(params) {
  callbackMeta = { run_id: params.run_id, thread_id: params.thread_id ?? usableThreadId! };
  if (runMetadataStorage) {
    rejoinKey = `lg:stream:${usableThreadId}`;
    runMetadataStorage.setItem(rejoinKey, callbackMeta.run_id);
  }
  options.onCreated?.(callbackMeta);
},
```

So the persisted record is **key `lg:stream:<threadId>` → value `<run_id>`
(a bare string)**. Nothing else: no `lastEventId`, no cursor, no timestamp.

`onRunCreated` is fired by the HTTP client from the initial response's
`Content-Location` header (`client/runs/index.ts:108-113`,
`client/base.ts:478-493`: `REGEX_RUN_METADATA = /(\/threads\/(?<thread_id>.+))?\/runs\/(?<run_id>.+)/`).
**Inferred from client:** the Platform answers `POST …/runs/stream` with
`Content-Location: /threads/{t}/runs/{r}`.

Two run options are implied by enabling storage:

- `streamResumable` defaults to `!!runMetadataStorage` → the body carries
  `stream_resumable: true` (`client/runs/index.ts:87`). **Inferred from client:**
  the server buffers the run's events so a later join can replay them.
- `onDisconnect` defaults to `"continue"` instead of `"cancel"`
  (`client/runs/index.ts:96` → `on_disconnect`). **Inferred from client:** the
  server keeps executing the run when the SSE consumer drops.

The key is removed on success of either path (`stream.lgp.tsx:630`, `721`) and
on `stop()`, which also cancels server-side (`stream.lgp.tsx:470-481`):

```ts
const stop = () =>
  stream.stop(historyValues, {
    onStop: (args) => {
      if (runMetadataStorage && threadId) {
        const runId = runMetadataStorage.getItem(`lg:stream:${threadId}`);
        if (runId) void client.runs.cancel(threadId, runId);
        runMetadataStorage.removeItem(`lg:stream:${threadId}`);
      }
      options.onStop?.(args);
    },
  });
```

Note what is NOT removed: an error path (`onError`, `stream.lgp.tsx:653-655`)
leaves the key in place, so the next mount will try to rejoin a failed run
(and `joinStream` will presumably fail again and `onError`).

### 4.3 When it rejoins

```ts
// react/stream.lgp.tsx:748-774
const reconnectKey = useMemo(() => {
  if (!runMetadataStorage || stream.isLoading) return undefined;
  if (typeof window === "undefined") return undefined;
  const runId = runMetadataStorage?.getItem(`lg:stream:${threadId}`);
  if (!runId) return undefined;
  return { runId, threadId };
}, [runMetadataStorage, stream.isLoading, threadId]);

const shouldReconnect = !!runMetadataStorage;
const reconnectRef = useRef({ threadId, shouldReconnect });

const joinStreamRef = useRef<typeof joinStream>(joinStream);
joinStreamRef.current = joinStream;

useEffect(() => {
  // reset shouldReconnect when switching threads
  if (reconnectRef.current.threadId !== threadId) {
    reconnectRef.current = { threadId, shouldReconnect };
  }
}, [threadId, shouldReconnect]);

useEffect(() => {
  if (reconnectKey && reconnectRef.current.shouldReconnect) {
    reconnectRef.current.shouldReconnect = false;
    void joinStreamRef.current?.(reconnectKey.runId);
  }
}, [reconnectKey]);
```

Flow: mount (or thread switch) → if storage has a run id for this thread and
nothing is streaming → call `joinStream(runId)` exactly once per thread
(`shouldReconnect` is a one-shot latch per `threadId`).

### 4.4 `joinStream` and the wire

```ts
// react/stream.lgp.tsx:664-746 (abridged to the load-bearing lines)
const joinStream = async (runId: string, lastEventId?: string, joinOptions?: {...}) => {
  setToolProgressMap(new Map());
  lastEventId ??= "-1";
  if (!threadId) return;
  ...
  await stream.start(
    async (signal: AbortSignal) => {
      threadIdStreamingRef.current = threadId;
      const stream = client.runs.joinStream(threadId, runId, { signal, lastEventId, streamMode: joinOptions?.streamMode })
        as AsyncGenerator<EventStreamEvent<StateType, UpdateType, CustomType>>;
      return joinOptions?.filter != null ? filterStream(stream, joinOptions.filter) : stream;
    },
    { getMessages, setMessages, initialValues: historyValues, callbacks: {...options, onToolEvent},
      async onSuccess() { runMetadataStorage?.removeItem(`lg:stream:${threadId}`); ... },
      onError(error) { options.onError?.(error, callbackMeta); },
      onFinish() { threadIdStreamingRef.current = null; } }
  );
};
```

`client.runs.joinStream` (`client/runs/index.ts:404-455`):

```ts
yield* this.streamWithRetry({
  endpoint: threadId != null ? `/threads/${threadId}/runs/${runId}/stream` : `/runs/${runId}/stream`,
  method: "GET",
  signal: opts?.signal,
  idleReconnect: opts?.streamIdleReconnect,
  headers: opts?.lastEventId ? { "Last-Event-ID": opts.lastEventId } : undefined,
  params: { cancel_on_disconnect: opts?.cancelOnDisconnect ? "1" : "0", stream_mode: opts?.streamMode },
});
```

Consequences, all verifiable in the client:

- The automatic reconnect-on-mount passes **no** `lastEventId` → default
  `"-1"` → header `Last-Event-ID: -1` → **full replay from the first event**
  (inferred: `-1` means "before the first id" on the server). There is no
  client-side cursor; de-duplication is by message id in `MessageTupleManager`
  (§6) and by the `values` events simply overwriting state. For a text stream
  that is cheap; for a call log we have `seq` and should resume from it.
- `filterStream` (`ui/utils.ts:27-36`) is a pure client-side predicate over
  `{id, event, data}` — the only "filter" the hook offers, and it runs after the
  bytes arrived.
- Mid-stream drops are handled one layer down in `streamWithRetry`
  (`client/base.ts:400-476`): on reconnect it re-issues a **GET** to
  `reconnectParams.reconnectPath` with `Last-Event-ID: <last seen id>`
  (`base.ts:424-427`), and an idle watchdog keyed on the server's `:` keep-alive
  comments can trigger the same (`base.ts:451-463`, `joinStream` doc at
  `client/runs/index.ts:413-425`). That wire layer belongs to the lgwire card;
  the point for this note is that the *hook* has no cursor — the transport does.

### 4.5 The `streamResumable` ↔ storage coupling

`reconnectOnMount` without `streamResumable` would be useless (nothing to
replay), so the hook ties them: storage on ⇒ `stream_resumable: true` and
`on_disconnect: "continue"` by default (`stream.lgp.tsx:574-590`). The user can
still override per submit. There is no check that the server actually honoured
`stream_resumable` — a join against a non-resumable run is **inferred** to
return an empty/ended stream.

---

## 5. `throttle` — how batching is really implemented

The option is passed into `StreamManager` at construction:

```ts
// react/stream.lgp.tsx:211-218
const [stream] = useState(() => new StreamManager<StateType, Bag>(messageManager, {
  throttle: options.throttle ?? false,
  subagentToolNames: options.subagentToolNames,
  filterSubagentMessages: options.filterSubagentMessages,
}));
```

(`stream.custom.tsx:138` is identical: `throttle: options.throttle ?? false`.)
**The JSDoc says `@default true`; the code defaults to `false`.** Both hooks.

The mechanism lives in `subscribe`, i.e. on the **listener** side, not on the
state writes:

```ts
// ui/manager.ts:647-680
private setState = (newState: Partial<typeof this.state>) => {
  this.state = { ...this.state, ...newState };
  this.notifyListeners();
};

private notifyListeners = () => {
  this.listeners.forEach((listener) => listener());
};

subscribe = (listener: () => void): (() => void) => {
  if (this.throttle === false) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  const timeoutMs = this.throttle === true ? 0 : this.throttle;
  let timeoutId: NodeJS.Timeout | number | undefined;

  const throttledListener = () => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      clearTimeout(timeoutId);
      listener();
    }, timeoutMs);
  };

  this.listeners.add(throttledListener);
  return () => {
    clearTimeout(timeoutId);
    this.listeners.delete(throttledListener);
  };
};

getSnapshot = () => this.state;
```

Read it precisely:

- Every event still produces a **new state object immediately**
  (`setState` spreads; `setStreamValues` at `manager.ts:694-708` calls it). The
  state is always current; only the *notification* is deferred.
- `clearTimeout` + `setTimeout` on every notify is a **trailing-edge debounce**,
  not a throttle: if events keep arriving closer than `timeoutMs` apart the
  listener never fires until a gap opens. With `throttle: true` (0 ms) that is
  harmless — a macrotask always runs between network chunks — and it coalesces
  every synchronous burst (one SSE chunk can decode into many events) into one
  `useSyncExternalStore` notification, hence one render. With a number (say
  200) a fast token stream could starve the UI until the model pauses. No rAF,
  no microtask, no leading edge.
- It is `setTimeout`, so it is a **macrotask** — exactly what the doc string
  says for `true`.
- Because the hook reads `stream.values` / `stream.isLoading` directly through
  getters (`stream.lgp.tsx:776-777, 803-813`) rather than the snapshot returned
  by `useSyncExternalStore` (the call at `stream.lgp.tsx:220-224` discards its
  return value), a render triggered by anything else (parent re-render,
  `setBranch`) already shows the newest state even mid-debounce.
- Unsubscribe clears the pending timer — no notify-after-unmount.

The v2 store (`sdk/src/stream/store.ts:23-53`) has **no throttling at all**:
`setValue` does an `Object.is` bail-out and notifies synchronously; batching is
left to React 18's automatic batching.

---

## 6. Optimistic values and `submit()` reconciliation

### 6.1 v1 hook (`optimisticValues`)

```ts
// react/stream.lgp.tsx:515-529
await stream.start(
  async (signal: AbortSignal) => {
    stream.setStreamValues((values) => {
      const prev = { ...historyValues, ...values };
      if (submitOptions?.optimisticValues != null) {
        return {
          ...prev,
          ...(typeof submitOptions.optimisticValues === "function"
            ? submitOptions.optimisticValues(prev)
            : submitOptions.optimisticValues),
        };
      }
      return { ...prev };
    });
    ...
```

- Applied **inside** the queued action, i.e. before the HTTP request is sent
  but after any previously queued run (`manager.ts:1142-1190`: `start` chains
  `enqueue` on `this.queue`; `abortPrevious` for `multitaskStrategy
  "interrupt"|"rollback"`, `stream.lgp.tsx:510-513, 660`).
- It is a **shallow merge into `values`**; there is no notion of "an optimistic
  message" — the caller typically passes
  `optimisticValues: (prev) => ({ messages: [...prev.messages, humanMsg] })`.
- Reconciliation is **by replacement**: the first server `values` event
  overwrites the whole state (`manager.ts:994-1009`, the non-interrupt branch
  returns `data as StateType`), and `messages-tuple` events write by index from
  `MessageTupleManager` (`manager.ts:1013-1111`). If the optimistic human
  message had no `id`, the server's echoed copy (with an id) does not "match"
  it — it simply lands in the `values` snapshot that replaces the optimistic
  array. No id minting, no pending/sent status.
- On success with history enabled, `onSuccess` returns `null` after
  `history.mutate()` so the stream values are cleared and the UI falls back to
  the refetched thread head (`stream.lgp.tsx:629-652`, `manager.ts:1117-1122`).
  With no history, `undefined` is returned and the streamed values stay.

### 6.2 v2 controller (`optimistic: boolean`, default true)

The v2 path does what v1 leaves to the caller (`sdk/src/stream/optimistic-input.ts:155-198`
and `controller.ts:2177-2238`, `2264-2346`):

```ts
// stream/optimistic-input.ts:40-43
export interface OptimisticHandle {
  readonly echoedIds: string[];
  readonly restoreKeys: OptimisticKeySnapshot[];
}
// stream/optimistic-input.ts:186-190
const id = extractId(entry) ?? mintId();
const dict = toDispatchDict(entry, id);
dispatchEntries.push(dict);
optimisticDicts.push(dict);
echoedIds.push(id);
```

```ts
// stream/controller.ts:2190-2195, 2212-2237
#beginOptimistic(input) {
  if (this.#options.optimistic === false) return undefined;
  ...
  const prepared = prepareOptimisticInput(input, this.#messagesKey, () => uuidv7());
  ...
  this.#sawValuesForRun = false;
  // Commit synchronously: this runs inside the user's `submit()` /
  // `respond()` call (before the first await), so the optimistic
  // message lands in the same tick — and therefore the same React /
  // framework commit — as any local UI state the caller flips
  // alongside it. ...
  this.#rootMessages.appendOptimistic(prepared.optimisticMessages, prepared.extraValues, { sync: true });
  if (prepared.echoedIds.length > 0) this.#messageMetadata.markPending(prepared.echoedIds);
  return { dispatchInput: prepared.dispatchInput, handle: { echoedIds: prepared.echoedIds, restoreKeys } };
}

// stream/controller.ts:2279-2291
#settleOptimistic(handle, event: "completed" | "failed" | "interrupted" | "aborted") {
  const failed = event === "failed" || event === "aborted";
  this.#messageMetadata.resolvePending(handle.echoedIds, failed ? "failed" : "sent");
  if (event !== "aborted" && !this.#sawValuesForRun) {
    this.#rootMessages.restoreValueKeys(handle.restoreKeys);
  }
}
```

So v2: **mint a client id (uuidv7) for id-less messages, send it to the server,
mark `pending`, flip to `sent` when a `values` snapshot echoes that id
(`controller.ts:2332-2341`), `failed` on error/abort; non-message keys are rolled
back if no server snapshot arrived.** The status is read through
`useMessageMetadata(stream, id).optimisticStatus` (doc at
`stream/types.ts:176-199`).

---

## 7. Branching — `fetchStateHistory`, `getMessagesMetadata`, `setBranch`

### 7.1 Fetching history

```ts
// react/stream.lgp.tsx:64-78
function fetchHistory<StateType>(client, threadId, options?: { limit?: boolean | number }) {
  if (options?.limit === false) {
    return client.threads.getState<StateType>(threadId).then((state) => {
      if (state.checkpoint == null) return [];
      return [state];
    });
  }
  const limit = typeof options?.limit === "number" ? options.limit : 10;
  return client.threads.getHistory<StateType>(threadId, { limit });
}
```

`historyLimit` is derived at `stream.lgp.tsx:289-293`:
`fetchStateHistory: {limit: n}` → `n`, `true` → `true` (10), `false`/undefined →
`false` (just `getState`). **Again the JSDoc says `@default true` but the code
defaults to `false`** (`options.fetchStateHistory ?? false`). `useThreadHistory`
(`stream.lgp.tsx:80-171`) is a tiny SWR: keyed by
`[clientConfigHash, threadId, limit]`, skipped while a submit for that thread is
in flight (`submittingRef`, `:150-157`), re-fetched via `mutate()` after every
successful run when history is enabled (`:632-640`, `:734-736`). An external
store can replace it via `options.thread` (`:295-305`).

### 7.2 The branch tree

`ui/branching.ts:36-149` `getBranchSequence(history)` builds a tree from
`parent_checkpoint.checkpoint_id → [children]`; forks are where a checkpoint has
2+ children; each fork child gets a `path: string[]` of checkpoint ids.
`getBranchView(sequence, paths, branch)` (`:160-213`) flattens ONE path
(`branch` is `path.join(">")`, `PATH_SEP = ">"`, root `"$"`, `:151-152`) into
`history: ThreadState[]` and a `branchByCheckpoint` map
`{ [checkpointId]: { branch, branchOptions } }`. `getBranchContext`
(`:215-232`) returns `{ branchTree, flatHistory, branchByCheckpoint, threadHead: flatHistory.at(-1) }`.

The hook keeps `branch` in `useState("")` (`stream.lgp.tsx:319-320`) and recomputes
`branchContext` every render. `setBranch` is literally that setter; `submit()`
resets the branch to the one owning `submitOptions.checkpoint` (`:490-496`) and,
when history is enabled, forks from `branchContext.threadHead.checkpoint`
(`:561-566`) — that is how "edit a message and resubmit from checkpoint X"
becomes a new sibling branch.

### 7.3 `getMessagesMetadata`

```ts
// react/stream.lgp.tsx:429-468 (history side)
const messageMetadata = (() => {
  const alreadyShown = new Set<string>();
  return getMessages(historyValues).map((message, idx) => {
    const messageId = message.id ?? idx;
    // Find the first checkpoint where the message was seen
    const firstSeenState = findLast(history.data ?? [], (state) =>
      state.values != null && getMessages(state.values).map((m, idx) => m.id ?? idx).includes(messageId));
    const checkpointId = firstSeenState?.checkpoint?.checkpoint_id;
    let branch = checkpointId != null ? branchContext.branchByCheckpoint[checkpointId] : undefined;
    if (!branch?.branch?.length) branch = undefined;
    // serialize branches
    const optionsShown = branch?.branchOptions?.flat(2).join(",");
    if (optionsShown) {
      if (alreadyShown.has(optionsShown)) branch = undefined;
      alreadyShown.add(optionsShown);
    }
    return { messageId: messageId.toString(), firstSeenState, branch: branch?.branch, branchOptions: branch?.branchOptions };
  });
})();

// react/stream.lgp.tsx:907-926 (merge with stream-time metadata)
getMessagesMetadata(message, index) {
  trackStreamMode("values");
  const streamMetadata = messageManager.get(message.id)?.metadata;
  const historyMetadata = messageMetadata?.find((m) => m.messageId === (message.id ?? index));
  if (streamMetadata != null || historyMetadata != null) {
    return { ...historyMetadata, streamMetadata } as MessageMetadata<StateType>;
  }
  return undefined;
},
```

`streamMetadata` is the second half of the `messages-tuple` event
(`types.stream.ts:57-62`: `data: [message: Message, config: MessageTupleMetadata]`),
stashed per message id by `MessageTupleManager.add`
(`ui/messages.ts:113-114`) — it is what carries `langgraph_node`,
`checkpoint_ns`, etc. during streaming, and it is explicitly not persisted.
The "show branch controls only on the first message of a fork" rule is the
`alreadyShown` set. All of this is O(history × messages) per render with no
memo — acceptable because `limit` is 10 by default.

---

## 8. Interrupts on the client

```ts
// react/stream.lgp.tsx:846-882
get interrupts(): Interrupt<InterruptType>[] {
  if (values != null && "__interrupt__" in values && Array.isArray(values.__interrupt__)) {
    return userFacingInterruptsFromValuesArray<InterruptType>(values.__interrupt__ as Interrupt<InterruptType>[]);
  }
  // If we're deferring to old interrupt detection logic, don't show the interrupt if the stream is loading
  if (stream.isLoading) return [];
  // Collect interrupts from ALL tasks (not just the last one)
  const allTasks = branchContext.threadHead?.tasks ?? [];
  const allInterrupts = allTasks.flatMap((t) => t.interrupts ?? []);
  const taskInterrupts = userFacingInterruptsFromThreadTasks<InterruptType>(allInterrupts as Interrupt<InterruptType>[]);
  if (taskInterrupts != null) return taskInterrupts;
  // check if there's a next task present (breakpoint-style interrupt)
  const next = branchContext.threadHead?.next ?? [];
  if (!next.length || error != null) return [];
  return [{ when: "breakpoint" }];
},
get interrupt() {
  const all = this.interrupts;
  if (all.length === 0) return undefined;
  if (all.length === 1) return all[0];
  // Multiple interrupts: return the array for backward compat
  return all as Interrupt<InterruptType>;
},
```

Three sources, in priority order: (1) the `__interrupt__` key the server puts in
a `values` event (the manager merges parallel-branch interrupts by id and clears
the previous run's at the first `values` of a new run — `manager.ts:936-1011`);
(2) when idle, `threadHead.tasks[].interrupts` from history; (3) a non-empty
`next` with no interrupt ⇒ synthetic `{ when: "breakpoint" }`. Headless-tool
interrupts are filtered out of the user-facing list (`ui/interrupts.ts:30-50`)
and auto-resumed by an effect (`stream.lgp.tsx:784-801`) that calls
`submit(null, { multitaskStrategy: "interrupt", command })`. `Interrupt` is
`{ id?: string; value?: T; ... }` (`schema.ts:163-172`).

---

## 9. Event callback ordering, `toolCalls` derivation, typing trick

### 9.1 Ordering inside one event

For every `{event, data}` the manager's loop (`manager.ts:792-1111`) runs, in
this fixed order, each gated by a prefix match (`matchEventType` at
`manager.ts:724-749`: `expected === actual || actual.startsWith(`${expected}|`)`,
the `|` suffix being the subgraph namespace):

1. `event === "error"` → `StreamError`, break (`:793-796`).
2. `namespace` parsed from `event.split("|").slice(1)` (`:798-800`).
3. `onMetadataEvent(data)` if `event === "metadata"`; `onLangChainEvent` if
   `"events"` (`:804-805`).
4. `updates` → `onUpdateEvent(data, { namespace, mutate })` then subagent
   bookkeeping (`:807-882`).
5. `custom` → `onCustomEvent(data, { namespace, mutate })` (`:884-886`).
6. `checkpoints` → `onCheckpointEvent`; `tasks` → `onTaskEvent`; `debug` →
   `onDebugEvent`; `tools` → `onToolEvent(data, { namespace, mutate })`
   (`:888-902`).
7. `values` → `setStreamValues` (interrupt-aware merge) (`:905-1011`).
8. `messages` (the `messages-tuple` tuple) → `MessageTupleManager.add` then
   `setStreamValues` writing `messages[index]` (`:1013-1111`).

Callbacks therefore fire **before** the state write for the same event, and
`mutate` (`manager.ts:710-722`) is the only sanctioned way for a callback to
touch `values` — `onCustomEvent` cannot see its own effect in `values` until
the next event. `onFinish`/`onSuccess` run after the loop (`:1113-1122`), and
`onError` only for non-abort errors (`:1124-1134`). Event callbacks are
**not** throttled — only React notifications are (§5).

`MetadataStreamEvent["data"]` is `{ run_id: string; thread_id: string }`
(`types.stream.ts:71-75`); `CustomStreamEvent<T>` is `{ event: "custom"; data: T }`
(`:108`) with `T` coming from `Bag["CustomEventType"]` (`ui/types.ts:1021-1025`).

### 9.2 `toolCalls` lifecycle

Pure function of the message list, recomputed on every read
(`stream.lgp.tsx:889-893`):

```ts
// utils/tools.ts:30-37
function computeToolCallState(result: ToolMessage | undefined, impliedCompleted: boolean): ToolCallState {
  if (result) return result.status === "error" ? "error" : "completed";
  if (impliedCompleted) return "completed";
  return "pending";
}
// utils/tools.ts:39-87
export function getToolCallsWithResults<ToolCall = DefaultToolCall>(messages: Message<ToolCall>[]): ToolCallWithResult<ToolCall>[] {
  const results = [];
  const toolResultsById = new Map<string, ToolMessage>();
  for (const msg of messages) if (msg.type === "tool") toolResultsById.set(msg.tool_call_id, msg);
  for (let msgIdx = 0; msgIdx < messages.length; msgIdx += 1) {
    const msg = messages[msgIdx];
    if (msg.type === "ai" && msg.tool_calls && msg.tool_calls.length > 0) {
      const aiMessage = msg as AIMessage<ToolCall>;
      let impliedCompleted = false;
      for (let j = msgIdx + 1; j < messages.length; j += 1) {
        if (messages[j].type === "ai") { impliedCompleted = true; break; }
      }
      for (let i = 0; i < aiMessage.tool_calls!.length; i += 1) {
        const call = aiMessage.tool_calls![i] as ToolCall & { id?: string };
        const callId = call.id as string | undefined;
        const result = callId ? toolResultsById.get(callId) : undefined;
        results.push({ id: callId ?? `${aiMessage.id ?? "unknown"}-${i}`, call, result, aiMessage, index: i,
                       state: computeToolCallState(result, impliedCompleted) });
      }
    }
  }
  return results;
}
```

`ToolCallWithResult` (`types.messages.ts:315-356`) is
`{ id; call; result: ToolMessage | undefined; aiMessage; index; state: "pending" | "completed" | "error" }`.
Note the heuristic: a later AI message **implies** completion even with no tool
result (tools that return `Command`s). The separate `toolProgress` array
(`stream.lgp.tsx:322-373`) is a `Map` keyed by `toolCallId ?? name` driven by
the `tools` stream-mode events `on_tool_start | on_tool_event | on_tool_end |
on_tool_error` → `starting | running | completed | error`. Two lifecycles,
two sources. v2 collapses them into `AssembledToolCall.status: "running" |
"finished" | "error"` (`client/stream/handles/tools.ts:11, 58-66`) reconciled
from `ToolMessage`s by `tool_call_id` (`stream/tool-calls.ts:31-61`).

### 9.3 The `useStream<typeof agent>` typing trick

The agent object carries a **phantom property** whose value type is the config:

```ts
// ui/types.ts:385-415
export interface AgentTypeConfigLike { Response: unknown; State: unknown; Context: unknown; Middleware: unknown; Tools: unknown; }
export type IsAgentLike<T> = T extends { "~agentTypes": AgentTypeConfigLike } ? true : false;
export type ExtractAgentConfig<T> = T extends { "~agentTypes": infer Config }
  ? Config extends AgentTypeConfigLike ? Config : never
  : never;
```

`InferStateType<T>` (`ui/stream/index.ts:75-87`) checks, in order,
`"~agentTypes"` (agent), `"~RunOutput"` (compiled graph), `"~OutputType"`
(Pregel), else treats `T` as the state itself. `InferAgentToolCalls<T>`
(`ui/types.ts:687-694`) maps `ExtractAgentConfig<T>["Tools"]` — an array of
`tool()` instances — through `ToolCallFromAgentTool` (`:655-668`), which keeps
only tools with a **literal** `name` and infers `args` from the tool's `_call`
or zod `schema` (`:611-634`), yielding a discriminated union
`{ name: "get_weather"; args: {...}; id?: string; type?: "tool_call" }`.
`ResolveStreamInterface<T, Bag>` (`ui/stream/index.ts:190-200`) then picks
`UseDeepAgentStream` / `UseAgentStream` / `BaseStream`, and
`ResolveStreamOptions` (`:228-233`) the matching options. The hook's first
overload (`react/stream.tsx:26-31`) is what makes `useStream<typeof agent>({...})`
resolve to typed `messages`, `toolCalls`, `subagents`. The SDK never imports
langchain — the phantom key is matched structurally. The same key is used in
`sdk-react` v2 (`sdk/src/stream/types-inference.ts`, re-exported at
`stream/index.ts:20-46`).

---

## 10. The v2 hook (`@langchain/react`) — what changed

- **Options** (`sdk/src/stream/types.ts:150-296`): a discriminated union
  `AgentServerOptions | CustomAdapterOptions` keyed on `transport` being
  `"sse" | "websocket" | undefined` vs an `AgentServerAdapter` instance. Common
  options are `threadId, onThreadId, onCreated, onCompleted, initialValues,
  messagesKey, tools, onTool, optimistic`. Server branch adds
  `assistantId, client, apiUrl, apiKey, callerOptions, defaultHeaders, transport,
  fetch, webSocketFactory, maxReconnectAttempts, streamIdleReconnect,
  reconnectDelayMs, onReconnect`. **Gone:** `reconnectOnMount`, `throttle`,
  `fetchStateHistory`, `thread`, `streamResumable`, all `on*Event` callbacks,
  `branch`/`history`.
- **Re-attach** (README `sdk-react/README.md:9`: "Session-based transport with
  automatic re-attach on remount; no more `reconnectOnMount` / `joinStream`
  dance"). Mechanism: the controller `hydrate()`s on construction / thread
  change (`sdk-react/src/use-stream.ts:613-636`), calls `threads.getState()`,
  decides `isThreadStateActive` from `next`/`tasks[].interrupts`
  (`stream/controller.ts:121-164`), and if active opens one persistent
  `client.threads.stream(threadId, {...})` (`controller.ts:1665-1674`). Nothing
  is persisted client-side: **the thread id is the only key, and the server
  owns the cursor** (inferred — the v2 wire is the lgwire card).
- **Return** (`sdk-react/src/use-stream.ts:69-390`): `values, messages
  (BaseMessage[]), toolCalls (AssembledToolCall[]), interrupts, interrupt,
  isLoading, isThreadLoading, hydrationPromise, error, threadId, subagents,
  subgraphs, subgraphsByNode, submit, stop, disconnect, respond, respondAll,
  client, assistantId, getThread, [STREAM_CONTROLLER]`. Four
  `useSyncExternalStore` reads over four stores (`:707-726`), one `useMemo`
  for the handle (`:728`).
- **Controller identity** is pinned in `useRef`s, explicitly not `useMemo`,
  because React may drop a memo and a recreated controller re-hydrates
  (`use-stream.ts:505-544, 553-611`); disposal is deferred one microtask via
  `controller.activate()` to survive StrictMode's mount/unmount/mount
  (`:638-649`).

---

## 11. For Pinecall

Pinecall's call log already has the property LangGraph v1 lacks — a per-log
`seq` cursor (`sdk/docs/guides/call-log.md` §"The entry envelope";
`webrtc/src/log/transport.ts:149-152` `cursor()` and `:280-284` the
`after=` URL). What to take from `useStream` is the **hook ergonomics**, not the
resume protocol.

1. **`throttle?: number | boolean` on `UseCallOptions` / `UseAgentCallsOptions`,
   implemented on the subscribe side, default `true`.** Copy
   `manager.ts:656-678` but make it a real throttle (leading edge + trailing
   flush, `setTimeout`, never rAF so it also works in tests/Node) and wrap
   `view.subscribe` in `useCall` (`webrtc/src/log/react.tsx:48-52`) — the
   reducer keeps applying every entry synchronously (dedupe by `seq` must not
   be delayed), only the `useSyncExternalStore` notification is coalesced.
   Keep LangGraph's honest semantics (`true` = one macrotask) and fix its two
   mistakes: doc/default mismatch (`stream.lgp.tsx:214` says `false`, JSDoc
   says `true`) and debounce-starvation with a numeric value.

   ```ts
   export interface UseCallOptions extends Omit<ObserveOptions, "call" | "agent"> {
     call: string;
     enabled?: boolean;
     /** Coalesce re-renders. `true` = one macrotask (default); `n` = at most one notify per n ms; `false` = every entry. */
     throttle?: number | boolean;
   }
   ```

2. **`reconnectOnMount?: boolean | (() => CallCursorStorage)`** — same shape as
   LangGraph (`ui/types.ts:1242, 1315-1319`), but what we persist is different
   and better: **key `pc:log:<call>` (call log) / `pc:log:agent:<slug>` (agent
   log) → value `{ seq: number, ts: number }` (JSON)**; `true` resolves to
   `sessionStorage` exactly like `stream.lgp.tsx:187`. On mount, seed
   `observe(view, { after: stored.seq })` so the first attach is
   `after=<lastSeq>` instead of `after=0` and the backlog replay is skipped.
   LangGraph cannot do this (it persists only `run_id` and rejoins with
   `Last-Event-ID: -1`, `stream.lgp.tsx:679`); we can, because `seq` is ours.
   Remove the key on `call.summary` (the log is sealed, `call-log.md` §"Design
   guarantees") — their `onSuccess` removal at `stream.lgp.tsx:630`. A
   `log.gap` after resume is already handled by the reducer's snapshot.

   ```ts
   interface CallCursorStorage {
     getItem(key: `pc:log:${string}`): string | null;
     setItem(key: `pc:log:${string}`, value: string): void;
     removeItem(key: `pc:log:${string}`): void;
   }
   reconnectOnMount?: boolean | (() => CallCursorStorage);
   ```

   What must NOT be copied: their one-shot `shouldReconnect` latch per thread
   (`stream.lgp.tsx:756-774`) exists because a join is a separate request; our
   `tail()` already reconnects with the cursor (`transport.ts:266-284`), so the
   stored cursor is only a *seed* for the first open and a write-through on
   every applied entry (cheap: one `setItem` per entry, or throttled with #1).

3. **`onEvent` callbacks, typed by entry type, called BEFORE the reducer applies
   the entry, never throttled.** LangGraph's rule (§9.1): callbacks see the
   event first, state second, and get a `mutate` to touch state. Ours:

   ```ts
   export interface UseCallOptions {
     /** Fires for every applied entry, in seq order, before React is notified. */
     onEntry?: (entry: AnyLogEntry) => void;
     /** Per-type listeners; the key is the `type` field of the envelope. */
     on?: { [K in LogEventType]?: (data: LogDataMap[K], entry: LogEntry<K>) => void } & {
       custom?: (entry: UnknownLogEntry) => void;   // any type outside LOG_EVENT_TYPES
     };
   }
   ```

   Wire it in `transport.ts` `applyFrame` (`:158-179`) via a `LogSink`
   decorator, so WS and poll paths share it (their single event loop at
   `manager.ts:792` is the reason ordering is deterministic). Skip `mutate`: our
   state is a reducer over an append-only log; a callback that wants to add
   state should `view.apply()` a local ephemeral entry instead.

4. **Typed custom entries = the `Bag` trick, not the agent-phantom trick.**
   `GetCustomEventType<Bag>` (`ui/types.ts:1021-1025`) is a single generic
   parameter that types `onCustomEvent`'s `data`. For us:
   `useCall<Custom extends Record<string, unknown> = {}>(opts)` where `Custom`
   maps custom `type` strings (e.g. `"crm.lookup"`) to their `data`, and
   `state.entries` / `on[...]` narrow on it. The `~agentTypes` phantom
   (`ui/types.ts:397-415`) is worth copying LATER on `pc.agent()` so
   `useCall<typeof agent>` infers the custom vocabulary an agent declares with
   `call.log("crm.lookup", data)` — same structural key, zero runtime cost.

5. **`toolCalls` with an explicit `state`.** Our `CallToolCall` already pairs
   `tool.call`/`tool.result` by id in the vendored reducer; add
   `state: "pending" | "completed" | "error"` computed like
   `utils/tools.ts:30-37` — but drop their "a later AI message implies
   completion" heuristic (`:61-67`): in a call log `turn.completed` is an
   explicit fact, so `pending` should flip only on `tool.result` or
   `call.ended`.

6. **Keep getters cheap and non-enumerable for the derived views** (the
   `Object.defineProperty(..., enumerable: false)` loop at
   `stream.lgp.tsx:954-971`). `useAgentCalls` recomputes `agentCalls(view.entries())`
   in a `useMemo` on every state change (`react.tsx:160`); fine today, but if we
   add `history`/`metrics` projections they should be lazy getters on the result.

7. **Do not copy:** `fetchStateHistory`/branching — a call has no forks; the
   cursor plus `GET /v1/calls/{id}/events?after=` is our history. `joinStream`
   as a public verb — `observe()` with `after` is already the join. Their
   `optimisticValues` — the log is server-authoritative; the only client-side
   optimism we need is for supervise verbs (`send({verb:"say"})`), and if we
   add it, use v2's shape (`controller.ts:2212-2237`): apply synchronously
   inside `send()`, mark `pending`, flip on the echoed entry, roll back on
   close — with the entry's `seq` absent until the server assigns it.

8. **Server-side filters.** LangGraph's only client filter is a predicate after
   the bytes arrive (`ui/utils.ts:27-36`), and its "filtering" is really the
   `streamMode` list derived from which getters were read
   (`stream.lgp.tsx:229-265`). The analogue worth copying is the *derivation*:
   `useAgentCalls` never reads transcripts, so its attach should ask for
   lifecycle types only (`?types=call.ringing,call.started,call.ended`), and
   `useCall` for `ephemeral=false` when `throttle` is high. Ship that as an
   explicit `types?: LogEventType[]` / `ephemeral?: boolean` on `CommonOptions`
   (`transport.ts:89-98`), threaded into the attach URL.

9. **`reconnectOnMount` and `enabled:false` must compose:** LangGraph resolves
   storage once per mount (`stream.lgp.tsx:183-190`); we should read the cursor
   when the effect actually opens (`react.tsx:68-86`), so a paused tile that is
   later enabled still resumes from its stored `seq`.

10. **Default-vs-doc drift is the most copied bug here** (`throttle` and
    `fetchStateHistory` both documented `true`, coded `false`). When we add
    `throttle`, the default goes in one place — `ObserveOptions` — and the doc
    page `call-log.md` quotes it from there.

# LangGraph stream modes, the StreamPart envelope, the custom writer, messages metadata

Research note for the *Streaming research* milestone (card `tk-3be42e`). Read-only:
nothing under `~/research/` or in Pinecall was modified. Every claim below cites a
path and line range in the shallow clones
`~/research/langgraph` (`f09cfe8`, 2026-08-20) and `~/research/langgraphjs`
(`f8bdf16`, 2026-08-21). Code is quoted, not paraphrased, wherever a shape matters.

**What is open source here.** Everything in this note is the OSS library:
`langgraph` (Python, `libs/langgraph/langgraph/`) and `@langchain/langgraph-core`
(TS, `libs/langgraph-core/src/`). The LangGraph *Platform* server that turns these
chunks into SSE, stores them, and serves `join_stream` is closed; the only
server-side wire code readable in these clones is the OSS `toEventStream()` helper
in `langgraph-core` (§8) and the SDK *clients*, which belong to card `tk-bbb6ed`
(`langgraph-platform-sse-wire.md`). Anything about what the hosted server does is
marked **inferred**.

Pinecall context read first: `sdk/docs/guides/call-log.md`,
`webrtc/src/log/{index.ts,react.tsx,transport.ts,agent.ts}`,
`sdk-server/src/pinecall/server/handlers/calls_api.py` (`/v1/attach`, lines
738-843) and `sdk-server/src/pinecall/session/call_log.py` (`CallLog`,
`_fan_out` 284-316, `DEFAULT_QUEUE_MAXSIZE = 256` at 61).

---

## 1. The mode vocabulary

### Python — `langgraph/types.py:122-141`

```python
StreamMode = Literal[
    "values", "updates", "checkpoints", "tasks", "debug", "messages", "custom"
]
"""How the stream method should emit outputs.

- `"values"`: Emit all values in the state after each step, including interrupts.
    When used with functional API, values are emitted once at the end of the workflow.
- `"updates"`: Emit only the node or task names and updates returned by the nodes or tasks after each step.
    If multiple updates are made in the same step (e.g. multiple nodes are run) then those updates are emitted separately.
- `"custom"`: Emit custom data using from inside nodes or tasks using `StreamWriter`.
- `"messages"`: Emit LLM messages token-by-token together with metadata for any LLM invocations inside nodes or tasks.
- `"checkpoints"`: Emit an event when a checkpoint is created, in the same format as returned by `get_state()`.
- `"tasks"`: Emit events when tasks start and finish, including their results and errors.
- `"debug"`: Emit `"checkpoints"` and `"tasks"` events for debugging purposes.
"""

StreamWriter = Callable[[Any], None]
"""`Callable` that accepts a single argument and writes it to the output stream.
Always injected into nodes if requested as a keyword argument, but it's a no-op
when not using `stream_mode="custom"`."""
```

An eighth mode, `"tools"`, exists in the engine but NOT in the `Literal`:
`pregel/main.py:2830` (`if "tools" in stream_modes:`) attaches
`StreamToolCallHandler` (`pregel/_tools.py:35-50`). It is a recent addition that the
type has not caught up with.

### TypeScript — `langgraph-core/src/pregel/types.ts:25-35`

```ts
export type StreamMode =
  | "values"
  | "updates"
  | "debug"
  | "messages"
  | "checkpoints"
  | "tasks"
  | "custom"
  | "tools";

export type Durability = "exit" | "async" | "sync";
```

`stream_mode` is a **set** (`str | Sequence[str]` → `set[StreamMode]`,
`main.py:2571-2578`; `streamMode: StreamMode[]` default `["values"]`,
`index.ts:518`, `594-597`). Filtering is done **at the producer**, not the consumer:
`PregelLoop._emit` returns early when the mode is not in `self.stream.modes`
(`_loop.py:1389-1391`; `loop.ts:1642`), and the `messages`/`tools`/`custom`
handlers are only installed if their mode was requested (`main.py:2811`, `2830`,
`2840`; `index.ts:2323`, `2340`, `2356-2357`). Nothing is produced and then
dropped, with one exception: the JS consumer loop re-checks
`streamMode.includes(mode)` (`index.ts:2497-2505`) because subgraph duplexing can
push a superset.

---

## 2. The internal chunk and the two envelopes

### The internal chunk is always a 3-tuple

Python, `pregel/protocol.py:272-288`:

```python
StreamChunk = tuple[tuple[str, ...], str, Any]


class StreamProtocol:
    __slots__ = ("modes", "__call__")

    modes: set[StreamMode]

    __call__: Callable[[Self, StreamChunk], None]

    def __init__(
        self,
        __call__: Callable[[StreamChunk], None],
        modes: set[StreamMode],
    ) -> None:
        self.__call__ = cast(Callable[[Self, StreamChunk], None], __call__)
        self.modes = modes
```

TS, `pregel/stream.ts:31-32`:

```ts
// [namespace, streamMode, payload]
export type StreamChunk = [string[], StreamMode, unknown];
```

Every producer — the loop (`_loop.py:1394`: `self.stream((self.checkpoint_ns, mode, v))`),
the messages handler (`_messages.py:106`: `self.stream((meta[0], "messages", (message, meta[1])))`),
the custom writer (`main.py:2842-2852`) — writes `(ns, mode, payload)` into ONE
queue. The public shape is decided only at the consumer end.

### v1: positional tuples — `pregel/main.py:4184-4242` (`_output`)

```python
def _output(
    stream_mode: StreamMode | Sequence[StreamMode],
    print_mode: StreamMode | Sequence[StreamMode],
    stream_subgraphs: bool,
    getter: Callable[[], tuple[tuple[str, ...], str, Any]],
    empty_exc: type[Exception],
    version: Literal["v1", "v2"] = "v1",
    output_mapper: Callable[[Any], Any] | None = None,
    state_mapper: Callable[[Any], Any] | None = None,
) -> Iterator:
    while True:
        try:
            ns, mode, payload = getter()
        except empty_exc:
            break
        ...
        if mode in stream_mode:
            if version == "v2":
                if mode == "values":
                    # pop __interrupt__ into typed field, coerce data
                    ints: tuple[Interrupt, ...] = ()
                    if isinstance(payload, dict):
                        ints = payload.pop(INTERRUPT, ())
                        if output_mapper:
                            payload = output_mapper(payload)
                    yield {"type": mode, "ns": ns, "data": payload, "interrupts": ints}
                elif mode in ("checkpoints", "debug"):
                    # coerce state values in checkpoint/debug payloads
                    if state_mapper:
                        _coerce_checkpoint_values(payload, state_mapper)
                    yield {"type": mode, "ns": ns, "data": payload}
                else:
                    yield {"type": mode, "ns": ns, "data": payload}
            elif stream_subgraphs and isinstance(stream_mode, list):
                yield (ns, mode, payload)
            elif isinstance(stream_mode, list):
                yield (mode, payload)
            elif stream_subgraphs:
                yield (ns, payload)
            else:
                yield payload
```

So v1 has FOUR shapes depending on two flags — `payload`, `(mode, payload)`,
`(ns, payload)`, `(ns, mode, payload)` — which is precisely the ergonomics problem
v2 fixes. The JS consumer does the same four-way branch at `index.ts:2518-2528`
(plus a fifth: `[null, mode, payload]` for `encoding: "text/event-stream"`,
`2506-2514`).

### v2: one dict, discriminated on `type` — `langgraph/types.py:264-352`

```python
class ValuesStreamPart(TypedDict, Generic[OutputT]):
    type: Literal["values"]
    ns: tuple[str, ...]
    data: OutputT
    interrupts: tuple[Interrupt, ...]


class UpdatesStreamPart(TypedDict):
    type: Literal["updates"]
    ns: tuple[str, ...]
    data: dict[str, Any]


class MessagesStreamPart(TypedDict):
    type: Literal["messages"]
    ns: tuple[str, ...]
    data: tuple[AnyMessage, dict[str, Any]]


class CustomStreamPart(TypedDict):
    type: Literal["custom"]
    ns: tuple[str, ...]
    data: Any


class CheckpointStreamPart(TypedDict, Generic[StateT]):
    type: Literal["checkpoints"]
    ns: tuple[str, ...]
    data: CheckpointPayload[StateT]


class TasksStreamPart(TypedDict):
    type: Literal["tasks"]
    ns: tuple[str, ...]
    data: TaskPayload | TaskResultPayload


class DebugStreamPart(TypedDict, Generic[StateT]):
    type: Literal["debug"]
    ns: tuple[str, ...]
    data: DebugPayload[StateT]


StreamPart = TypeAliasType(
    "StreamPart",
    ValuesStreamPart[OutputT]
    | UpdatesStreamPart
    | MessagesStreamPart
    | CustomStreamPart
    | CheckpointStreamPart[StateT]
    | TasksStreamPart
    | DebugStreamPart[StateT],
    type_params=(StateT, OutputT),
)
```

(docstrings elided; the file has them at the same lines). Two things to notice:
`ns` is ALWAYS present even when `subgraphs=False` (it is `()` for the root loop —
`_loop.py:367-371`), and `values` is the only part with an extra top-level key
(`interrupts`), pulled out of the payload in `_output` above. The JS library has
**no v2 dict envelope**; its only public shapes are the tuples in
`StreamOutputMap` (`pregel/types.ts:136-229`, e.g. `values: [string[], "values", StreamValues]`)
and the SSE encoding in §8.

### The subgraph namespace

`ns` is the checkpoint namespace split on `NS_SEP`: `_internal/_constants.py:87-89`
— `NS_SEP = sys.intern("|")`, `NS_END = sys.intern(":")`. Each element is
`"<node_name>:<task_id>"` (`_algo.py:1005-1012` builds `task_checkpoint_ns`; the
docstring at `main.py:2713-2718` gives the example
`("parent_node:<task_id>", "child_node:<task_id>")`). A child loop learns its ns from
its config and duplexes into the parent's queue:

`_loop.py:149-156` and `323-324`:

```python
def DuplexStream(*streams: StreamProtocol) -> StreamProtocol:
    def __call__(value: StreamChunk) -> None:
        for stream in streams:
            if value[1] in stream.modes:
                stream(value)

    return StreamProtocol(__call__, {mode for s in streams for mode in s.modes})
...
        if self.stream is not None and CONFIG_KEY_STREAM in config[CONF]:
            self.stream = DuplexStream(self.stream, config[CONF][CONFIG_KEY_STREAM])
```

The parent only publishes its stream into config when `subgraphs=True`
(`main.py:2933-2934`: `loop.config[CONF][CONFIG_KEY_STREAM] = loop.stream`; JS
`index.ts:2447-2452`; JS `createDuplexStream` at `stream.ts:446-461`). So
`subgraphs=False` is not a filter on the parent's side — the child simply never
gets a handle to the parent's queue. The `messages` handler does filter by ns
itself (§5).

---

## 3. What each mode emits, and when

All from `pregel/_loop.py` (Python); JS equivalents in `pregel/loop.ts` are cited
alongside. "Step" = one Pregel superstep (`tick()` → run tasks → `after_tick()`).

| mode | when | producer | payload mapper |
|---|---|---|---|
| `values` | once per step, **after** all writes applied, only if an output channel changed | `after_tick()` `_loop.py:699-707`; also at input (`_first`, `973-975`) and once more on interrupt exit (`1340-1365`) | `map_output_values` `_io.py:100-115` → `read_channels(channels, output_keys)` — the FULL state |
| `updates` | **per task**, as each finishes (not per step) | `output_writes()` `_loop.py:1416-1466` called from `PregelRunner.commit` | `map_output_updates` `_io.py:118-174` → `{node_name: writes}` |
| `tasks` | task *start*: per step in `tick()` `_loop.py:674` (and for pushed tasks `580`); task *result*: in `output_writes` `1461-1466` | same | `map_debug_tasks` `debug.py:41-71`, `map_debug_task_results` `debug.py:106-129` |
| `checkpoints` | start of each `tick()` if a checkpointer exists (`_checkpointer_put_after_previous is not None`) `_loop.py:631-648` | loop | `map_debug_checkpoint` `debug.py:144-209` — same shape as `get_state()` |
| `debug` | piggybacks: any `checkpoints` or `tasks` emission is ALSO wrapped when `"debug"` is in modes | `_emit` `_loop.py:1389-1414` | `{"step", "timestamp", "type": "checkpoint"\|"task"\|"task_result", "payload"}` |
| `messages` | per LLM token (callback `on_llm_new_token`) + per message found in node output (`on_chain_end`) | `StreamMessagesHandler` (callback, not the loop) | `(message, metadata)` |
| `custom` | whenever user code calls the writer | the node/tool | user value, verbatim |
| `tools` | tool start / output delta / end / error | `StreamToolCallHandler` | `{"event": "tool-started"\|"tool-output-delta"\|"tool-finished"\|"tool-error", "tool_call_id", ...}` |

### `updates` payload — `_io.py:118-174`

```python
def map_output_updates(
    output_channels: str | Sequence[str],
    tasks: list[tuple[PregelExecutableTask, Sequence[tuple[str, Any]]]],
    cached: bool = False,
) -> Iterator[dict[str, Any | dict[str, Any]]]:
    """Map pending writes (a sequence of tuples (channel, value)) to output chunk."""
    output_tasks = [
        (t, ww)
        for t, ww in tasks
        if (not t.config or TAG_HIDDEN not in t.config.get("tags", EMPTY_SEQ))
        and ww[0][0] != ERROR
        and ww[0][0] != INTERRUPT
    ]
    ...
    grouped: dict[str, Any] = {t.name: [] for t, _ in output_tasks}
    for node, value in updated:
        grouped[node].append(value)
    for node, value in grouped.items():
        if len(value) == 0:
            grouped[node] = None
        if len(value) == 1:
            grouped[node] = value[0]
    if cached:
        grouped["__metadata__"] = {"cached": cached}
    yield grouped
```

Interrupts ride `updates` as `{"__interrupt__": (...)}` (`_loop.py:1428-1442`) and
`values` as a key injected into the state dict (`1443-1451`) — which is why v2 pops
it back out into `interrupts`. Nodes tagged `langsmith:hidden` (`TAG_HIDDEN`,
`constants.py:26`) are excluded from `updates`, `tasks` and `messages`.

### `tasks` payloads — `types.py:143-178`

```python
class TaskPayload(TypedDict):
    id: str
    name: str
    input: Any
    triggers: list[str]
    metadata: NotRequired[dict[str, Any]]


class TaskResultPayload(TypedDict):
    id: str
    name: str
    error: str | None
    interrupts: list[dict]
    result: dict[str, Any]
```

`metadata` on the start event is the same filtered dict the `messages` stream
carries (`debug.py:54-69`: drops `EXCLUDED_METADATA_KEYS`, folds filtered tags in
under `"tags"`) — so the two streams share one metadata vocabulary.

### `checkpoints` payload — `types.py:203-219`

```python
class CheckpointPayload(TypedDict, Generic[StateT]):
    config: RunnableConfig | None
    metadata: CheckpointMetadata
    values: StateT
    next: list[str]
    parent_config: RunnableConfig | None
    tasks: list[CheckpointTask]
```

### `debug` wrapper — `_loop.py:1395-1414`

```python
            # "debug" mode is "checkpoints" or "tasks" with a wrapper dict
            if debug_remap:
                self.stream(
                    (
                        self.checkpoint_ns,
                        "debug",
                        {
                            "step": self.step - 1
                            if mode == "checkpoints"
                            else self.step,
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                            "type": "checkpoint"
                            if mode == "checkpoints"
                            else "task_result"
                            if "result" in v
                            else "task",
                            "payload": v,
                        },
                    )
                )
```

`debug` is the only mode with a timestamp. No other chunk carries time, sequence
or id — ordering is purely the queue's FIFO order, and there is **no cursor** at
this layer.

### `tools` payload (Python, `_tools.py:142-200`; JS `stream.ts:204-283`, type at `types.ts:78-104`)

Python emits `{"event": "tool-started", "tool_call_id", "tool_name", "input"?}`,
`{"event": "tool-output-delta", "tool_call_id", "delta"}`,
`{"event": "tool-finished", "tool_call_id", "output"}`,
`{"event": "tool-error", "tool_call_id", "message"}`. JS emits the older
`on_tool_start` / `on_tool_event` / `on_tool_end` / `on_tool_error` with
`toolCallId` / `name` / `input|data|output|error`. The two ports disagree on key
names — worth knowing before copying either.

---

## 4. The custom writer, traced end to end

**Python, sync (`stream()`):**

1. The consumer-side queue is created: `main.py:2748` `stream = SyncQueue()`
   (unbounded, `_internal/_queue.py:70-128`).
2. The writer closure is built only when `"custom"` was requested —
   `main.py:2840-2860`:

   ```python
            # set up custom stream mode
            if "custom" in stream_modes:

                def stream_writer(c: Any) -> None:
                    stream.put(
                        (
                            tuple(
                                get_config()[CONF][CONFIG_KEY_CHECKPOINT_NS].split(
                                    NS_SEP
                                )[:-1]
                            ),
                            "custom",
                            c,
                        )
                    )
            elif CONFIG_KEY_STREAM in config[CONF]:
                stream_writer = config[CONF][CONFIG_KEY_RUNTIME].stream_writer
            else:

                def stream_writer(c: Any) -> None:
                    pass
   ```

   The ns is computed **at call time** from the contextvar config (`get_config()`),
   dropping the trailing `node:task_id` segment — so one writer object serves every
   node and still tags each chunk with the emitting subgraph. The `elif` branch is
   how a subgraph reuses its parent's writer. The `else` is the documented no-op.
3. It is put on the `Runtime` dataclass: `main.py:2870-2880`
   `Runtime(context=..., store=store, stream_writer=stream_writer, ...)`; field at
   `runtime.py:206` `stream_writer: StreamWriter = field(default=_no_op_stream_writer)`;
   merge precedence at `runtime.py:240-250`. Runtime goes into
   `config[CONF][CONFIG_KEY_RUNTIME]` (`main.py:2882`).
4. `prepare_single_task` copies that runtime (overridden with per-task
   `execution_info`) into each task's config: `_algo.py:1044-1054`, `1094`.
5. Injection into the node function: `_internal/_runnable.py:168-185` declares
   the injectable kwargs —

   ```python
    (
        "writer",
        (StreamWriter, "StreamWriter", inspect.Parameter.empty),
        "stream_writer",
        lambda _: None,
    ),
   ```

   — `341-364` inspects the node signature once, and `392-420` resolves
   `getattr(runtime, "stream_writer")` at invoke time. So `def node(state, writer: StreamWriter)`
   receives it; `def node(state, runtime: Runtime)` gets `runtime.stream_writer`.
6. The implicit route: `config.py:126-195` `get_stream_writer()` →
   `get_config()[CONF][CONFIG_KEY_RUNTIME].stream_writer`. Works from any depth
   (tools, helpers) because config is a contextvar — with the documented caveat that
   async on Python < 3.11 loses it (`config.py:131-134`).
7. Consumer: `_output` (§2) pops `(ns, "custom", c)` and yields `c` (v1) or
   `{"type": "custom", "ns": ns, "data": c}` (v2).

**Python, async (`astream()`):** identical, except the queue is `AsyncQueue`
(`main.py:3156`) and every producer goes through
`aioloop.call_soon_threadsafe(stream.put_nowait, ...)` (`3158-3161`,
`3269-3296`) so a writer called from a worker thread is safe.

**TypeScript (`index.ts:2356-2367`):**

```ts
    config.writer ??= (chunk: unknown) => {
      if (!streamMode.includes("custom")) return;
      const ns = (
        getConfig()?.configurable?.[CONFIG_KEY_CHECKPOINT_NS] as
          | string
          | undefined
      )
        ?.split(CHECKPOINT_NAMESPACE_SEPARATOR)
        .slice(0, -1);

      stream.push([ns ?? [], "custom", chunk]);
    };
```

`??=` is the subgraph reuse; the `if` is the no-op. It lives directly on
`LangGraphRunnableConfig.writer` (`runnable_types.ts:72-75`: `/** Callback to send custom data chunks via the "custom" stream mode */`)
and is read by nodes as `config.writer(...)` or `getWriter(config?)`
(`utils/config.ts:311-327`, which falls back to `AsyncLocalStorage`).

**Takeaway:** the custom channel is (a) opt-in at subscribe time, (b) a no-op when
nobody subscribed — cheap to leave in production code, (c) namespaced
automatically from ambient context, (d) typed `Any`/`unknown` — the framework
imposes no schema and no size limit on `data`, and (e) exactly one user-facing
verb: `writer(value)`.

---

## 5. `messages`: the `(chunk, metadata)` tuple

### Shape

Python `types.py:288-299` (`data: tuple[AnyMessage, dict[str, Any]]`) and the
handler's emit at `_messages.py:97-106`:

```python
    def _emit(self, meta: Meta, message: BaseMessage, *, dedupe: bool = False) -> None:
        if dedupe and message.id in self.seen:
            return
        else:
            if message.id is None:
                message.id = str(uuid4())
            self.seen.add(message.id)
            self.stream((meta[0], "messages", (message, meta[1])))
```

with `Meta = tuple[tuple[str, ...], dict[str, Any]]` (`_messages.py:35`) —
`meta[0]` is the ns, `meta[1]` the metadata dict. JS: `pregel/types.ts:44`
`type StreamMessageOutput = [BaseMessage, Record<string, any>];`, emit at
`messages.ts:117` `this.streamFn([meta[0], "messages", [message, meta[1]]]);`.

### Where the metadata comes from

It is the **task's `config["metadata"]`**, captured at `on_chat_model_start` and
keyed by `run_id`. The keys are minted by `prepare_single_task`, `_algo.py:1005-1012`:

```python
    metadata = {
        "langgraph_step": step,
        "langgraph_node": packet.node,
        "langgraph_triggers": triggers,
        "langgraph_path": translated_task_path,
        "langgraph_checkpoint_ns": task_checkpoint_ns,
    }
```

plus user `proc.metadata` (`1015-1016`) and, on the root run,
`ls_integration: "langgraph"` (`main.py:2790-2791`). JS mints the same five and
additionally `checkpoint_ns` (`algo.ts:887-894`). JS also folds `tags` and `name`
into the dict (`messages.ts:31-47` `return [namespace.split("|"), { tags, name, ...metadata }];`).
Python folds only user tags, under `"tags"`, and only if any survive
(`_messages.py:146-147` → `filter_to_user_tags`, `_internal/_config.py:463-474`,
which drops `seq:step:*`).

### `on_chat_model_start` — the capture, the `nostream` opt-out and the ns filter

`_messages.py:130-149`:

```python
    def on_chat_model_start(
        self,
        serialized: dict[str, Any],
        messages: list[list[BaseMessage]],
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> Any:
        if metadata and (not tags or (TAG_NOSTREAM not in tags)):
            ns = tuple(cast(str, metadata["langgraph_checkpoint_ns"]).split(NS_SEP))[
                :-1
            ]
            if not self.subgraphs and len(ns) > 0 and ns != self.parent_ns:
                return
            if (filtered_tags := filter_to_user_tags(tags)) is not None:
                metadata["tags"] = filtered_tags
            self.metadata[run_id] = (ns, metadata)
```

`TAG_NOSTREAM = sys.intern("nostream")` (`constants.py:24`); JS
`TAG_NOSTREAM = "langsmith:nostream"` (`constants.ts:97`) and its handler accepts
both spellings (`messages.ts:133-135`: `!tags.includes(TAG_NOSTREAM) && !tags.includes("nostream")`).
The tag is a **per-LLM-call opt-out set by the producer** (`llm.with_config(tags=["nostream"])`) —
the consumer cannot ask for it; the run simply never enters `self.metadata`, so
neither its tokens (`on_llm_new_token`, `151-164`, requires `self.metadata.get(run_id)`)
nor its final message (`on_llm_end`, `166-178`) are emitted.

### Tokens vs. node outputs; dedupe by message id

Two sources feed the same mode: LLM token chunks (`on_llm_new_token` → `_emit(meta, chunk.message)`
without dedupe) and whole messages found in node return values (`on_chain_end`
`223-245` → `_find_and_emit_messages(..., dedupe=True)`). `on_chain_start`
(`191-221`) pre-seeds `self.seen` with the ids of messages already in the node's
*input*, so a node that returns its input messages unchanged does not re-emit
them. JS adds `stableMessageIdMap` (`messages.ts:88-108`) because some providers
only put the id on the first chunk. Tool-call chunks are ordinary `AIMessageChunk`s
carrying `tool_call_chunks` — nothing in the stream layer special-cases them; only
the emitted `ToolMessage` gets a synthesized id `run-${runId}-tool-${tool_call_id}`
(`messages.ts:91-94`).

### The v2 messages handler

`StreamMessagesHandlerV2` (`_messages.py:259-…`) is selected only when the internal
`CONFIG_KEY_STREAM_MESSAGES_V2` flag is set by a `StreamingHandler` (`main.py:2811-2823`);
it swaps `AIMessageChunk` tokens for the content-block *event* protocol. That is
the transport layer for the hosted server's v3 stream (card `tk-bbb6ed`), not the
library default.

---

## 6. Stream vs. checkpoints: durability

**The stream is ephemeral.** `StreamProtocol` / `IterableReadableWritableStream`
write into a process-local queue that is created per `stream()` call
(`main.py:2748`, `index.ts:2308-2310`) and closed when the generator ends
(`index.ts:2487-2490` `stream.close()` / `stream.error(loopError)`). Nothing in
`langgraph` persists a chunk, numbers it, or can replay it. A consumer that drops
mid-run cannot re-attach to the same run's stream at this layer.

**Checkpoints are the durable half**, and they are a *different* data structure:
a snapshot per superstep, written by `_put_checkpoint` (`_loop.py:1081-1140`),
readable later through `get_state()` / `get_state_history()` (`protocol.py:48-70`).
`stream_mode="checkpoints"` is the bridge: it emits, on the stream, exactly what
`get_state()` will return for that step (docstring `types.py:133`; mapper
`debug.py:144-209`). So a client that wants resumability subscribes to
`checkpoints` (or `values`) and, after a drop, calls `get_state_history` — it
rebuilds *state*, not the *event sequence*: `custom` and `messages` chunks are gone.

**`durability` controls when the snapshot is written, not whether the stream is**
— `types.py:89`, `main.py:2703-2709`:

```
- `"sync"`: Changes are persisted synchronously before the next step starts.
- `"async"`: Changes are persisted asynchronously while the next step executes.
- `"exit"`: Changes are persisted only when the graph exits.
```

Enforced at `_loop.py:1133-1135` (`do_checkpoint = ... and (exiting or self.durability != "exit")`)
and `main.py:2986-2987` (`if durability_ == "sync": loop._put_checkpoint_fut.result()`).
With `"exit"` the `checkpoints` mode stops emitting mid-run (the
`_checkpointer_put_after_previous` guard in `tick()`, `_loop.py:631`), which is the
one place a durability setting changes what the stream shows.

**JS v3 addition:** `_emitValuesWithCheckpointMeta` (`loop.ts:1702-1720`) pushes a
*lightweight* `checkpoints` envelope `{id, parent_id?, step, source}` before each
`values` chunk even when `checkpoints` was not requested, "so clients can build
branching / time-travel UIs without subscribing to a full-state `checkpoints`
stream" (`stream.ts:11-20`; `isCheckpointEnvelope` at `stream/convert.ts:42-51`).
That is the pattern "attach a tiny durable cursor to a live event", which is the
closest LangGraph gets to Pinecall's `seq`.

**Inferred (closed source):** the LangGraph Platform server must persist stream
chunks per run to offer `join_stream` / reconnect; the SDK types carry an optional
`id?: string` on every event (`sdk/src/types.stream.ts:33-39`). How it is stored and
how far back it replays cannot be read here — see `tk-bbb6ed`.

---

## 7. Queue and backpressure between producer and consumer

### Python

- **Unbounded, never blocks on put.** `SyncQueue.put` (`_internal/_queue.py:76-84`):
  `"""Put the item on the queue. The optional 'block' and 'timeout' arguments are ignored, as this method never blocks."""` —
  a `deque` plus a counting `Semaphore`. `AsyncQueue(asyncio.Queue)` (`12-41`) is
  constructed with no `maxsize`, i.e. unbounded.
- **The consumer drains between task completions, not per chunk.** `runner.tick()`
  is a generator that `yield`s control (`_runner.py:199`, `335`, `341`) each time a
  task finishes; `stream()` then calls `_output(...)` which loops `stream.get()` until
  `queue.Empty` (`main.py:2972-2983`, `_output` 4194-4198). After the loop ends, one
  final drain (`2990-2999`).
- **`get_waiter` makes token/custom chunks flow mid-task.** Only if
  `stream_eager or subgraphs or "messages" in stream_modes or "custom" in stream_modes`
  (`main.py:2936-2955`) does the runner also wait on `stream.wait()` — a future that
  resolves when the queue becomes non-empty *without consuming* (`_queue.py:106-114`).
  The runner treats it as one more future in `concurrent.futures.wait(FIRST_COMPLETED)`
  (`_runner.py:256-257`, `282-296`): when the waiter fires it yields, `_output`
  drains, and a new waiter is armed. Without it, `values`/`updates` would only be
  seen at task boundaries anyway, so the extra wake-ups are skipped.
- **Backpressure direction:** none from consumer to producer. A slow `for chunk in graph.stream(...)`
  body pauses the *whole* loop (the generator is not resumed, so `runner.tick()`
  is not resumed, so no new tasks are submitted) — but tasks already running keep
  pushing tokens/custom chunks into the unbounded queue. Memory is the only limit.
- **Multiple consumers:** there is exactly one. Fan-out is a consumer-side concern.

### TypeScript

`IterableReadableWritableStream` (`stream.ts:122-192`) wraps a WHATWG
`ReadableStream` with no explicit `highWaterMark`/queuing strategy — the default
count strategy, `highWaterMark: 1`, is advisory: `push()` calls
`controller.enqueue(chunk)` unconditionally (`163-176`) and never consults
`desiredSize`, so it is effectively unbounded too. `push` silently drops after
`close()`/`error()` (`167-172`: "Silently drop chunks when stream is closed - this is expected behavior when async operations try to push after stream termination").
The consumer is `for await (const chunk of stream)` in `_streamIterator`
(`index.ts:2493-2530`) running concurrently with `createAndRunLoop()` — a real
producer/consumer split via the stream's internal queue; in the sync Python path
producer and consumer interleave on one thread (the yields above), in `astream`
via `call_soon_threadsafe`.

---

## 8. The one OSS wire encoding: `toEventStream`

`langgraph-core/src/pregel/stream.ts:397-444` — used when `stream(input, { encoding: "text/event-stream" })`
(`index.ts:2034-2035`, `2107`):

```ts
export function toEventStream(stream: AsyncGenerator) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueueChunk = (sse: {
        id?: string;
        event: string;
        data: unknown;
      }) => {
        controller.enqueue(
          encoder.encode(
            `event: ${sse.event}\ndata: ${_stringifyAsDict(sse.data)}\n\n`
          )
        );
      };

      try {
        for await (const payload of stream) {
          const [ns, mode, chunk] = payload as AnyStreamOutput;
          ...
          const event = ns?.length ? `${mode}|${ns.join("|")}` : mode;
          enqueueChunk({ event, data });
        }
      } catch (error) {
        enqueueChunk({ event: "error", data: _serializeError(error) });
      }

      controller.close();
    },
  });
}
```

Two facts for the wire card: the SSE `event:` field IS the mode, with the subgraph
ns appended as `mode|a:id|b:id` (the SDK's `AsSubgraph<…>` type mirrors this:
`sdk/src/types.stream.ts:33-39` — ``event: TEvent["event"] | `${TEvent["event"]}|${string}` ``);
and `id?` is declared but **never set** by this OSS encoder — no `id:` line, so no
`Last-Event-ID` resume from the library alone. Errors are an `event: error` frame,
not an HTTP failure.

---

## 9. Summary of the design decisions

1. **Mode = subscription filter applied at the producer.** `stream_mode` is a set;
   handlers are installed only for requested modes; the loop's `_emit` short-circuits.
2. **One internal tuple `(ns, mode, payload)`, one queue, many public shapes.**
   v2 fixes the shape explosion with `{type, ns, data}` and keeps `ns` always present.
3. **Custom channel = one verb, no schema, no-op when unsubscribed, ns from ambient context.**
4. **`messages` metadata = the task's config metadata** (`langgraph_node`, `langgraph_step`,
   `langgraph_triggers`, `langgraph_path`, `langgraph_checkpoint_ns`, user keys, filtered `tags`);
   `nostream` is a producer-side tag, not a consumer filter.
5. **Stream ephemeral, checkpoints durable, `checkpoints` mode bridges them;** no seq,
   no replay of events; `durability` only moves *when* snapshots are written.
6. **Unbounded queue, no backpressure; the only pacing is the consumer not resuming the loop.**

---

## For Pinecall

Counterparts: attach handler `sdk-server/src/pinecall/server/handlers/calls_api.py`
(`attach` 738-843, `_pump_tail` 705-735, `_attach_backlog` 664-688), `CallLog`
(`session/call_log.py`), client `@pinecall/web/log` (`transport.ts` `tail()` 196-330,
`applyFrame` 157-178), hooks `useCall`/`useAgentCalls` (`react.tsx`), envelope in
`sdk/docs/guides/call-log.md`.

1. **Copy the principle "filter at the producer, per subscriber", not the
   mechanism.** LangGraph has one consumer per run and installs handlers per
   requested mode. Pinecall has N subscribers on one `CallLog`, so the filter belongs
   on the `Subscriber` (`call_log.py:123`) and in `_pump_tail` / `_attach_backlog`,
   never on `append` — §5 of our spec ("observers never slow the call") is the same
   invariant `_emit`'s early return serves. A `types=` query parameter on
   `WS /v1/attach` (and on `GET /v1/calls/{id}/events`) is the direct analogue of
   `stream_mode`: comma-separated closed-vocabulary values, server drops
   non-matching entries before `send_json`. It must NOT change `seq` numbering —
   the cursor stays the log's, gaps in the client's view are by request. `log.caught_up`
   and `log.gap` must always pass regardless of filter (they are control, like
   LangGraph's `isCheckpointEnvelope` bypass in `createDuplexStream`, `stream.ts:452-456`).
2. **`durable=` is our `ephemeral` flag seen from the consumer; worth adding, cheap.**
   LangGraph has no consumer-side equivalent — `nostream` is producer-side — but our
   envelope already carries `ephemeral: bool` and `since()` already strips ephemerals
   from the backlog (`call_log.py:350-351`). `durable=1` on attach = "also skip
   ephemerals in the live tail" — one `if entry.ephemeral and durable_only: continue`
   in `_pump_tail`. Document it as a bandwidth knob, not a semantic one: the durable
   entry that supersedes an ephemeral always follows (call-log.md "The entry envelope").
3. **Copy the v2 envelope discipline exactly — we already have it, keep it closed.**
   `{type, ns, data}` with a discriminated `type` is our `{seq, ts, call, agent, type, ephemeral, data}`.
   LangGraph's lesson from v1 → v2 is: never vary the *shape* by request flags
   (`_output`'s four tuple shapes). So `types=`/`durable=` must filter entries, never
   reshape them; `applyFrame` (`transport.ts:157-178`) must keep working unchanged.
4. **`call.log(type, data)` — copy the custom writer's contract: one verb, data is
   opaque, no-op costs nothing, namespace is implicit.** Concretely: a new closed-vocabulary
   entry type (proposal: `type: "custom"`, `data: {name: string, payload: any}` —
   mirroring `CustomStreamPart.data: Any` but keeping OUR `type` closed so
   `isKnownLogEntry` and the reducer stay total; the user's `type` argument lands in
   `data.name`, the way LangGraph keeps the user value under `data` and the mode
   under `type`). It appends through `CallLog.try_append` like any other entry, gets a
   real `seq`, is durable by default (`ephemeral=false`) and therefore replays —
   **strictly better than LangGraph**, whose custom chunks are ephemeral (§6). Offer
   `call.log(name, data, {ephemeral: true})` for high-rate telemetry. On the SDK side
   the agent's `call` object is the "ambient context" LangGraph gets from
   `get_config()`; no contextvar machinery needed. Size-limit `data` on the server
   (LangGraph does not; we have a hot buffer and a 256-entry subscriber queue to protect).
5. **Skip `subgraphs`/`ns`.** A call has no nesting; `call`/`agent` in the
   envelope already give the two levels we have (call log vs agent log). Do not add
   a namespace tuple.
6. **Skip the per-token `messages` tuple; keep our `bot.message`/`bot.word` entries,
   but copy the metadata idea minimally.** LangGraph attaches the *task's* metadata
   (`langgraph_node`, `langgraph_step`, tags) to every token so a UI can group by
   producer. Our analogue is which turn / which tool a `custom` entry belongs to:
   `call.log` should stamp `data.turn` (the current turn id, if the server knows it)
   server-side, the way `prepare_single_task` stamps `langgraph_step`. Do not let the
   caller forge it.
7. **Skip `nostream` as a consumer feature; it is already covered.** Its job (hide an
   internal LLM call from the token stream) is producer-side; ours is `ephemeral`
   plus the closed vocabulary. Nothing to add.
8. **Do not copy the queue model.** LangGraph: unbounded queue, one consumer, no
   backpressure, memory is the limit — acceptable for one run in one process. Ours
   (`DEFAULT_QUEUE_MAXSIZE = 256`, `QueueFull` → drop → `slow_consumer` close → client
   re-attaches with `after=`, `call_log.py:284-316`, `transport.ts:314-316`) is the
   right model for N observers of live media. Keep it; `types=` filtering makes it
   strictly better (a dashboard that only wants lifecycle types never fills its queue
   with word timings).
9. **The durable-cursor-on-a-live-event trick (JS `_emitValuesWithCheckpointMeta`)
   is what `seq` already is.** Nothing to add — but it confirms the SSE attach card
   (`tk-bbb6ed`) should put `seq` in the SSE `id:` line, since the OSS encoder
   declares `id?` and never fills it; we can.
10. **`useCall` ergonomics:** LangGraph's library gives no hook; nothing to copy
    here. The SDK React hook is the other card's. What *does* carry over: `types=`
    belongs in `UseCallOptions`/`ObserveOptions` next to `after`, and must be in the
    effect's dependency list (`react.tsx:83`) since it addresses a different stream.

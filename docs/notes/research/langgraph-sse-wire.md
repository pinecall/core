# LangGraph Platform — SSE wire + resume, from the open code

Card tk-bbb6ed · milestone "Streaming research" · 2026-08-23

Sources (shallow clones, read-only):

| repo | commit | what it is |
|---|---|---|
| `~/research/langgraphjs` | `f8bdf16` (2026-08-21) | JS SDK (`libs/sdk`), **and the JS dev server `libs/langgraph-api`** |
| `~/research/langgraph` | `f09cfe8` (2026-08-20) | Python SDK (`libs/sdk-py`) |
| `~/research/streaming-cookbook` | `8c63965` (2026-07-16) | runnable examples; the React reconnect demo |

## 0. What is open and what is not

- **Open (MIT):** the JS SDK `@langchain/langgraph-sdk` (`langgraphjs/libs/sdk`), the Python SDK `langgraph_sdk` (`langgraph/libs/sdk-py`), the OSS graph library, and — important — **`@langchain/langgraph-api`** (`langgraphjs/libs/langgraph-api/package.json:1-12`, `"license": "MIT"`), the in-memory server that `langgraph dev` runs for JS projects. It implements `/runs/stream`, `/threads/:id/runs/:run_id/stream`, `Last-Event-ID`, `stream_resumable`, `on_disconnect`, multitask strategies. So for the JS dev server the *server* side is readable.
- **Closed:** the hosted **LangGraph Platform** server and the Python `langgraph-api` wheel that `langgraph dev` uses for Python projects. Anything about their behaviour below is labelled **inferred from client** or **mirrors the JS dev server**. Where the closed server is known to differ (e.g. `: heartbeat` comments every ~5 s, Redis-backed replay) the evidence is a client comment, quoted.

Two protocols coexist in the JS SDK and both matter:

1. **Legacy SSE** — `client.runs.stream()` / `client.runs.joinStream()`, `event:` = stream mode, `id:` = integer index, resume via `Last-Event-ID`. This is what the card asks about. §1–§5.
2. **Protocol v2** ("agent-server protocol", `client/stream/`, `@langchain/protocol`) — JSON envelopes with `seq` + `event_id`, channel subscriptions, `since=`. Much closer to the Pinecall call log. §6.

---

## 1. SSE framing

### 1.1 The decoder (client) — JS

`langgraphjs/libs/sdk/src/utils/sse.ts:93-160`, verbatim:

```ts
export interface StreamPart {
  id: string | undefined;
  event: string;
  data: unknown;
}

export function SSEDecoder() {
  let event = "";
  let data: Uint8Array[] = [];
  let lastEventId = "";
  let retry: number | null = null;

  const decoder = new TextDecoder();

  return new TransformStream<Uint8Array, StreamPart>({
    transform(chunk, controller) {
      // Handle empty line case
      if (!chunk.length) {
        if (!event && !data.length && !lastEventId && retry == null) return;

        const sse = {
          id: lastEventId || undefined,
          event,
          data: data.length ? decodeArraysToJson(decoder, data) : null,
        };

        // NOTE: as per the SSE spec, do not reset lastEventId
        event = "";
        data = [];
        retry = null;

        controller.enqueue(sse);
        return;
      }

      // Ignore comments
      if (chunk[0] === COLON) return;

      const sepIdx = chunk.indexOf(COLON);
      if (sepIdx === -1) return;

      const fieldName = decoder.decode(chunk.subarray(0, sepIdx));
      let value = chunk.subarray(sepIdx + 1);
      if (value[0] === SPACE) value = value.subarray(1);

      if (fieldName === "event") {
        event = decoder.decode(value);
      } else if (fieldName === "data") {
        data.push(value);
      } else if (fieldName === "id") {
        if (value.indexOf(NULL) === -1) lastEventId = decoder.decode(value);
      } else if (fieldName === "retry") {
        const retryNum = Number.parseInt(decoder.decode(value), 10);
        if (!Number.isNaN(retryNum)) retry = retryNum;
      }
    },
    ...
```

Facts pinned by that code:

- `data:` is **always JSON** — `decodeArraysToJson` = `JSON.parse(decoder.decode(joinArrays(data)))` (`sse.ts:173-175`). Multi-line `data:` is concatenated byte-wise (no `\n` re-inserted, unlike the WHATWG spec) and parsed once.
- `id:` is sticky across events ("as per the SSE spec, do not reset lastEventId", `sse.ts:119`). An event with no `id:` line inherits the previous one in `StreamPart.id`.
- `:` comment lines are **dropped by the SSE decoder** (`sse.ts:129`) but **seen by the idle watchdog** which sits on the line stream *before* it (`utils/stream.ts:207-215`, quoted in §2.4). That is how heartbeats drive liveness without reaching the app.
- Line splitting is its own `BytesLineDecoder` (`sse.ts:9-91`) that honours `\r`, `\n` and `\r\n` (a port of httpx's universal-newlines logic; the Python file literally says "Adapted from httpx_sse", `langgraph/libs/sdk-py/langgraph_sdk/sse.py:1`).
- The last event is flushed without a trailing blank line if `event` was set (`sse.ts:150-158`).

### 1.2 The decoder (client) — Python

`langgraph/libs/sdk-py/langgraph_sdk/sse.py:78-139` is the same machine; the `StreamPart` is a `NamedTuple` (`schema.py:595-603`):

```py
class StreamPart(NamedTuple):
    """Represents a part of a stream response."""

    event: str
    """The type of event for this stream part."""
    data: dict
    """The data payload associated with the event."""
    id: str | None = None
    """The ID of the event."""
```

`decode()` at `sse.py:91-139`: blank line → emit `StreamPart(event, orjson.loads(data) or None, id=last_event_id)`; `:`-prefixed → `None`; `id:` ignored if it contains `\0`; unknown fields ignored.

### 1.3 The encoder (server) — JS dev server (OPEN)

`langgraphjs/libs/langgraph-api/src/api/runs.mts:446-481`:

```ts
api.get(
  "/threads/:thread_id/runs/:run_id/stream",
  zValidator("param", z.object({ thread_id: z.string().uuid(), run_id: z.string().uuid() })),
  zValidator("query", z.object({ cancel_on_disconnect: schemas.coercedBoolean.optional() })),
  async (c) => {
    // Stream Run Http
    const { thread_id, run_id } = c.req.valid("param");
    const { cancel_on_disconnect } = c.req.valid("query");
    const lastEventId = c.req.header("Last-Event-ID") || undefined;

    return streamSSE(c, async (stream) => {
      const signal = cancel_on_disconnect
        ? getDisconnectAbortSignal(c, stream)
        : undefined;

      for await (const { id, event, data } of runs().stream.join(
        run_id,
        thread_id,
        { signal, cancelOnDisconnect: signal != null, lastEventId },
        c.var.auth
      )) {
        await stream.writeSSE({ id, data: serialiseAsDict(data), event });
      }
    });
  }
);
```

So every frame is `id: <n>` / `event: <mode>` / `data: <json>` written with Hono's `streamSSE.writeSSE`. The run-creating `POST …/runs/stream` is the same loop (`runs.mts:341-380`) with `lastEventId: run.kwargs.resumable ? "-1" : undefined` (line 369) — i.e. a resumable stream is opened from *before the first event* so the creating client also gets ids.

**What goes in `event:`** — the stream mode name, optionally suffixed with the subgraph namespace. Producer: `langgraph-api/src/stream.mts:206-209` emits the first frame

```ts
  yield {
    event: "metadata",
    data: { run_id: run.run_id, attempt: options.attempt },
  };
```

then per chunk (`stream.mts:327-341`):

```ts
      if (mode === "messages") {
        if (userStreamMode.includes("messages-tuple")) {
          if (kwargs.subgraphs && ns?.length) {
            yield { event: `messages|${ns.join("|")}`, data };
          } else {
            yield { event: "messages", data };
          }
        }
      } else if (userStreamMode.includes(mode)) {
        const sseEvent =
          kwargs.subgraphs && ns?.length ? `${mode}|${ns.join("|")}` : mode;
        yield { event: sseEvent, data };
      }
    } else if (userStreamMode.includes("events")) {
      yield { event: "events", data: event };
    }
```

Errors are published as `event: "error"` by the worker (`langgraph-api/src/queue.mts:89-98`):

```ts
    } catch (error) {
      if (!isInterrupted()) {
        await ops.runs.stream.publish({
          runId,
          resumable,
          event: "error",
          data: serializeError(error),
        });
      }
      throw error;
    }
```

Legacy `messages` mode is three event names: `messages/metadata`, `messages/partial`, `messages/complete` (`stream.mts:380-400`). There is **no `end` event** in the legacy wire: the JS dev server's join loop simply returns when the run is no longer `pending`/`running` (`ops.mts:1837-1838`, quoted in §2.2), and the client's `for await` ends on stream close.

**What goes in `id:`** — the 0-based index of the event in the run's in-memory log, as a decimal string. `langgraph-api/src/storage/ops.mts:79-122`:

```ts
class Queue {
  private log: Message[] = [];
  private listeners: ((idx: number) => void)[] = [];

  private nextId = 0;
  private resumable = false;

  constructor(options: { resumable: boolean }) {
    this.resumable = options.resumable;
  }

  push(item: Message) {
    this.log.push(item);
    for (const listener of this.listeners) listener(this.nextId);
    this.nextId += 1;
  }

  async get(options: {
    timeout: number;
    lastEventId?: string;
    signal?: AbortSignal;
  }): Promise<[id: string, message: Message]> {
    if (this.resumable) {
      const lastEventId = options.lastEventId;

      // Generator stores internal state of the read head index,
      let targetId = lastEventId != null ? +lastEventId + 1 : null;
      if (
        targetId == null ||
        isNaN(targetId) ||
        targetId < 0 ||
        targetId >= this.log.length
      ) {
        targetId = null;
      }

      if (targetId != null) return [String(targetId), this.log[targetId]];
    } else {
      if (this.log.length) {
        const nextId = this.nextId - this.log.length;
        const nextItem = this.log.shift()!;
        return [String(nextId), nextItem];
      }
    }
```

Non-resumable queues `shift()` (consume-once); resumable ones keep the whole log and serve `lastEventId + 1`. Note the degenerate case: a `Last-Event-ID` **beyond** the log (`targetId >= this.log.length`) silently becomes "wait for the next push" — there is no gap signal and no error.

**Heartbeats.** The JS dev server's SSE path writes no heartbeat at all (grep of `heartbeat|keepalive` in `langgraph-api/src` → nothing on the SSE path; the only keep-alive is `waitKeepAlive` writing `"\n"` every second on the non-SSE `/runs/wait` endpoint, `utils/hono.mts:11-26`). The hosted Platform does send one — **inferred from client**: `langgraphjs/libs/sdk/src/types.ts:198-200`:

```ts
   * - `"auto"` (default): the client watches for the server's SSE keep-alive
   *   heartbeats (LangGraph Platform sends `: heartbeat` every ~5s) and only
   *   arms idle detection once it has observed them, sizing the window from
```

That is an SSE **comment** line (`: heartbeat`), invisible to the SSE decoder, not a data event.

**Headers the client sends** (Python, `langgraph/libs/sdk-py/langgraph_sdk/_async/http.py:198-200`): `Accept: text/event-stream`, `Cache-Control: no-store`. Both SDKs refuse a response whose `Content-Type` does not contain `text/event-stream` (`utils/stream.ts:264-269`; `_async/http.py:240-245`).

---

## 2. Resume semantics

### 2.1 `joinStream` — signatures, verbatim

JS, `langgraphjs/libs/sdk/src/client/runs/index.ts:404-455`:

```ts
  async *joinStream(
    threadId: string | undefined | null,
    runId: string,
    options?:
      | {
          signal?: AbortSignal;
          cancelOnDisconnect?: boolean;
          lastEventId?: string;
          streamMode?: StreamMode | StreamMode[];
          /**
           * Idle-reconnect policy.
           *
           * Guards against half-open sockets that hang with no
           * error or close; on idle the read re-joins with the last seen
           * `Last-Event-ID`.
           *
           * - `"auto"` (default): arms only once the
           * server's keep-alive heartbeats are observed and sizes the window
           * from their cadence;
           * - a `number`: a fixed idle window in ms;
           * - `0`: disables it.
           */
          streamIdleReconnect?: IdleReconnectMode;
        }
      | AbortSignal
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): AsyncGenerator<{ id?: string; event: StreamEvent; data: any }> {
    const opts =
      typeof options === "object" &&
      options != null &&
      // eslint-disable-next-line no-instanceof/no-instanceof
      options instanceof AbortSignal
        ? { signal: options }
        : options;

    yield* this.streamWithRetry({
      endpoint:
        threadId != null
          ? `/threads/${threadId}/runs/${runId}/stream`
          : `/runs/${runId}/stream`,
      method: "GET",
      signal: opts?.signal,
      idleReconnect: opts?.streamIdleReconnect,
      headers: opts?.lastEventId
        ? { "Last-Event-ID": opts.lastEventId }
        : undefined,
      params: {
        cancel_on_disconnect: opts?.cancelOnDisconnect ? "1" : "0",
        stream_mode: opts?.streamMode,
      },
    });
  }
```

Python, `langgraph/libs/sdk-py/langgraph_sdk/_async/runs.py:1097-1154`:

```py
    def join_stream(
        self,
        thread_id: str,
        run_id: str,
        *,
        cancel_on_disconnect: bool = False,
        stream_mode: StreamMode | Sequence[StreamMode] | None = None,
        headers: Mapping[str, str] | None = None,
        params: QueryParamTypes | None = None,
        last_event_id: str | None = None,
    ) -> AsyncIterator[StreamPart]:
        """Stream output from a run in real-time, until the run is done.
        Output is not buffered, so any output produced before this call will
        not be received here.
        ...
        """
        query_params = {
            "cancel_on_disconnect": cancel_on_disconnect,
            "stream_mode": stream_mode,
        }
        if params:
            query_params.update(params)
        return self.http.stream(
            f"/threads/{_quote_path_param(thread_id)}/runs/{_quote_path_param(run_id)}/stream",
            "GET",
            params=query_params,
            headers={
                **({"Last-Event-ID": last_event_id} if last_event_id else {}),
                **(headers or {}),
            }
            or None,
        )
```

(The Python docstring "Output is not buffered" predates `stream_resumable`; with a resumable run and `last_event_id` the JS dev server *does* replay, `ops.mts:101-115`.)

What each option does:

| option | wire | effect (JS dev server, OPEN) |
|---|---|---|
| `lastEventId` | `Last-Event-ID: <n>` request header | server serves log index `n+1` onward (`ops.mts:105-115`). **`"-1"` means "from the very first event"** — the React hook defaults to it: `react/stream.lgp.tsx:679` `lastEventId ??= "-1";` |
| `cancelOnDisconnect` | `?cancel_on_disconnect=1` | server aborts the join on client disconnect and calls `runs.cancel(threadId,[runId],{action:"interrupt"})` (`ops.mts:1843-1849`) |
| `streamMode` | `?stream_mode=` | filter to a subset of the modes the run was created with (Python docstring `runs.py:1116-1118`; the JS dev server ignores it — `runs.mts:446-481` only validates `cancel_on_disconnect`) |
| `streamIdleReconnect` | (client only) | half-open detection, §2.4 |

### 2.2 What the server does with `Last-Event-ID` (JS dev server, OPEN)

`langgraph-api/src/storage/ops.mts:1759-1851`:

```ts
    async *join(
      runId: string,
      threadId: string | undefined,
      options: {
        ignore404?: boolean;
        signal?: AbortSignal;
        cancelOnDisconnect?: boolean;
        lastEventId: string | undefined;
      },
      auth: AuthContext | undefined
    ): AsyncGenerator<{
      id?: string;
      event: string;
      data: unknown;
      normalized?: boolean;
    }> {
      ...
        const queue = StreamManager.getQueue(runId, {
          ifNotFound: "create",
          resumable: options.lastEventId != null,
        });
      ...
        let lastEventId = options?.lastEventId;
        while (!signal?.aborted) {
          try {
            const [id, message] = await queue.get({
              timeout: 500,
              signal,
              lastEventId,
            });

            lastEventId = id;

            if (message.topic === `run:${runId}:control`) {
              if (message.data === "done") break;
            } else {
              const streamTopic = message.topic.substring(
                `run:${runId}:stream:`.length
              );

              yield {
                id,
                event: streamTopic,
                data: message.data,
                ...
              };
            }
          } catch (error) {
            if (error instanceof AbortError) break;

            const run = await runs.get(runId, threadId, auth);
            if (run == null) {
              if (!options?.ignore404)
                yield { event: "error", data: "Run not found" };
              break;
            } else if (run.status !== "pending" && run.status !== "running") {
              break;
            }
          }
        }

        if (
          signal?.aborted &&
          options?.cancelOnDisconnect &&
          threadId != null
        ) {
          await runs.cancel(threadId, [runId], { action: "interrupt" }, auth);
        }
```

Read that carefully against Pinecall's model:

- The cursor is **per run**, 0-based, and the reader loop is "give me index `last+1`, else block ≤ 500 ms, else check if the run is still alive". End-of-stream is *not* a frame; it is "the run's status left `pending|running` and the queue is drained".
- `resumable` is decided **by whoever touches the queue first** (`getQueue(... resumable: options.lastEventId != null)` vs `publish(... resumable: payload.resumable)`, `ops.mts:1860-1863`), because `getQueue` only honours the option on creation (`ops.mts:173-175`). In the dev server that is the run creator (`createValidRun` passes `resumable: run.stream_resumable ?? false`, `runs.mts:95`).
- A non-resumable queue **consumes** on read (`log.shift()`), so two joiners race for each event and a late joiner sees only what is left. This is exactly the "no buffering" the Python docstring warns about.
- **No gap semantics.** There is no equivalent of Pinecall's `log.gap`: an out-of-range `Last-Event-ID` silently degrades to "tail from now" (`ops.mts:105-113`), and a too-old one cannot happen because the in-memory log is unbounded for the life of the process.

### 2.3 What the client does: `streamWithRetry` and the `Location` header

The reconnect loop lives in `langgraphjs/libs/sdk/src/utils/stream.ts:231-347` (already condensed; key lines):

```ts
export async function* streamWithRetry<T extends { id?: string }>(
  makeRequest: (params?: StreamRequestParams) => Promise<{
    response: Response;
    stream: ReadableStream<T>;
  }>,
  options: StreamWithRetryOptions = {}
): AsyncGenerator<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
  let attempt = 0;
  let lastEventId: string | undefined;
  let reconnectPath: string | undefined;

  while (true) {
    ...
      const { response, stream } = await makeRequest(
        reconnectPath ? { lastEventId, reconnectPath } : undefined
      );

      // Check for Location header (server-provided reconnection path)
      const locationHeader = response.headers.get("location");
      if (locationHeader) {
        reconnectPath = locationHeader;
      }
    ...
          // Track last event ID for reconnection
          if (value.id) {
            lastEventId = value.id;
          }

          yield value;
    ...
      } catch (error) {
        // Error during streaming - attempt reconnect if we have a location header
        if (reconnectPath && !options.signal?.aborted) {
          shouldRetry = true;
        } else {
          throw error;
        }
    ...
    if (shouldRetry) {
      attempt += 1;
      if (attempt > maxRetries) {
        throw new MaxReconnectAttemptsError(maxRetries, lastError);
      }
      options.onReconnect?.({ attempt, lastEventId, cause: lastError });
      // Exponential backoff with jitter (shared with protocol transports).
      const delay = reconnectDelayMs(attempt);
```

and the request builder `client/base.ts:418-437`:

```ts
    const makeRequest = async (reconnectParams?: StreamRequestParams) => {
      const requestEndpoint = reconnectParams?.reconnectPath || config.endpoint;

      const isReconnect = !!reconnectParams?.reconnectPath;
      const method = isReconnect ? "GET" : config.method || "GET";

      const requestHeaders =
        isReconnect && reconnectParams?.lastEventId
          ? { ...config.headers, "Last-Event-ID": reconnectParams.lastEventId }
          : config.headers;

      // oxlint-disable-next-line prefer-const -- init is reassigned by onRequest hook
      let [url, init] = this.prepareFetchOptions(requestEndpoint, {
        method,
        timeoutMs: null,
        signal: config.signal,
        headers: requestHeaders,
        params: config.params,
        json: isReconnect ? undefined : config.json,
      });
```

So the contract between client and server is:

1. The **creating** request (`POST …/runs/stream`) returns **both** `Content-Location: /threads/<t>/runs/<r>` (`runs.mts:355`, the dev server sets this; `getRunMetadataFromResponse` parses it, `client/base.ts:478-495`, to fire `onRunCreated`) and — on the Platform — a **`Location`** header naming the GET endpoint to reconnect to. **Inferred from client**: the JS dev server never sets `Location` (grep `c.header("Location"` → nothing), so against the dev server `streamWithRetry` never retries (no `reconnectPath` ⇒ `throw error`). Against the Platform it does.
2. On a **network error** (`isNetworkError(error) && reconnectPath`, `stream.ts:318`) the client re-issues **`GET <Location>`** with `Last-Event-ID: <last id seen>` and **no body** (`json: isReconnect ? undefined : config.json`). Method is forced to GET. Backoff `min(1000·2^(attempt-1), 5000) + rand(0,1000)` ms, max 5 attempts (`utils/reconnect.ts:8-30`).
3. The Python SDK is the same algorithm (`_async/http.py:205-287`): `Last-Event-ID` only when one was seen, GET on reconnect, same-origin check on `Location` (`_shared/utilities.py:167-192`, "Refusing to follow cross-origin reconnect Location"), max 5.
4. **What the client expects back**: the same `text/event-stream` with `id:` continuing from `Last-Event-ID + 1`. It does not validate continuity; dedup on overlap is not done client-side in the legacy path (the server is trusted to start at `+1`).

### 2.4 The idle watchdog (half-open sockets)

`utils/stream.ts:137-220` — `idleReconnectStream()` sits on the **line** stream, between `BytesLineDecoder` and `SSEDecoder` (`client/base.ts:452-465`):

```ts
    transform(line, controller) {
      // A line beginning with ":" is an SSE comment / keep-alive heartbeat.
      if (line.length > 0 && line[0] === SSE_COMMENT_BYTE) {
        noteHeartbeat();
      }
      // Any line is liveness — (re)arm the idle timer.
      arm();
      controller.enqueue(line);
    },
```

`"auto"` (default): dormant until two heartbeat comments are seen, then `timeout = clamp(interval × 3, 6 s, 30 s)` (`stream.ts:140-142, 180-198`); on trip it **errors the stream** with `StreamIdleTimeoutError`, which the retry loop treats as a disconnect and re-joins with `Last-Event-ID`. Numeric mode arms from t=0. This is the client's answer to "pod hard-killed, no FIN".

### 2.5 `streamResumable` and the React hook

Type doc, `types.ts:185-189`:

```ts
  /**
   * Whether the stream is considered resumable.
   * If true, the stream can be resumed and replayed in its entirety even after disconnection.
   */
  streamResumable?: boolean;
```

Wire: `stream_resumable: payload?.streamResumable` in the `POST` body (`client/runs/index.ts:87`, `144`). Server: `resumable: run.stream_resumable ?? false` into `run.kwargs` (`langgraph-api/src/api/runs.mts:95`), which flips the queue to keep-the-log mode (§1.3) and makes the creating stream start at `"-1"` (§1.3).

`useStream` (`react/stream.lgp.tsx`):

- `reconnectOnMount?: boolean | (() => RunMetadataStorage)` (`ui/types.ts:1241-1242`); storage contract `ui/types.ts:1315-1319`:
  ```ts
  interface RunMetadataStorage {
    getItem(key: `lg:stream:${string}`): string | null;
    setItem(key: `lg:stream:${string}`, value: string): void;
    removeItem(key: `lg:stream:${string}`): void;
  }
  ```
  `true` → `window.sessionStorage` (`stream.lgp.tsx:183-190`).
- On submit: `streamResumable = submitOptions?.streamResumable ?? !!runMetadataStorage` and `onDisconnect: submitOptions?.onDisconnect ?? (streamResumable ? "continue" : "cancel")` (`stream.lgp.tsx:574-590`). In `onRunCreated` it writes `lg:stream:<threadId> = run_id` (`:605-608`).
- On mount: if storage has a run id for this thread and nothing is loading, `joinStream(runId)` with `lastEventId = "-1"` — replay **from the start**, not from a saved cursor (`stream.lgp.tsx:748-774`, `:679`). The key is removed in `onSuccess` (`:721`). The cursor is never persisted; only the run id is. Correctness relies on the hook rebuilding state from a full replay, not on dedup.
- `joinStream(runId, lastEventId?, { streamMode?, filter? })` is also exposed publicly (`react/types.tsx:155-166`).
- `throttle?: number | boolean` (`ui/types.ts:1269-1275`, default `true`): implemented in `ui/manager.ts:656-678` as a **trailing debounce** on the `useSyncExternalStore` subscriber — `true` = one macrotask (`setTimeout 0`), number = that many ms, `false` = synchronous:
  ```ts
    const throttledListener = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        clearTimeout(timeoutId);
        listener();
      }, timeoutMs);
    };
  ```
  State itself is updated on every event; only the React notification is coalesced.

The cookbook's "React reconnect" demo (`streaming-cookbook/typescript/ui-react/src/reconnect.tsx:144-148`) does not even use `reconnectOnMount`: it persists only the `threadId` in `sessionStorage` (`:19-37, :97-104`) and lets the **v2** `@langchain/react` `useStream({ threadId })` re-hydrate from thread state + replay buffer; the "replayed vs live" labelling is done by saving the message ids seen before reload (`:127-129, :161-172`). That is the same idea as Pinecall's `log.gap.data.snapshot` — land on state, then tail.

---

## 3. Background runs vs streaming runs

| call | HTTP | returns | notes |
|---|---|---|---|
| `runs.create` | `POST /threads/:t/runs` (or `/runs`) | `Run` JSON; `Content-Location` | `client/runs/index.ts:131-178`; server `runs.mts:268-277`. Background. Pair with `joinStream` / `join`. |
| `runs.stream` | `POST …/runs/stream` | SSE | `index.ts:65-121`; server `runs.mts:341-380`. Creates + streams in one request. |
| `runs.wait` | `POST …/runs/wait` | final `values` JSON | `index.ts:225-282`; server streams `"\n"` every second as keep-alive then writes the result (`utils/hono.mts:11-26`). Client throws on `__error__` unless `raiseError:false` (`index.ts:269-280`). |
| `runs.join` | `GET …/runs/:r/join?cancel_on_disconnect=` | final state JSON | `index.ts:384-394`; server `runs.mts:433-444` → `ops.mts:1614-1623`. |
| `runs.joinStream` | `GET …/runs/:r/stream` | SSE | §2. |

`on_disconnect: "cancel" | "continue"` (`types.ts:9`, doc `:135-141`): only meaningful on `stream`/`wait`; server: `payload.on_disconnect === "cancel" ? getDisconnectAbortSignal(c, stream) : undefined` (`runs.mts:357-360`), and the abort → `runs.cancel(... action:"interrupt")` (`ops.mts:1843-1849`). Default on the dev server is **continue** (undefined ⇒ no signal). The React hook picks `"continue"` iff resumable (§2.5).

`multitask_strategy: "reject" | "interrupt" | "rollback" | "enqueue"` (`types.ts:6`, doc `:105-115`); server `runs.mts:110-141`: `interrupt`/`rollback` cancel the in-flight runs with that action; `reject` → HTTP 422 "Thread is already running a task"; `enqueue` just inserts.

`if_not_exists: "create" | "reject"`, `after_seconds`, `on_completion: "complete" | "continue"` (`types.ts:8, 147-152`) — scheduling / stateless-thread lifetime; not relevant to the wire.

---

## 4. The envelope / `StreamPart` types

Client-side envelope — JS `sse.ts:93-97` (§1.1), Python `schema.py:595-603` (§1.2). Per-mode typed events, `langgraphjs/libs/sdk/src/types.stream.ts` (verbatim excerpts):

```ts
export type StreamMode =
  | "values"
  | "messages"
  | "updates"
  | "events"
  | "debug"
  | "tasks"
  | "checkpoints"
  | "custom"
  | "messages-tuple"
  | "tools";                                              // :14-24

export type ValuesStreamEvent<StateType> = {
  id?: string;
  event: "values";
  data: StateType;
};                                                       // :43-47

export type MessagesTupleStreamEvent = {
  event: "messages";
  data: [message: Message, config: MessageTupleMetadata];
};                                                       // :57-62

export type MetadataStreamEvent = {
  id?: string;
  event: "metadata";
  data: { run_id: string; thread_id: string };
};                                                       // :71-75

export type ErrorStreamEvent = {
  id?: string;
  event: "error";
  data: { error: string; message: string };
};                                                       // :80-84

export type UpdatesStreamEvent<UpdateType> = {
  id?: string;
  event: "updates";
  data: { [node: string]: UpdateType };
};                                                       // :94-98

export type CustomStreamEvent<T> = { event: "custom"; data: T };   // :108

type MessagesCompleteStreamEvent = {
  id?: string;
  event: "messages/complete";
  data: Message[];
};
type MessagesPartialStreamEvent = {
  id?: string;
  event: "messages/partial";
  data: Message[];
};                                                       // :118-127

export type FeedbackStreamEvent = {
  id?: string;
  event: "feedback";
  data: { [feedbackKey: string]: string };
};                                                       // :244-248
```

Subgraph variant: `event: TEvent["event"] | \`${TEvent["event"]}|${string}\`` (`AsSubgraph`, `:33-38`) — the namespace rides in the **event name**, pipe-separated, which is why the manager does `event.split("|").slice(1)` (`ui/manager.ts:798-800`). The open `StreamEvent` string union is `types.ts:12-22`.

The server-side message in the dev server's queue is `{ topic: \`run:${id}:stream:${event}\`, data, normalized? }` (`langgraph-api/src/storage/types.mts:156-167`); the `id` is added at read time by the queue index (§1.3).

---

## 5. Error / end / cancel / interrupt on the wire

- **error**: `event: error`, `data: { error, message }` (§1.3, §4). The React manager stops on it: `if (event === "error") { streamError = new StreamError(data); break; }` (`ui/manager.ts:792-796`).
- **end**: no frame. Legacy stream ends when the HTTP body closes (dev server: run left `pending|running`, `ops.mts:1837-1838`). `runs.wait` uses the last `values` chunk (`ops.mts:1597-1603`).
- **cancel**: `POST /threads/:t/runs/:r/cancel?wait=0|1&action=interrupt|rollback` (`client/runs/index.ts:338-350`; server `runs.mts:483-500`; `cancelMany` → `POST /runs/cancel`, `:358-375`). The stream side sees the run stop; with `action:"interrupt"` the worker does **not** publish an `error` event (`queue.mts:90`, `isInterrupted()` guard) and sets status `interrupted` (`:116-119`).
- **interrupt (HITL)**: not a separate event type in the legacy wire. It arrives inside `values`/`updates` as a `__interrupt__` key; the manager accumulates `data.__interrupt__` arrays across parallel branches (`ui/manager.ts:951-960`). Resume is a new run with `command: { resume }` (`types.ts:29-46`).
- **metadata**: always the first frame, `{ run_id, attempt }` from the dev server (`stream.mts:206-209`) / `{ run_id, thread_id }` per the SDK type (`types.stream.ts:71-75`).

---

## 6. The newer protocol (v2): `seq` + `event_id` — closest to Pinecall

Still SSE (or WebSocket), but the payload is a JSON envelope and the cursor is explicit. **Server side is OPEN in the JS dev server**: `langgraph-api/src/protocol/session/index.mts:706-730`:

```ts
  private createEvent(
    method: SupportedChannel,
    namespace: Namespace,
    data: ProtocolEventDataMap[SupportedChannel],
    node?: string
  ): ProtocolEvent {
    this.nextSeq += 1;
    const eventMethod = method === "input" ? "input.requested" : method;
    ...
    return {
      type: "event",
      event_id: String(this.nextSeq),
      seq: this.nextSeq,
      method: eventMethod,
      params: {
        namespace,
        timestamp: Date.now(),
        ...(node != null ? { node } : {}),
        data: normalizedData,
      },
    } as ProtocolEvent;
  }
```

SSE encoding of it (`langgraph-api/src/api/protocol.mts:176-192`): `id: event.event_id`, `event: event.method`, `data: <whole envelope>`, with a per-connection `delivered` set so one socket never writes the same `event_id` twice. Subscription body carries a filter `{ channels, namespaces?, depth?, since? }` (`protocol.mts:167-174`); the server applies `since` as `event.seq <= filter.since ⇒ skip` (`protocol/service.mts:847`). On subscribe the session replays its buffer `seq <= snapshotSeq` then drains anything newer, then goes live (`session/index.mts:911-942`).

Client (`langgraphjs/libs/sdk/src/client/stream/`): tracks `lastSeenSeq` / `lastEventId` (`types.ts:175-179`, `index.ts:2288-2298`), dedupes **by `event_id`** in a per-thread `Set` (`index.ts:543-560`) and per-subscription sets; on reconnect it deliberately does **not** send `since` again because `seq` is connection-local on the Platform (`transport/http.ts:255-265`):

```ts
    // Honor an explicit caller `since` until the stream has connected
    // once. Do not advance it from observed `seq` values — those are
    // connection-local, and carrying them onto a post-connect reconnect
    // POST filters out the full Redis replay (heartbeats only). Pre-ready
    // retries still send the caller cursor; only after a successful open
    // do reconnects omit `since` and rely on durable `event_id` dedup.
```

That comment is the only evidence about the closed Platform: **inferred from client** — replay comes from Redis, `seq` restarts per session, `event_id` is the durable identity. The transport contract also says (`transport.ts:75-85`) the server "MUST buffer events … and replay them through every newly-opened stream … from `seq=0`"; the JS dev server does this with an unbounded-per-run in-memory buffer, the Platform with "a bounded per-run replay buffer".

Net: v2 solves resume by **full replay + idempotent apply** (event_id set), not by a trusted cursor. Pinecall solves it by a trusted cursor (`after=seq`) + `log.gap` when the cursor is unservable. Pinecall's is the stronger contract; LangGraph's is the one that survives a server that cannot promise a stable seq.

---

## For Pinecall

1. **Keep `after=seq` as the resume key; do not adopt `Last-Event-ID` as the *only* one.** LangGraph's `id:` is a 0-based per-run index and `Last-Event-ID: n` means "serve n+1" (`ops.mts:105-115`) — semantically identical to `?after=n`. For an SSE flavour of `/v1/attach` (sdk-server `server/handlers/calls_api.py:739` `attach()`), emit `id: <seq>` on every frame (so `EventSource` auto-resume works for free) **and** accept `?after=` for non-EventSource clients; treat a `Last-Event-ID` header as an alias of `after`. Pinecall's cursor is already durable across processes (the store, `_attach_backlog`), which LangGraph's legacy one is not.
2. **Copy the `"-1"` convention only as documentation, not as wire.** LangGraph's "replay from the start" is `Last-Event-ID: -1`; ours is `after=0`. Keep `after=0`; mention the equivalence in `docs/guides/call-log.md` for readers coming from LangGraph.
3. **Keep `log.gap` — LangGraph has nothing like it, and that is a weakness, not a simplification.** An out-of-range `Last-Event-ID` silently becomes "tail from now" (`ops.mts:106-113`), and v2 survives only by full replay + `event_id` dedup. Our `log.gap{from, resume_from, snapshot}` (`calls_api.py:308-335`) is the honest version of what the cookbook demo hand-rolls with saved message ids (`reconnect.tsx:127-172`). Skip v2's per-thread `Set<event_id>` (`index.ts:543-560`): `CallLogView` already dedupes by `seq` and a seq-keyed map is bounded by the log, not by the session.
4. **`log.caught_up` is our explicit "backlog drained" frame; LangGraph has no equivalent and the client infers it.** Keep it. But fix the collision the server comment already flags (`calls_api.py:635-662`): control frames reuse `seq = last_seq` and rely on the reducer swallowing them — LangGraph's v2 server gives every control-ish thing its own `seq` and a `method`. Recommend: `log.gap` / `log.caught_up` bypass the dedupe map in `@pinecall/web/log` `CallLogView` (vendored reducer), as the sdk card note already says.
5. **Heartbeats: send an SSE comment, not a data event.** The Platform's `: heartbeat` every ~5 s (`types.ts:198-200`) is invisible to the SSE decoder (`sse.ts:129`) and visible to the idle watchdog (`stream.ts:207-215`). Our WS `ping` (`calls_api.py:705-733`, `{"type":"ping"}` every 25 s at `:725`) is a data frame; for SSE use `: ping\n\n` so `applyFrame` (`webrtc/src/log/transport.ts:158-188`) never sees it. Keep 25 s on WS; on SSE 15–25 s is fine (their watchdog window is `clamp(3×interval, 6 s, 30 s)`).
6. **Copy the idle watchdog into `tail()`/`observe()`.** `webrtc/src/log/transport.ts` reconnects on `onclose` only; a half-open socket (backgrounded iOS WebView, proxy) hangs until the OS notices. LangGraph's `idleReconnectStream` (`utils/stream.ts:137-220`): arm a timer on *any* frame (ping included), default "auto" = 3× observed ping cadence clamped [6 s, 30 s], on trip close the socket and re-attach with `after=lastSeq`. Expose as `idleReconnect?: number | "auto" | 0` on `TailOptions` and `UseCallOptions`. Also copy jitter: our backoff `min(1000·2^n, 15000)` (`transport.ts:198,272`) has none; theirs adds `rand(0,1000)` (`reconnect.ts:23-30`).
7. **`reconnectOnMount` for `useCall` — copy the *shape*, not the mechanism.** LangGraph stores only the run id in `sessionStorage` under `lg:stream:<threadId>` and replays from `-1` (`stream.lgp.tsx:183-190, 605-608, 748-774`). For Pinecall the call id is already in the URL/props, so `reconnectOnMount?: boolean | (() => Storage)` should persist **`{ call, lastSeq }`** under `pc:log:<call>` and resume with `after=lastSeq` — cheaper than their full replay and correct because of `log.gap`. Clear the key when `call.summary` lands (their `onSuccess` → `removeItem`, `:721`).
8. **`throttle` for `useCall`/`useAgentCalls` — copy verbatim.** `throttle?: number | boolean`, default `true` = coalesce into one macrotask, number = ms, `false` = sync (`ui/types.ts:1269-1275`, `ui/manager.ts:656-678`). Apply it around the `view.subscribe(cb)` passed to `useSyncExternalStore` in `webrtc/src/log/react.tsx:63-67, 132-136`; the reducer still applies every entry, only the React notification is debounced (trailing). Do it in the hook, not in `CallLogView`, so framework-free consumers keep every tick.
9. **Custom entries (`call.log()`): copy the `event: custom` / `data: T` minimalism** (`types.stream.ts:108`), i.e. one closed type (`custom` in LangGraph, e.g. `app.log` in ours) whose `data` is opaque to the reducer. Do **not** copy the pipe-namespaced event names (`messages|sub|graph`, `types.stream.ts:33-38`) — namespace belongs in the envelope (`agent`, `call`), never in the type string.
10. **Server-side filters: copy v2's `channels` + `since` filter shape, skip `namespaces/depth`.** `{ channels: Set, since }` applied at the sink (`protocol/service.mts:847`, `protocol.mts:169-174`) maps cleanly onto `?types=user.message,tool.call&after=seq` (or `?ephemeral=0`) on `/v1/attach` and `/v1/calls/{id}/events`. Filtering is at the subscriber's sink (the transport), never in the append path — same as our `_pump_tail`. Depth/namespace only make sense for subgraph trees; a call log is flat.
11. **Skip `on_disconnect: cancel` and multitask strategies entirely.** They exist because a LangGraph run is *owned* by the request that created it (`runs.mts:357-360`, `ops.mts:1843-1849`). A Pinecall call is owned by the phone line; an observer dropping must never touch the call. `cancelOnDisconnect` has no counterpart and should not get one; our supervise verbs (`SuperviseVerb`, `transport.ts:55-61`) are the explicit, authenticated way to end a call.

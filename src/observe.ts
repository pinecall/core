/**
 * `observe()` — the Node reader of the Call Log.
 *
 * ONE verb to read a call (or an agent's lifecycle log) from a server
 * process: it opens `GET /v1/calls/{id}/events` (or
 * `/v1/agents/{slug}/calls`) with `Accept: text/event-stream`, feeds every
 * envelope into the SAME `CallLogView` reducer the browser uses, and hands
 * the caller three ways to consume it — `for await`, `on("entry")` /
 * `on("custom")`, and the reduced `state` snapshot.
 *
 * ── TWINS, NOT YET SHARED ────────────────────────────────────────────────
 *
 * The SSE decoder, the idle watchdog, the backoff-with-jitter, the
 * `withListeners()` seam and the finish reasons in this file are a
 * DELIBERATE, SEMANTICALLY IDENTICAL port of
 * `@pinecall/web`'s `src/log/transport.ts` (branch `call-log-v2`, commit
 * `30cf4af`). Same constants, same clamps, same field parsing, same
 * `min(1000·2^n, 15000) + rand(0, 1000)` reconnect, same
 * `"summary" | "closed" | "error"` trichotomy, same "resume always carries
 * `after=<view.lastSeq>`, never `Last-Event-ID`" rule. Read one, you have
 * read the other.
 *
 * They are twins rather than one shared module because the two packages sit
 * on opposite sides of a publish boundary: `@pinecall/sdk` cannot depend on
 * `@pinecall/web` (the web package depends on the SDK's contract, and a
 * cycle between two published packages is not a thing), and the reducer's
 * own answer to that — vendoring `src/log/{types,view}.ts` byte-for-byte
 * into webrtc, checked by `pnpm run log:sync-check` — buys its determinism
 * by being pure: no `fetch`, no timers, no environment. A transport is the
 * opposite: this one has no `document` to defer reconnects on (Node has no
 * `visibilitychange`) and no `WebSocket` half, while the browser twin has
 * both and needs them. Sharing them today would mean shipping a
 * lowest-common-denominator transport to both. When the divergence stops
 * paying for itself, the merge target is a third `@pinecall/log-wire`
 * package that both depend on — not a copy in either direction.
 *
 * The parts that MUST NOT drift are pinned by tests in both repos against
 * the same `fixtures/call-log-golden.json`: a replayed finished call reduces
 * to the same state here as it does in the browser.
 *
 * ── WHY NOT `EventSource` ────────────────────────────────────────────────
 *
 * Same four reasons as the browser: it cannot send an `Authorization`
 * header, it hides `:` comment lines from JS (the idle watchdog's
 * heartbeat), it owns its own reconnect (no abort, no backoff, no jitter),
 * and it fires `onerror` on every reconnect. `fetch` + `ReadableStream` +
 * the ~60-line decoder below is the portable answer, and on Node 18+ both
 * are global.
 *
 * @example
 * ```ts
 * const obs = pc.observe({ agent: "lucia" });
 * for await (const entry of obs) {
 *   if (entry.type === "call.started") console.log("call", entry.call);
 * }
 * ```
 */

import { LOG_EVENT_TYPES, type AnyLogEntry, type LogEntry } from "./log/types.js";
import { CallLogView, type CallLogState } from "./log/view.js";
import { createToken } from "./api/tokens.js";
import { DEFAULT_API_URL } from "./api/http.js";

// ── Structural seams (a test injects both) ───────────────────────────────

/** What `FetchLike` must resolve to. `body` is what the stream reads from. */
export interface ObserveResponseLike {
    ok: boolean;
    status: number;
    text(): Promise<string>;
    body?: ReadableStream<Uint8Array> | null;
}

/** Minimal structural `fetch` — the injection seam for tests. */
export type ObserveFetch = (
    url: string,
    init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<ObserveResponseLike>;

/**
 * Idle watchdog. `"auto"` is dormant until two heartbeats were seen, then
 * the window is `clamp(3 × observed cadence, 6 s, 30 s)`; a number is a
 * fixed window in ms armed from the first frame; `0` turns it off.
 *
 * Identical to the browser twin's `IdleReconnect`.
 */
export type IdleReconnect = "auto" | number | 0;

/** Why an observation ended. `"summary"` is the one clean end. */
export interface ObserveFinishInfo {
    reason: "summary" | "closed" | "error";
    error?: Error;
    lastSeq: number;
}

export interface ObserveOptions {
    /** Call-scoped: one call's log. Exactly one of `call` / `agent`. */
    call?: string;
    /** Agent-scoped: the agent's lifecycle log. Exactly one of `call` / `agent`. */
    agent?: string;
    /** Start cursor. Default `0` — from the beginning of the log. */
    after?: number;
    /** Server-side filter: only these entry types, plus the always-pass set. */
    types?: readonly string[];
    /** Server-side filter: skip ephemeral entries in the live tail. */
    durable?: boolean;
    /**
     * An `observe` / `supervise` token. Omitted ⇒ one is minted with the
     * client's API key (`createToken({ channel: "stream", scope: "observe" })`).
     *
     * Minting needs an AGENT: a stream token's visibility is an agent set.
     * So `observe({ call })` WITHOUT a token also requires `agent` — the SDK
     * does not resolve a call id to its agent behind your back, because the
     * only endpoint that would answer needs the very token being minted.
     * Pass `{ call, agent }`, or pass a `token` you already hold.
     */
    token?: string;
    /** Defaults to `https://voice.pinecall.io` (or the client's `apiUrl`). */
    server?: string;
    /** Aborting it is exactly `close()`. */
    signal?: AbortSignal;
    /** Half-open detection. Default `"auto"`. */
    idleReconnect?: IdleReconnect;
    /** `false` disables auto-reconnect (an intentional close never reconnects). */
    reconnect?: boolean;
    /**
     * Bound on the async-iterator's buffer, in entries. Default 1024.
     * See {@link Observation.dropped} for what an overflow costs.
     */
    queueLimit?: number;
    /** Transport-level failures. State is never faked into the view. */
    onError?: (error: Error) => void;
    /** Injection seam. Defaults to the global `fetch`. */
    fetchImpl?: ObserveFetch;
    /** Used to mint a token when `token` is absent. */
    apiKey?: string;
    /** REST base for the mint. Defaults to `server`. */
    apiUrl?: string;
}

export interface Observation extends AsyncIterable<AnyLogEntry> {
    /** The SAME `CallLogView` reducer state the browser renders from. */
    readonly state: Readonly<CallLogState>;
    /** The resume cursor: highest seq the view has accepted. */
    readonly lastSeq: number;
    /**
     * Entries the async iterator never saw because the consumer was slower
     * than the wire and the queue hit `queueLimit`. The OLDEST queued entries
     * are dropped, never the newest — a slow tail should show recent truth.
     *
     * `state` is NOT affected: every entry is reduced into the view before it
     * is ever queued, so the reduced state is complete even when the iterator
     * skipped rows. `on("entry")` is likewise never dropped — it fires
     * synchronously. The queue is the only lossy surface, and only under
     * genuine backpressure.
     */
    readonly dropped: number;
    /** True while entries can still arrive. */
    readonly active: boolean;

    on(
        event: "entry",
        fn: (entry: AnyLogEntry, state: Readonly<CallLogState>) => void,
    ): () => void;
    on(
        event: "custom",
        fn: (name: string, value: unknown, entry: LogEntry<"custom">) => void,
    ): () => void;
    on(event: "finish", fn: (info: ObserveFinishInfo) => void): () => void;

    /** Resolves once, when this observation ends for good. Never rejects. */
    readonly done: Promise<{ reason: "summary" | "closed" | "error"; lastSeq: number }>;
    /** Stop for good. Idempotent; never reconnects afterwards. */
    close(): void;
}

// ── Constants — identical to the browser twin ────────────────────────────

const MAX_BACKOFF_MS = 15_000;
const JITTER_MS = 1000;
const IDLE_MIN_MS = 6_000;
const IDLE_MAX_MS = 30_000;
const DEFAULT_QUEUE_LIMIT = 1024;

/** `min(1000·2^n, 15000) + rand(0, 1000)` ms — the twin's exact curve. */
export function observeBackoffDelay(attempt: number): number {
    return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS) + Math.floor(Math.random() * JITTER_MS);
}

const KNOWN_TYPES: ReadonlySet<string> = new Set<string>(LOG_EVENT_TYPES as readonly string[]);

/** Types the reducer knows and keeps, vs. ones it can never store. */
function isStorable(entry: AnyLogEntry): boolean {
    return KNOWN_TYPES.has((entry as { type?: string }).type ?? "");
}

function httpBase(server?: string): string {
    return (server ?? DEFAULT_API_URL).replace(/^ws/, "http").replace(/\/+$/, "");
}

/** The GET cursor path for a target: the call's events, or the agent's log. */
function eventsPath(opts: { call?: string; agent?: string }): string {
    if (opts.call) return `/v1/calls/${encodeURIComponent(opts.call)}/events`;
    if (opts.agent) return `/v1/agents/${encodeURIComponent(opts.agent)}/calls`;
    throw new Error("observe: exactly one of { call, agent } is required");
}

/** `&types=a,b&durable=1` — the server-side filters, same spelling as the browser. */
function filterQuery(opts: { types?: readonly string[]; durable?: boolean }): string {
    let q = "";
    if (opts.types && opts.types.length > 0) {
        q += `&types=${encodeURIComponent(opts.types.join(","))}`;
    }
    if (opts.durable) q += "&durable=1";
    return q;
}

function asError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
}

/** A transport error that carries the HTTP status it came from. */
export interface ObserveError extends Error {
    status?: number;
}

function httpError(status: number, detail = ""): ObserveError {
    const e: ObserveError = new Error(`observe: ${status}${detail ? ` ${detail}` : ""}`);
    e.status = status;
    return e;
}

/** Statuses no reconnect fixes: the token, or the target, is the problem. */
function isTerminalStatus(status: number): boolean {
    return status === 401 || status === 403 || status === 404;
}

/**
 * Has the log said this call is over? Only ever asked of a CALL-scoped
 * stream: an agent log is lifecycle-only and never ends.
 */
function isTerminal(view: CallLogView, target: { call?: string }): boolean {
    if (!target.call) return false;
    const s = view.state;
    return !s.live || s.intents.some((i) => i.kind === "disconnect");
}

// ── The SSE decoder ──────────────────────────────────────────────────────

export interface SseEvent {
    /** Sticky across events, as the spec says — an event with no `id:` inherits. */
    id: string | undefined;
    event: string;
    data: string;
}

/**
 * Bytes → lines → events. Honours `\n`, `\r\n` and a lone `\r`; `id:` is
 * sticky across events; `retry:` is parsed and ignored (we schedule our own
 * reconnects); comment lines (`: ping`) are DROPPED here but reported to
 * `onComment` first, so the idle watchdog one stage earlier sees them.
 *
 * A line-for-line twin of `@pinecall/web`'s `sseDecoder`.
 */
export function sseDecoder(handlers: {
    onEvent: (ev: SseEvent) => void;
    onComment?: (text: string) => void;
    onLine?: () => void;
}) {
    const textDecoder = new TextDecoder();
    let buf = "";
    let event = "";
    let data: string[] = [];
    let lastId: string | undefined;

    function line(l: string): void {
        handlers.onLine?.();
        if (l === "") {
            if (event === "" && data.length === 0) return; // nothing to dispatch
            handlers.onEvent({ id: lastId, event, data: data.join("\n") });
            event = "";
            data = [];
            return;
        }
        if (l[0] === ":") {
            handlers.onComment?.(l.slice(1).replace(/^ /, ""));
            return;
        }
        const i = l.indexOf(":");
        const field = i === -1 ? l : l.slice(0, i);
        let value = i === -1 ? "" : l.slice(i + 1);
        if (value[0] === " ") value = value.slice(1);
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
        else if (field === "id") {
            if (!value.includes("\0")) lastId = value;
        }
        // `retry:` and unknown fields: ignored.
    }

    return {
        push(chunk: Uint8Array): void {
            buf += textDecoder.decode(chunk, { stream: true });
            let start = 0;
            for (let i = 0; i < buf.length; i++) {
                const c = buf[i];
                if (c === "\n") {
                    line(buf.slice(start, i));
                    start = i + 1;
                } else if (c === "\r") {
                    // A `\r` at the very end may be half of a `\r\n` split
                    // across chunks: hold it until the next byte says which.
                    if (i === buf.length - 1) break;
                    line(buf.slice(start, i));
                    if (buf[i + 1] === "\n") i++;
                    start = i + 1;
                }
            }
            buf = buf.slice(start);
        },
        /** Body ended: flush a trailing event that lacked its blank line. */
        end(): void {
            buf += textDecoder.decode();
            if (buf.length > 0) {
                const rest = buf.endsWith("\r") ? buf.slice(0, -1) : buf;
                buf = "";
                line(rest);
            }
            if (event !== "" || data.length > 0) line("");
        },
        get lastId(): string | undefined {
            return lastId;
        },
    };
}

// ── The idle watchdog ────────────────────────────────────────────────────

/**
 * Half-open detection. Any line re-arms the timer (`touch`); `: ping`
 * comments also teach `"auto"` the server's cadence (`heartbeat`). When the
 * timer fires the pipe is presumed dead and `onTrip` aborts it, so the
 * reconnect path reopens with the cursor — the answer to "pod hard-killed,
 * no FIN".
 *
 * A twin of the browser's `idleWatchdog`, constants included.
 */
function idleWatchdog(mode: IdleReconnect | undefined, onTrip: () => void) {
    const setting: IdleReconnect = mode ?? "auto";
    let window_: number = typeof setting === "number" ? setting : 0;
    let lastBeat: number | null = null;
    let beats = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    function clear(): void {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    }

    function arm(): void {
        clear();
        if (stopped || window_ <= 0) return;
        timer = setTimeout(() => {
            timer = null;
            onTrip();
        }, window_);
        // A dangling watchdog must never hold the Node event loop open: an
        // observation is a tail, not a reason for the process to live.
        (timer as unknown as { unref?: () => void }).unref?.();
    }

    return {
        touch(): void {
            arm();
        },
        heartbeat(): void {
            if (setting === "auto") {
                const now = Date.now();
                beats++;
                if (lastBeat !== null && beats >= 2) {
                    const cadence = now - lastBeat;
                    window_ = Math.min(IDLE_MAX_MS, Math.max(IDLE_MIN_MS, 3 * cadence));
                }
                lastBeat = now;
            }
            arm();
        },
        /** A new pipe: forget the last pipe's timer, keep the learned cadence. */
        reset(): void {
            clear();
            lastBeat = null;
            beats = 0;
            if (setting === "auto") window_ = 0;
        },
        stop(): void {
            stopped = true;
            clear();
        },
        get window(): number {
            return window_;
        },
    };
}

// ── withListeners() — the onEntry / onCustom seam ────────────────────────

interface Sink {
    apply(entry: AnyLogEntry): boolean;
    applyAll(entries: readonly AnyLogEntry[]): number;
}

/**
 * Decorate a view so every applied entry fires `onEntry` (and `onCustom` for
 * `type: "custom"`) — in seq order, before any other notification, never
 * throttled. Fires when the view accepted the entry, or when it could never
 * store it (an unknown type); never for a seq duplicate, so a resume overlap
 * does not re-fire.
 *
 * A twin of the browser's `withListeners`.
 */
function withListeners(
    view: CallLogView,
    listeners: {
        onEntry: (entry: AnyLogEntry, state: Readonly<CallLogState>) => void;
    },
): Sink {
    /** Highest seq the decorator saw — the dedupe for entries the view cannot. */
    let seen = 0;

    function apply(entry: AnyLogEntry): boolean {
        const changed = view.apply(entry);
        const seq = (entry as { seq?: unknown }).seq;
        if (changed) {
            listeners.onEntry(entry, view.state);
        } else if (entry && typeof entry === "object" && typeof seq === "number"
            && seq > seen && !isStorable(entry)) {
            listeners.onEntry(entry, view.state);
        }
        if (typeof seq === "number") seen = Math.max(seen, seq);
        return changed;
    }

    return {
        apply,
        applyAll(entries) {
            let n = 0;
            for (const e of entries) if (apply(e)) n++;
            return n;
        },
    };
}

/**
 * Feed one wire frame into the sink. A frame is a single envelope or a
 * batch; unknown shapes are ignored (forward compatibility), never thrown.
 */
function applyFrame(sink: Sink, raw: string): void {
    let payload: unknown;
    try {
        payload = JSON.parse(raw);
    } catch {
        return;
    }
    if (Array.isArray(payload)) {
        sink.applyAll(payload as AnyLogEntry[]);
        return;
    }
    if (payload && typeof payload === "object") {
        const obj = payload as { entries?: unknown };
        if (Array.isArray(obj.entries)) {
            sink.applyAll(obj.entries as AnyLogEntry[]);
            return;
        }
        sink.apply(payload as AnyLogEntry);
    }
}

// ── observe() ────────────────────────────────────────────────────────────

type EntryListener = (entry: AnyLogEntry, state: Readonly<CallLogState>) => void;
type CustomListener = (name: string, value: unknown, entry: LogEntry<"custom">) => void;
type FinishListener = (info: ObserveFinishInfo) => void;

/**
 * Open an SSE observation of one call, or of an agent's lifecycle log.
 *
 * Exactly one of `call` / `agent`. Without a `token` one is minted from
 * `apiKey` — which needs an agent, so `{ call }` alone must carry a token
 * (see {@link ObserveOptions.token}).
 *
 * Terminal facts: a `204` (sealed cursor, nothing left) and a body that ends
 * after `call.summary` both finish with `"summary"`; `401/403/404` finish
 * with `"error"` and never retry; anything else reconnects on
 * `min(1000·2^n, 15000) + rand(0, 1000)` carrying `after=<lastSeq>`.
 */
export function observe(opts: ObserveOptions): Observation {
    if (!opts.call === !opts.agent) {
        throw new Error("observe: exactly one of { call, agent } is required");
    }
    if (!opts.token && !opts.apiKey) {
        throw new Error(
            "observe: a `token` is required (or an API key on the client to mint one)",
        );
    }
    if (!opts.token && !opts.agent) {
        throw new Error(
            "observe: minting a stream token needs an agent — pass { call, agent } or a `token`",
        );
    }

    const doFetch: ObserveFetch =
        opts.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<ObserveResponseLike>);
    const base = httpBase(opts.server);
    const path = eventsPath(opts);
    const queueLimit = Math.max(1, opts.queueLimit ?? DEFAULT_QUEUE_LIMIT);

    const view = new CallLogView();

    const entryListeners = new Set<EntryListener>();
    const customListeners = new Set<CustomListener>();
    const finishListeners = new Set<FinishListener>();

    /** The bounded hand-off to `for await`. Oldest-out on overflow. */
    const queue: AnyLogEntry[] = [];
    let dropped = 0;
    /** Parked `next()` calls, waiting for an entry or the end. */
    const waiters: Array<(v: IteratorResult<AnyLogEntry>) => void> = [];

    let finished = false;
    let finishInfo: ObserveFinishInfo | null = null;
    let resolveDone!: (v: { reason: "summary" | "closed" | "error"; lastSeq: number }) => void;
    const done = new Promise<{ reason: "summary" | "closed" | "error"; lastSeq: number }>((r) => {
        resolveDone = r;
    });

    const sink = withListeners(view, {
        onEntry: (entry, state) => {
            for (const fn of entryListeners) fn(entry, state);
            if (entry.type === "custom") {
                const d = (entry as { data?: { name?: unknown; value?: unknown } }).data;
                if (d && typeof d.name === "string") {
                    for (const fn of customListeners) {
                        fn(d.name, d.value, entry as LogEntry<"custom">);
                    }
                }
            }
            const waiter = waiters.shift();
            if (waiter) {
                waiter({ value: entry, done: false });
                return;
            }
            if (queue.length >= queueLimit) {
                queue.shift();
                dropped++;
            }
            queue.push(entry);
        },
    });

    // ── transport state ──
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let opened = 0;
    /** Set when the watchdog aborted the request: the read error is a drop, not a failure. */
    let idleTripped = false;

    const watchdog = idleWatchdog(opts.idleReconnect, () => {
        if (!controller || finished) return;
        idleTripped = true;
        controller.abort();
    });

    function clearTimer(): void {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    }

    function finish(reason: ObserveFinishInfo["reason"], error?: Error): void {
        if (finished) return;
        finished = true;
        clearTimer();
        watchdog.stop();
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
        const c = controller;
        controller = null;
        c?.abort();
        const info: ObserveFinishInfo = {
            reason,
            ...(error ? { error } : {}),
            lastSeq: view.lastSeq,
        };
        finishInfo = info;
        for (const fn of finishListeners) fn(info);
        resolveDone({ reason, lastSeq: info.lastSeq });
        // Wake every parked consumer; whatever is already queued is still
        // drained first by `next()`.
        while (waiters.length > 0) {
            waiters.shift()!({ value: undefined, done: true });
        }
    }

    function onAbort(): void {
        finish("closed");
    }
    if (opts.signal) {
        if (opts.signal.aborted) {
            // Nothing to open: report the close on the next tick so the caller
            // can still attach `on("finish")` to the handle it is about to get.
            queueMicrotask(() => finish("closed"));
        } else {
            opts.signal.addEventListener("abort", onAbort, { once: true });
        }
    }

    function scheduleReconnect(): void {
        if (finished || timer !== null) return;
        if (opts.reconnect === false) {
            finish("error", new Error("observe: stream lost and reconnect is off"));
            return;
        }
        const delay = observeBackoffDelay(attempts);
        attempts++;
        timer = setTimeout(() => {
            timer = null;
            void open();
        }, delay);
        (timer as unknown as { unref?: () => void }).unref?.();
    }

    /** Minted once and reused across reconnects. */
    let tokenPromise: Promise<string> | null = opts.token ? Promise.resolve(opts.token) : null;

    function resolveToken(): Promise<string> {
        if (!tokenPromise) {
            tokenPromise = createToken({
                channel: "stream",
                agentId: opts.agent as string,
                apiKey: opts.apiKey as string,
                apiUrl: opts.apiUrl ?? base,
                scope: "observe",
                ...(opts.call ? { callId: opts.call } : {}),
            }).then((r) => r.token);
            // A failed mint must not be cached as a rejected promise forever:
            // the next reconnect deserves a fresh attempt.
            tokenPromise.catch(() => {
                tokenPromise = null;
            });
        }
        return tokenPromise;
    }

    async function open(): Promise<void> {
        if (finished || controller) return;

        let token: string;
        try {
            token = await resolveToken();
        } catch (err) {
            if (finished) return;
            opts.onError?.(asError(err));
            scheduleReconnect();
            return;
        }
        if (finished || controller) return;

        // Resume ALWAYS carries `after=<view.lastSeq>` — the view dedupes by
        // seq, so an overlapping replay is safe by construction. `Last-Event-ID`
        // is for the zero-JS `new EventSource(url)` path, not for this one.
        const after = opened === 0 ? (opts.after ?? view.lastSeq) : view.lastSeq;
        const url =
            `${base}${path}?token=${encodeURIComponent(token)}` +
            `&after=${after}` +
            filterQuery(opts);

        const c = new AbortController();
        controller = c;
        idleTripped = false;
        watchdog.reset();

        let res: ObserveResponseLike;
        try {
            res = await doFetch(url, {
                headers: { Accept: "text/event-stream", Authorization: `Bearer ${token}` },
                signal: c.signal,
            });
        } catch (err) {
            if (controller !== c) return; // closed meanwhile
            controller = null;
            if (finished) return;
            opts.onError?.(asError(err));
            scheduleReconnect();
            return;
        }
        if (controller !== c) return;

        if (res.status === 204) {
            // Sealed, and the cursor is already at the end: nothing left, ever.
            controller = null;
            finish("summary");
            return;
        }
        if (!res.ok) {
            controller = null;
            let detail = "";
            try {
                detail = await res.text();
            } catch {
                /* no body to quote */
            }
            const err = httpError(res.status, detail);
            opts.onError?.(err);
            if (isTerminalStatus(res.status)) {
                finish("error", err);
                return;
            }
            scheduleReconnect();
            return;
        }
        const body = res.body;
        if (!body) {
            controller = null;
            opts.onError?.(new Error("observe: response has no readable body"));
            scheduleReconnect();
            return;
        }

        opened++;
        attempts = 0;
        watchdog.touch();

        const decoder = sseDecoder({
            onLine: () => watchdog.touch(),
            onComment: () => watchdog.heartbeat(),
            onEvent: (ev) => {
                if (ev.data === "") return;
                applyFrame(sink, ev.data);
            },
        });

        const reader = body.getReader();
        let readError: Error | null = null;
        try {
            for (;;) {
                const { done: streamDone, value } = await reader.read();
                if (controller !== c || finished) return; // closed mid-read
                if (streamDone) break;
                if (value) decoder.push(value);
            }
            decoder.end();
        } catch (err) {
            if (controller !== c || finished) return;
            readError = asError(err);
        } finally {
            try {
                reader.releaseLock();
            } catch {
                /* already released */
            }
        }
        if (controller !== c || finished) return;
        controller = null;

        // Unlike a WS attach, the stream does NOT stop on the reducer's
        // disconnect intent (`call.ended`): the server ends the body right
        // after `call.summary`, and cutting at `call.ended` would lose the
        // summary that follows it. The body end — or a 204 — is the terminator.
        if (isTerminal(view, opts)) {
            finish("summary");
            return;
        }
        if (readError && !idleTripped) opts.onError?.(readError);
        // Body ended without the call ending (agent log, slow consumer, proxy
        // timeout, idle trip): the cursor is in the view — reopen from it.
        scheduleReconnect();
    }

    if (!(opts.signal?.aborted)) void open();

    function next(): Promise<IteratorResult<AnyLogEntry>> {
        const queued = queue.shift();
        if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
        if (finished) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => waiters.push(resolve));
    }

    const observation: Observation = {
        get state() {
            return view.state;
        },
        get lastSeq() {
            return view.lastSeq;
        },
        get dropped() {
            return dropped;
        },
        get active() {
            return !finished;
        },
        on(event: "entry" | "custom" | "finish", fn: (...args: never[]) => void): () => void {
            if (event === "entry") {
                const l = fn as unknown as EntryListener;
                entryListeners.add(l);
                return () => entryListeners.delete(l);
            }
            if (event === "custom") {
                const l = fn as unknown as CustomListener;
                customListeners.add(l);
                return () => customListeners.delete(l);
            }
            const l = fn as unknown as FinishListener;
            // A listener attached after the end still hears it — the one fact
            // it exists for must not depend on winning a race with the wire.
            if (finishInfo) {
                const info = finishInfo;
                queueMicrotask(() => l(info));
                return () => {};
            }
            finishListeners.add(l);
            return () => finishListeners.delete(l);
        },
        done,
        close() {
            finish("closed");
        },
        [Symbol.asyncIterator](): AsyncIterator<AnyLogEntry> {
            return {
                next,
                return(): Promise<IteratorResult<AnyLogEntry>> {
                    // `break` out of a `for await` closes the observation.
                    finish("closed");
                    return Promise.resolve({ value: undefined, done: true });
                },
            };
        },
    };

    return observation;
}

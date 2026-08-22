/**
 * PhoneLine — a phone number you program, with no model behind it.
 *
 * `pc.line("+12186633772")` claims a number as a session OWNER that is not an
 * agent: it has its own STT and TTS, it takes the call first, and every
 * decision it makes is plain code — `if`, `switch`, `await`. The first model
 * call happens only if the code hands the live call to an agent
 * (`call.routeTo`), or never at all.
 *
 * The line registers under the id `line:<number>` in the client's registry, so
 * every existing dispatch handler routes its events without knowing lines
 * exist. The one seam is `Agent._createCall`, which a line overrides to hand
 * out a {@link LineCall} instead of a plain `Call`.
 *
 * Contract: docs/notes/phone-line-plan.md §11 (frozen).
 */

import { TypedEventBus } from "../kernel/event-bus.js";
import { PinecallError } from "../kernel/errors.js";
import { Agent } from "./agent.js";
import { Call } from "./call.js";
import type { CallInit, SayResult, LineTranscriptEntry } from "./call.js";
import { buildShortcutPayload } from "../protocol/shortcuts.js";
import type { Turn } from "./turn.js";
import type { CallDtmfReceivedEvent } from "../protocol/events.js";
import type { VoiceShortcut, STTShortcut } from "../config/agent.js";

// ─── Options ─────────────────────────────────────────────────────────────

/**
 * The line's own pipeline — the same shortcut shapes an agent accepts, minus
 * everything that implies a model.
 *
 * `llm`, `prompt`, `tools` and `greeting` are REFUSED, synchronously, in
 * `pc.line()`: a line has no model, and its first words are code (the first
 * `call.say()` takes the greeting lock exactly like an agent's greeting does).
 */
export interface LineOptions {
    /** The line's STT. Multilingual by default is the point — nobody knows the caller's language yet. */
    stt?: STTShortcut;
    /** The line's voice. */
    voice?: VoiceShortcut;
    /** BCP-47 language for STT/TTS. */
    language?: string;
    /** End-of-turn detection, passed through to the server untouched. */
    turnDetection?: string | Record<string, unknown>;
    /**
     * The post-dial extension window: how long after connect the server
     * collects the digits the caller's phone sent (`+1218…,,33`) before
     * emitting `call.started`. `{ window: 0 }` disables it.
     *
     * Default 2500ms.
     */
    extension?: { window: number };
}

/** Default extension window, in ms. §11.1. */
export const DEFAULT_EXTENSION_WINDOW_MS = 2500;

/** Config keys that mean "a model" — a line has none of them. */
const REFUSED_KEYS = ["llm", "prompt", "tools", "greeting"] as const;

/**
 * A routing table: extension → an agent slug, or code.
 *
 * `"*"` is the no-extension / unmatched case. Checked BEFORE `line.on("call")`;
 * a call with no matching key and no `"*"` falls through to the `call`
 * listeners.
 */
export type ExtensionTable = Record<string, string | ((call: LineCall) => void | Promise<void>)>;

// ─── LineCall ────────────────────────────────────────────────────────────

/** What `listen()` was waiting for, and what it got. */
export type ListenResult =
    | { by: "keypad"; digit: string; digits: string }
    | { by: "speech"; text: string; confidence: number }
    | { by: "timeout" };

export interface ListenOptions {
    /** Resolve once this many keys have been pressed. `1` resolves on the first press. */
    digits?: number;
    /** Resolve when this key is pressed, whatever the buffer holds ("#"). */
    terminator?: string;
    /** Also race the caller's SPEECH — the session's own end-of-turn, not a second STT. Opt-in. */
    speech?: boolean;
    /** How long to wait before giving up, in ms. */
    timeout: number;
    /** Switch the session's language before listening. */
    language?: string;
}

export interface SayOptions {
    /** Speak this one line in another voice. */
    voice?: VoiceShortcut;
    /** Speak this one line in another language. */
    language?: string;
    /** Inject the text into the server-side history (inherited from `Call.say`). */
    addToHistory?: boolean;
}

export interface RouteOptions {
    language?: string;
    voice?: VoiceShortcut;
    stt?: STTShortcut;
    /** Override the agent's own greeting for this hand-over. */
    greeting?: string;
    promptVars?: Record<string, string>;
    /** Keyed context the agent inherits — the same wire as `call.context()`. */
    context?: Record<string, unknown>;
    /** Prime the agent with what the line heard. Default true. */
    history?: boolean;
}

/** Why the owner swap did not happen. The line is still the owner. */
export type RouteFailureReason = "offline" | "unknown" | "no_phone_config" | "capacity" | "swap_failed";

export type RouteResult = { ok: true } | { ok: false; reason: RouteFailureReason };

/** A listen in flight: the promise, and the timer that has not started yet. */
interface ListenSession {
    promise: Promise<ListenResult>;
    /** Arm the timeout. `ask()` arms it only after the line stopped speaking. */
    start(): void;
}

/**
 * The `Call` a line's handler receives — a real `Call` (`instanceof Call` is
 * true, and every event and control it has still works) plus the verbs that
 * make a menu possible: an awaitable `say`, a `listen` that races keypad
 * against speech, `ask` as the two together, and `routeTo` as the hand-over.
 *
 * None of them talks to a model.
 */
export class LineCall extends Call {
    /** What the caller said and what the line said back, in order. */
    #entries: LineTranscriptEntry[] = [];
    /** Set once the server acked a `call.route` — every verb goes inert after it. */
    #routed = false;
    #pendingRoute: ((result: RouteResult) => void) | null = null;

    constructor(data: CallInit, send: (data: Record<string, unknown>) => void) {
        super(data, send);
        // The line's transcript is fed from both sides: the caller's confirmed
        // turns, and every `say()` this object sent.
        this.on("user.message", (event) => this.#record("caller", event.text));
    }

    /**
     * What the line heard and said — `[{ who, text, at }]`.
     *
     * Overrides `Call.transcript` (which derives `{role, content}` from the LLM
     * message list — a line has no LLM). The entries carry `role`/`content`
     * too, so anything written against a plain Call transcript still reads it.
     */
    override get transcript(): LineTranscriptEntry[] {
        return [...this.#entries];
    }

    /** True once the call has been handed to an agent. */
    get routed(): boolean {
        return this.#routed;
    }

    // ── say ──────────────────────────────────────────────────────────────

    /**
     * Speak, and resolve when the audio FINISHED PLAYING —
     * `{ interrupted: false }` — or when the caller talked over it,
     * `{ interrupted: true }`. Never rejects; a call that ends mid-sentence
     * resolves as interrupted.
     *
     * `voice`/`language` reconfigure the session for the rest of the call
     * (`session.configure`), sent before the reply so the line is heard in the
     * new voice from this sentence on.
     */
    override say(text: string, opts?: SayOptions): Promise<SayResult> {
        if (opts?.voice || opts?.language) {
            this.update({
                ...(opts.voice ? { voice: opts.voice } : {}),
                ...(opts.language ? { language: opts.language } : {}),
            });
        }
        this.#record("line", text);
        return super.say(text, opts?.addToHistory ? { addToHistory: true } : undefined);
    }

    // ── listen / ask ─────────────────────────────────────────────────────

    /**
     * Wait for the FIRST of: the keypad, the caller's speech, or the timeout.
     *
     * Both inputs come off the one `CallSession` the agent will keep using
     * after `routeTo` — same VAD, same STT, same turn detector. There is no
     * `<Gather>`, no second recognizer, no HTTP round trip.
     *
     * `speech` is opt-in: a menu that only takes digits should not wait on VAD.
     * Every listener is removed the moment it resolves.
     */
    listen(opts: ListenOptions): Promise<ListenResult> {
        return this.#openListen(opts, true).promise;
    }

    /**
     * `say` then `listen` — a question.
     *
     * The keypad is collected from BEFORE the first syllable: barge-in on a
     * menu is the normal case, and a caller who knows the menu presses over it.
     * If a press already satisfied the listen, `ask` returns it the moment the
     * line stops speaking; otherwise the timeout starts counting from there.
     */
    async ask(text: string, opts: ListenOptions): Promise<ListenResult> {
        const session = this.#openListen(opts, false);
        await this.say(text);
        session.start();
        return session.promise;
    }

    #openListen(opts: ListenOptions, autoStart: boolean): ListenSession {
        const wanted = opts.digits ?? 0;
        const terminator = opts.terminator;
        let buffer = "";
        let timer: ReturnType<typeof setTimeout> | null = null;
        let settled = false;
        let resolveWith!: (result: ListenResult) => void;
        const promise = new Promise<ListenResult>((resolve) => { resolveWith = resolve; });

        const settle = (result: ListenResult) => {
            if (settled) return;
            settled = true;
            if (timer) { clearTimeout(timer); timer = null; }
            this.off("call.dtmf_received", onDtmf);
            this.off("turn.end", onTurn);
            this.off("ended", onEnded);
            resolveWith(result);
        };

        const onDtmf = (event: CallDtmfReceivedEvent) => {
            const digit = event?.digit ?? "";
            if (!digit) return;
            if (terminator && digit === terminator) {
                settle({ by: "keypad", digit, digits: buffer });
                return;
            }
            buffer += digit;
            if (wanted > 0 && buffer.length >= wanted) {
                settle({ by: "keypad", digit, digits: buffer });
            }
        };
        const onTurn = (turn: Turn) => {
            settle({ by: "speech", text: turn.text, confidence: turn.confidence });
        };
        // A call that ends under a listen resolves like a timeout: the flow
        // above gets one answer and one code path, never a dangling promise.
        const onEnded = () => settle({ by: "timeout" });

        this.on("call.dtmf_received", onDtmf);
        if (opts.speech) this.on("turn.end", onTurn);
        this.on("ended", onEnded);

        if (opts.language) this.update({ language: opts.language });

        const start = () => {
            if (settled || timer) return;
            timer = setTimeout(() => settle({ by: "timeout" }), opts.timeout);
            (timer as { unref?: () => void })?.unref?.();
        };
        if (autoStart) start();

        return { promise, start };
    }

    // ── routeTo ──────────────────────────────────────────────────────────

    /**
     * Hand the LIVE call to an agent — no re-dial, no drop. The server swaps
     * the session's owner and config in place; the agent sees a normal
     * `call.started` with `routed_from`, `extension` and `line_transcript`.
     *
     * Resolves `{ ok: true }` once the swap landed, or `{ ok: false, reason }`
     * with the session untouched — an offline agent is the LINE's decision to
     * make (say so, forward, hang up, try another), not a 404.
     */
    routeTo(agent: string, opts: RouteOptions = {}): Promise<RouteResult> {
        if (this.#routed) return Promise.resolve({ ok: true });
        this._sendRaw({
            event: "call.route",
            call_id: this.id,
            agent,
            ...(opts.language ? { language: opts.language } : {}),
            ...(opts.voice ? { voice: opts.voice } : {}),
            ...(opts.stt ? { stt: opts.stt } : {}),
            ...(opts.greeting ? { greeting: opts.greeting } : {}),
            ...(opts.promptVars ? { prompt_vars: opts.promptVars } : {}),
            ...(opts.context ? { context: opts.context } : {}),
            history: opts.history !== false,
        });
        return new Promise<RouteResult>((resolve) => {
            // A call that dies between `call.route` and its answer is a failed
            // swap, not a hung promise.
            const onEnded = () => {
                this.#pendingRoute = null;
                resolve({ ok: false, reason: "swap_failed" });
            };
            this.on("ended", onEnded);
            this.#pendingRoute = (result) => {
                this.off("ended", onEnded);
                resolve(result);
            };
        });
    }

    // ── The rest of the verbs ────────────────────────────────────────────

    /** Hang up, with a reason the call log keeps. */
    override hangup(reason?: string): void {
        this._sendRaw({
            event: "call.hangup",
            call_id: this.id,
            ...(reason ? { reason } : {}),
        });
    }

    /**
     * Set keyed context on the session. It SURVIVES `routeTo`, so the agent
     * inherits what the line learned before it ever saw the call.
     */
    context(key: string, value: unknown): void {
        this._sendRaw({ event: "set_context", call_id: this.id, key, value });
    }

    // ── Dispatch-only API (friend methods) ───────────────────────────────

    /** @internal The server acked `call.route` — the agent owns the session now. */
    _applyRouted(agent: string): void {
        this.#routed = true;
        // The Call object goes inert: the server's `call.ended (routed)` is
        // what actually ends it, and until then nothing this object sends
        // belongs to anybody.
        this.status = "ended";
        this.reason = "routed";
        const resolve = this.#pendingRoute;
        this.#pendingRoute = null;
        resolve?.({ ok: true });
        this._emitWire("call.routed", { event: "call.routed", callId: this.id, agent });
    }

    /** @internal The swap did not happen. The line is still the owner. */
    _applyRouteFailed(agent: string, reason: RouteFailureReason): void {
        const resolve = this.#pendingRoute;
        this.#pendingRoute = null;
        resolve?.({ ok: false, reason });
        this._emitWire("call.route_failed", { event: "call.route_failed", callId: this.id, agent, reason });
    }

    #record(who: "caller" | "line", text: string): void {
        if (!text) return;
        this.#entries.push({
            who,
            text,
            at: Date.now(),
            role: who === "caller" ? "user" : "assistant",
            content: text,
        });
    }
}

// ─── The registry entry ──────────────────────────────────────────────────

/**
 * The line's face in the client's agent registry.
 *
 * Not public and not an agent anyone can configure: it exists so that
 * `agent_id: "line:<number>"` resolves, and so `call.started` builds a
 * {@link LineCall}. Everything else — the events, the calls map, the pending
 * queue, the reconnect discipline — is `Agent`'s, unchanged.
 */
class LineAgent extends Agent {
    override _createCall(data: CallInit, send: (data: Record<string, unknown>) => void): Call {
        return new LineCall(data, send);
    }
}

// ─── PhoneLine ───────────────────────────────────────────────────────────

export interface PhoneLineEvents {
    [key: string]: (...args: any[]) => void;
    /** The server registered the line; the number is ours. */
    ready: () => void;
    /** The registration was refused. `error.code` is the server's `LINE_*` code. */
    error: (error: PinecallError) => void;
    /** An inbound call, connected and HELD for this handler. Fires after the extension window. */
    call: (call: LineCall) => void | Promise<void>;
    /** Ended at any stage, including mid-menu. `reason` is `"routed"` after a hand-over. */
    "call.ended": (call: LineCall, reason: string) => void;
}

export class PhoneLine extends TypedEventBus<PhoneLineEvents> {
    /** The number this line owns, E.164 or `sip:`. */
    readonly number: string;
    /** How the server addresses this line: `line:<number>`. */
    readonly id: string;

    readonly #agent: LineAgent;
    readonly #opts: LineOptions;
    readonly #sendRaw: (data: Record<string, unknown>) => void;
    #extensions: ExtensionTable | null = null;
    /** call_id → already told the app it ended. One emission, whichever path got there first. */
    readonly #ended = new Set<string>();

    /** @internal — created by Pinecall.line() */
    constructor(number: string, opts: LineOptions, send: (data: Record<string, unknown>) => void) {
        super();
        this.number = number;
        this.id = `line:${number}`;
        this.#opts = opts;
        this.#sendRaw = send;
        this.#agent = new LineAgent(this.id, {}, send);

        this.#agent.on("call.started", (call) => { void this.#onCall(call as LineCall); });
        this.#agent.on("call.ended", (call, reason) => this.#onCallEnded(call as LineCall, reason));
    }

    // ── Public getters ───────────────────────────────────────────────────

    /** True once the SERVER acknowledged the line (`line.created`). */
    get registered(): boolean {
        return this.#agent.registered;
    }

    /** Resolves on `line.created`. Goes back to pending across a reconnect, like an agent's. */
    get ready(): Promise<void> {
        return this.#agent.ready;
    }

    /** Calls this line is currently holding. */
    get calls(): ReadonlyMap<string, LineCall> {
        return this.#agent.calls as ReadonlyMap<string, LineCall>;
    }

    // ── Routing table ────────────────────────────────────────────────────

    /**
     * Declare where each extension goes: an agent slug, or code.
     *
     * Runs BEFORE the `call` listeners, and a match consumes the call. `"*"`
     * catches the no-extension and unmatched cases; with neither a match nor a
     * `"*"`, the call falls through to `line.on("call")`.
     */
    extensions(map: ExtensionTable): this {
        this.#extensions = map;
        return this;
    }

    /** Release the number. The server answers `line.destroyed`. */
    destroy(): void {
        this.#agent.send({ event: "line.destroy", number: this.number });
    }

    // ── Client-only API (friend methods) ─────────────────────────────────

    /** @internal The registry entry dispatch routes `line:<number>` events to. */
    get _agent(): Agent {
        return this.#agent;
    }

    /**
     * @internal Claim the number. Sent on connect and re-sent on every
     * reconnect, exactly like an agent's `agent.create` — a line that comes
     * back has to take its number back or the number is stranded.
     */
    _register(): void {
        // Straight down the socket, NOT through the agent's queue: this frame
        // is what makes the line server-ready, so it cannot wait on it.
        this.#sendRaw({ event: "line.create", number: this.number, config: this.#wireConfig() });
    }

    /** @internal `line.created` — the line exists server-side from here on. */
    _markCreated(): void {
        this.#agent._flushPending();
        this.#agent._markRegistered();
        this.emit("ready");
    }

    /** @internal `line.error` — refused, with the server's code. */
    _markError(code: string, message: string): void {
        this.emit("error", new PinecallError(message, code));
    }

    /** @internal The socket dropped — `ready` goes back to pending. */
    _markUnregistered(): void {
        this.#agent._markUnregistered();
    }

    /** @internal End every call this line is holding (disconnect). */
    _endAllCalls(reason: string): void {
        this.#agent._endAllCalls(reason);
    }

    /** @internal Find a call this line is holding, by id. */
    _getCall(callId: string): LineCall | undefined {
        return this.#agent._getCall(callId) as LineCall | undefined;
    }

    // ── Internals ────────────────────────────────────────────────────────

    /**
     * The line's pipeline on the wire — the same shortcut resolution an agent's
     * config gets, plus the two keys only a line has.
     */
    #wireConfig(): Record<string, unknown> {
        const { turnDetection, extension } = this.#opts;
        return {
            ...buildShortcutPayload({
                stt: this.#opts.stt,
                voice: this.#opts.voice,
                language: this.#opts.language,
            }),
            ...(turnDetection !== undefined ? { turn_detection: turnDetection } : {}),
            extension_window_ms: extension?.window ?? DEFAULT_EXTENSION_WINDOW_MS,
        };
    }

    /**
     * Extensions first, `call` listeners second.
     *
     * A declared extension consumes the call: an app that wants both writes the
     * fall-through itself, in the function it registered.
     */
    async #onCall(call: LineCall): Promise<void> {
        const table = this.#extensions;
        const entry = table ? this.#match(table, call.extension) : undefined;
        if (entry === undefined) {
            this.emit("call", call);
            return;
        }
        try {
            if (typeof entry === "string") await call.routeTo(entry);
            else await entry(call);
        } catch (err) {
            this.emit("error", err instanceof PinecallError
                ? err
                : new PinecallError(`Extension handler failed: ${String(err)}`, "LINE_EXTENSION_ERROR"));
        }
    }

    #match(table: ExtensionTable, extension: string | null): ExtensionTable[string] | undefined {
        if (extension !== null && Object.prototype.hasOwnProperty.call(table, extension)) {
            return table[extension];
        }
        return Object.prototype.hasOwnProperty.call(table, "*") ? table["*"] : undefined;
    }

    /** One `call.ended` per call, whichever path got there first. */
    #onCallEnded(call: LineCall, reason: string): void {
        if (this.#ended.has(call.id)) return;
        this.#ended.add(call.id);
        this.emit("call.ended", call, reason);
    }
}

// ─── Construction ────────────────────────────────────────────────────────

/**
 * Validate the options and normalise the number. Called by `pc.line()` so a
 * config that implies a model fails on the line that wrote it, not three
 * seconds later on a socket.
 */
export function prepareLine(number: string, opts: LineOptions): string {
    for (const key of REFUSED_KEYS) {
        if ((opts as Record<string, unknown>)[key] !== undefined) {
            throw new PinecallError(
                `pc.line() does not take \`${key}\`: a line has no model — its first words are code. ` +
                `Say them with \`call.say()\`, or hand the call to an agent with \`call.routeTo("<slug>")\`.`,
                "LINE_CONFIG_ERROR",
            );
        }
    }
    return normalizeNumber(number);
}

/** E.164 or a SIP URI — the same shapes `addPhoneNumber` accepts. */
function normalizeNumber(number: string): string {
    if (number.startsWith("sip:")) return number;
    const cleaned = number.replace(/[\s\-()]/g, "");
    const normalized = cleaned.startsWith("+") ? cleaned : "+" + cleaned;
    const digits = normalized.slice(1);
    if (!/^\d+$/.test(digits) || digits.length < 7 || digits.length > 15) {
        throw new Error(`Invalid phone number "${number}": must be E.164 format (+, 7-15 digits)`);
    }
    return normalized;
}

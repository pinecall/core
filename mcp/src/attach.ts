/**
 * The long poll over `WS /v1/attach` — the live half of the call log.
 *
 * `get_call` reads history over HTTP; this reads the FUTURE. An MCP tool call
 * is request/response with no server-push, so "live" has to be expressed as a
 * long poll: hold one socket open until the log says something, then answer.
 *
 * Three properties this module exists to guarantee:
 *
 *  1. **No socket outlives the call.** The cursor IS the state — the caller
 *     resumes with `after`, exactly as a reconnect does (call-log guide: "the
 *     same URL with a fresher `after`; there is no separate resume protocol").
 *     Holding sockets between tool calls would make a stateless MCP server
 *     stateful and leak one per abandoned loop, so the socket is closed in a
 *     `finally` on every path — news, timeout, close, throw.
 *
 *  2. **A quiet log is an ANSWER, not an error.** `{ timedOut: true }` and the
 *     cursor unchanged. The agent loops; an error would make it stop.
 *
 *  3. **Control markers are not news.** `log.caught_up` and `log.gap` are full
 *     envelopes whose `seq` REPEATS the last seq delivered (spec §5) — the
 *     server sends `caught_up` the moment the backlog is drained, so returning
 *     on it would turn every long poll into an instant empty answer. They are
 *     still collected (the reducer needs them for `caughtUp`/`gaps`), just not
 *     counted as something to wake up for.
 */

import WebSocket from "ws";
import type { AnyLogEntry } from "../../src/log/types.js";

/** Default budget for one poll. The MCP client is waiting on this call. */
export const DEFAULT_WAIT_SECONDS = 25;
/** Hard cap — past this an MCP client's own request timeout starts to bite. */
export const MAX_WAIT_SECONDS = 50;
/** Connect is part of the budget, but never gets more than this. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * After the first real entry, wait this long for the rest of the burst.
 *
 * One utterance is several entries (`turn.start`, `user.message`, `bot.*`)
 * appended within milliseconds. Returning on the very first one would answer
 * with a half-formed turn and force another round trip for the other half, so
 * the burst is allowed to settle. Small enough to stay "live", large enough
 * that a turn arrives whole.
 */
const SETTLE_MS = 400;

export interface AttachTarget {
    server: string;
    token: string;
    /** Exactly one of these — the wire API takes `?call=` or `?agent=`, never both. */
    call?: string;
    agent?: string;
    after: number;
}

export interface AttachResult {
    entries: AnyLogEntry[];
    /** True when the budget expired with no substantive entry. */
    timedOut: boolean;
    /** The server's `live` hint, if the socket volunteered one. */
    live?: boolean;
}

/** A close that is not the normal end of a quiet poll — surfaced, never swallowed. */
export class AttachClosedError extends Error {
    readonly code: number;
    constructor(code: number, reason: string, target: AttachTarget) {
        const what = target.call ? `call ${target.call}` : `agent ${target.agent}`;
        super(
            `The call log closed the connection for ${what} (code ${code}${reason ? `: ${reason}` : ""}). ` +
            `Codes in the 4000s are the server refusing: an expired or wrong-scope stream token, ` +
            `or an id the token's agent set does not cover. Retry — the token is minted fresh each call.`,
        );
        this.name = "AttachClosedError";
        this.code = code;
    }
}

export function attachUrl(t: AttachTarget): string {
    const base = t.server.replace(/\/+$/, "").replace(/^http/, "ws");
    const url = new URL(`${base}/v1/attach`);
    url.searchParams.set("token", t.token);
    if (t.call) url.searchParams.set("call", t.call);
    if (t.agent) url.searchParams.set("agent", t.agent);
    url.searchParams.set("after", String(t.after));
    return url.toString();
}

/** `log.caught_up` / `log.gap` repeat a seq and mean "state", not "news". */
function isControl(entry: AnyLogEntry): boolean {
    return entry.type === "log.caught_up" || entry.type === "log.gap";
}

/**
 * Open one socket, wait for entries past `after`, close, return.
 *
 * Resolves — never rejects — on a quiet log or a clean close. Rejects only on
 * a connection that could not be established or was refused, because "your
 * token is wrong" answered as an empty timeout would be undebuggable.
 */
export function attachOnce(
    target: AttachTarget,
    waitMs: number,
    open: (url: string) => WebSocket = (url) => new WebSocket(url),
): Promise<AttachResult> {
    return new Promise<AttachResult>((resolve, reject) => {
        const entries: AnyLogEntry[] = [];
        let live: boolean | undefined;
        let settled = false;
        let connected = false;

        let budget: NodeJS.Timeout | undefined;
        let connectTimer: NodeJS.Timeout | undefined;
        let settleTimer: NodeJS.Timeout | undefined;

        const ws = open(attachUrl(target));

        /** The ONE exit. Every path goes through it, so every path closes the socket. */
        const finish = (outcome: { result?: AttachResult; error?: Error }) => {
            if (settled) return;
            settled = true;
            clearTimeout(budget);
            clearTimeout(connectTimer);
            clearTimeout(settleTimer);
            ws.removeAllListeners();
            // A socket still CONNECTING cannot be closed politely — terminate,
            // or the handshake completes into a listener-less socket that stays open.
            try {
                if (ws.readyState === WebSocket.OPEN) ws.close(1000, "done");
                else ws.terminate();
            } catch { /* already gone — nothing to release */ }
            if (outcome.error) reject(outcome.error);
            else resolve(outcome.result!);
        };

        const done = (timedOut: boolean) =>
            finish({ result: { entries, timedOut, ...(live !== undefined ? { live } : {}) } });

        budget = setTimeout(() => done(!entries.some((e) => !isControl(e))), waitMs);

        connectTimer = setTimeout(() => {
            if (!connected) {
                finish({
                    error: new Error(
                        `Timed out after ${CONNECT_TIMEOUT_MS / 1000}s connecting to the call log at ${target.server}. ` +
                        `Check PINECALL_URL and that the network reaches the voice server.`,
                    ),
                });
            }
        }, Math.min(CONNECT_TIMEOUT_MS, waitMs));

        ws.on("open", () => {
            connected = true;
            clearTimeout(connectTimer);
        });

        ws.on("message", (raw: unknown) => {
            let entry: AnyLogEntry;
            try {
                entry = JSON.parse(String(raw));
            } catch {
                return; // §1: anything unparseable is ignored, never fatal.
            }
            if (!entry || typeof entry !== "object") return;

            // Some deployments open with a small `{live}` hello rather than an
            // entry. Take the hint and drop it — it carries no seq.
            if (typeof (entry as any).live === "boolean" && (entry as any).type === undefined) {
                live = (entry as any).live;
                return;
            }
            if (typeof entry.type !== "string") return;

            // The server replays from `after`, but a resume overlap is normal
            // and dedupe by seq is always safe (spec §1) — the reducer does it.
            entries.push(entry);

            if (isControl(entry)) return;
            // First real entry: let the rest of its burst land, then answer.
            if (!settleTimer) settleTimer = setTimeout(() => done(false), SETTLE_MS);
        });

        ws.on("close", (code: number, reasonBuf: Buffer) => {
            const hasNews = entries.some((e) => !isControl(e));
            // A normal close after news (or a server that hangs up politely on
            // an ended call) is an answer; a refusal is not.
            if (hasNews || code === 1000 || code === 1001 || code === 1005) return done(!hasNews);
            finish({ error: new AttachClosedError(code, String(reasonBuf ?? ""), target) });
        });

        ws.on("error", (err: Error) => {
            if (entries.some((e) => !isControl(e))) return done(false);
            finish({ error: err });
        });
    });
}

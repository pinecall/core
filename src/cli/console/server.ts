/**
 * Console server — the web half of `pinecall run`.
 *
 * One HTTP server per agent process. It serves the prebuilt web console
 * (dist/ui, shipped inside the npm package — no CDN, no extra install) and
 * exposes the process to it:
 *
 *   GET  /                    the app (SPA fallback to index.html)
 *   GET  /api/agents          what this process is running
 *   GET  /api/calls           the CallsModel — live + the last 50 ended
 *   GET  /events              SSE: console.hello, then pc.stream() live
 *   POST /token               a WebRTC token, minted per request
 *   POST /chat-token          a chat token, minted per request
 *   POST /api/calls/:id/hangup
 *
 * ── Security ─────────────────────────────────────────────────────────────
 *
 * It binds 127.0.0.1 by default, and on loopback anything already able to
 * reach it is already running as you. Bind anywhere else (`--ui-host 0.0.0.0`,
 * a LAN address) and every request must carry the per-run key — `?k=<key>`,
 * which then sets the `pc_console` cookie so the page's own fetches carry it —
 * or it is 401. The key is minted per run and lives only in this process.
 *
 * The API key NEVER reaches the page: tokens are minted here, server-side,
 * short-lived and single-use, with `{ console: true }` metadata so an agent
 * can tell a dev-console session from a real one. Nothing is logged — library
 * code does not print; the runner prints through the live view.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { formatSSE, SSE_HEADERS } from "../../sse/format.js";
import type { CallsModel } from "./calls-model.js";
import type { TranscriptStore } from "./transcript-reducer.js";

// ── The host: what the server needs from the Pinecall client ─────────────

export interface ConsoleAgentLike {
    id: string;
    getConfig(): {
        name?: string;
        llm?: unknown;
        voice?: unknown;
        tools?: Array<{ name: string }>;
    };
    _getChannels(): Map<string, { type: string; ref?: string }>;
    /** A live call by id — the console hangs up through the agent that owns it. */
    call(callId: string): { hangup(): void } | undefined;
}

export interface ConsoleHost {
    /** The process's agents, by id. */
    agents: ReadonlyMap<string, ConsoleAgentLike>;
    /** The HTTP API base the SDK is talking to — handed to the page with each token. */
    apiUrl: string;
    /** Mint a browser token. The API key stays here. */
    createToken(
        channel: "webrtc" | "chat",
        agentId: string,
        metadata?: Record<string, unknown>,
    ): Promise<{ token: string; server?: string }>;
    /** Pipe every agent event to an SSE response — `pc.stream(res, opts)`. */
    stream(res: ServerResponse, opts?: { agents?: string[] }): void;
}

export interface ConsoleServerOptions {
    host: ConsoleHost;
    calls: CallsModel;
    /**
     * The transcript store the terminal view also runs on. `/events` needs it
     * for the two frames `pc.stream()` cannot carry — see `events()`.
     */
    store: TranscriptStore;
    /** Interface to bind. Default 127.0.0.1. */
    hostname?: string;
    /** First port to try. Default 4747; the next 10 are tried before failing. */
    port?: number;
    /** How many extra ports to try after `port`. Default 10. */
    portTries?: number;
    /** Where the built web app lives. Default: `ui/` next to the runner bundle. */
    uiDir?: string | null;
    /** Override the generated per-run key (tests). */
    key?: string;
    /**
     * Demand the run key on every request. Default: whenever the bind is not
     * loopback. Set it explicitly when the console sits behind something that
     * makes a loopback bind reachable from elsewhere (a proxy, a tunnel).
     */
    requireKey?: boolean;
}

export interface ConsoleServer {
    /** The URL to open — carries `?k=` when the bind is not loopback. */
    readonly url: string;
    readonly port: number;
    readonly hostname: string;
    /** The per-run key. Required on every request when the bind is not loopback. */
    readonly key: string;
    /** True when requests must carry the key. */
    readonly guarded: boolean;
    readonly server: Server;
    close(): Promise<void>;
}

// ── Boot ─────────────────────────────────────────────────────────────────

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

export async function startConsoleServer(opts: ConsoleServerOptions): Promise<ConsoleServer> {
    const hostname = opts.hostname ?? "127.0.0.1";
    const first = opts.port ?? 4747;
    const tries = opts.portTries ?? 10;
    const key = opts.key ?? randomBytes(16).toString("hex");
    const guarded = opts.requireKey ?? !LOOPBACK.has(hostname);
    const uiDir = opts.uiDir === undefined ? defaultUiDir() : opts.uiDir;

    const server = createServer((req, res) => {
        handle(req, res, { ...opts, uiDir, key, guarded }).catch(() => {
            if (!res.headersSent) send(res, 500, { error: "console_error" });
            else res.end();
        });
    });

    const port = await listen(server, hostname, first, tries);
    const shown = hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname;
    const url = guarded
        ? `http://${shown}:${port}/?k=${key}`
        : `http://${shown}:${port}`;

    return {
        url, port, hostname, key, guarded, server,
        close: () => new Promise<void>((resolve) => {
            server.close(() => resolve());
            // SSE responses and keep-alive sockets never end on their own —
            // without this, close() waits for a page that will never leave.
            server.closeAllConnections?.();
        }),
    };
}

/** Bind the first free port of the range, or reject with every one taken. */
function listen(server: Server, hostname: string, first: number, tries: number): Promise<number> {
    return new Promise((resolve, reject) => {
        let port = first;
        const attempt = () => {
            const onError = (err: NodeJS.ErrnoException) => {
                if ((err.code === "EADDRINUSE" || err.code === "EACCES") && port < first + tries) {
                    port += 1;
                    attempt();
                    return;
                }
                reject(
                    err.code === "EADDRINUSE"
                        ? new Error(`ports ${first}–${first + tries} are all in use — free one or pass --ui-port`)
                        : err,
                );
            };
            server.once("error", onError);
            server.listen(port, hostname, () => {
                server.removeListener("error", onError);
                const addr = server.address();
                resolve(typeof addr === "object" && addr ? addr.port : port);
            });
        };
        attempt();
    });
}

/** `ui/` next to the runner bundle (dist/runner.js → dist/ui). Null in a source checkout. */
function defaultUiDir(): string | null {
    // tsup builds the runner with shims, so __dirname is defined in both formats.
    return typeof __dirname === "string" && __dirname ? join(__dirname, "ui") : null;
}

// ── Request handling ─────────────────────────────────────────────────────

interface Ctx extends ConsoleServerOptions {
    uiDir: string | null;
    key: string;
    guarded: boolean;
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
    const url = new URL(req.url ?? "/", "http://console.local");
    const path = url.pathname;

    // ── Auth (non-loopback binds only) ───────────────────────────────
    if (ctx.guarded) {
        const given = url.searchParams.get("k") ?? cookie(req, "pc_console");
        if (given !== ctx.key) {
            send(res, 401, { error: "unauthorized", hint: "append ?k=<run key> — it is printed in the banner" });
            return;
        }
        if (url.searchParams.get("k") === ctx.key) {
            // First arrival with the key in the URL: the page's own fetches
            // carry the cookie from here on.
            res.setHeader("Set-Cookie", `pc_console=${ctx.key}; Path=/; HttpOnly; SameSite=Strict`);
        }
    }

    // ── API ──────────────────────────────────────────────────────────
    if (path === "/api/agents") {
        send(res, 200, { agents: [...ctx.host.agents.values()].map(describeAgent) });
        return;
    }

    if (path === "/api/calls") {
        send(res, 200, { calls: ctx.calls.list() });
        return;
    }

    const hangup = /^\/api\/calls\/([^/]+)\/hangup$/.exec(path);
    if (hangup) {
        if (req.method !== "POST") { send(res, 405, { error: "method_not_allowed" }); return; }
        const ok = ctx.calls.hangup(decodeURIComponent(hangup[1]!));
        if (!ok) { send(res, 404, { error: "no_such_live_call" }); return; }
        send(res, 200, { ok: true });
        return;
    }

    if (path === "/events") {
        events(req, res, ctx, url.searchParams.get("agent"));
        return;
    }

    if (path === "/token" || path === "/chat-token") {
        if (req.method !== "POST") { send(res, 405, { error: "method_not_allowed" }); return; }
        await token(req, res, ctx, path === "/token" ? "webrtc" : "chat");
        return;
    }

    if (path.startsWith("/api/")) {
        send(res, 404, { error: "not_found" });
        return;
    }

    // ── The app ──────────────────────────────────────────────────────
    serveStatic(res, ctx, path);
}

// ── /api/agents ──────────────────────────────────────────────────────────

export interface ConsoleAgentInfo {
    id: string;
    label?: string;
    channels: string[];
    phone?: string;
    llm?: string;
    voice?: string;
    tools: string[];
    /** The agent can place an outbound call (it owns a phone number to dial from). */
    canCall: boolean;
}

export function describeAgent(agent: ConsoleAgentLike): ConsoleAgentInfo {
    const config = agent.getConfig();
    const channels: string[] = [];
    let phone: string | undefined;
    for (const [, ch] of agent._getChannels()) {
        if (!channels.includes(ch.type)) channels.push(ch.type);
        if (ch.type === "phone" && ch.ref && !phone) phone = ch.ref;
    }
    return {
        id: agent.id,
        ...(config.name ? { label: config.name } : {}),
        channels,
        ...(phone ? { phone } : {}),
        llm: shortModel(config.llm as any),
        voice: shortVoice(config.voice as any),
        tools: (config.tools ?? []).map((t) => t.name),
        // Outbound needs a number to call FROM — no phone channel, no ring-me.
        canCall: Boolean(phone),
    };
}

/** "openai/gpt-4.1-mini" → "gpt-4.1-mini". Shared with the runner's boot banner. */
export function shortModel(llm: string | Record<string, unknown> | undefined): string {
    if (!llm) return "default";
    if (typeof llm === "object") {
        const model = (llm as any).model || (llm as any).provider || "custom";
        return String(model);
    }
    return llm.includes("/") ? llm.split("/").pop()! : llm;
}

/** Voices keep their provider prefix — "cartesia/sonic" is short enough. */
export function shortVoice(voice: string | Record<string, unknown> | undefined): string {
    if (!voice) return "default";
    if (typeof voice === "object") {
        const provider = (voice as any).provider || "custom";
        return String(provider);
    }
    return voice;
}

// ── /events ──────────────────────────────────────────────────────────────

function events(req: IncomingMessage, res: ServerResponse, ctx: Ctx, agent: string | null): void {
    (res as any).socket?.setNoDelay?.(true);
    res.writeHead(200, { ...SSE_HEADERS, ...cookieHeader(res) });
    res.flushHeaders?.();

    // The resync frame: a page that reconnects gets the whole world in the
    // first event, so it never needs a second request to catch up.
    res.write(formatSSE("console.hello", {
        agents: [...ctx.host.agents.values()].map(describeAgent),
        calls: ctx.calls.list(),
    }));

    // pc.stream() writes its own head — ours is already out, so neutralise it
    // and let it do the part that matters: subscribing every agent event.
    (res as any).writeHead = () => res;
    (res as any).flushHeaders = () => {};
    ctx.host.stream(res, agent ? { agents: [agent] } : undefined);

    // Two frames pc.stream() does not carry, and the console needs both to
    // render `⚡ name(args)` → `✓ result` the way the terminal does:
    //
    //   llm.toolCall    filtered out of STREAM_EVENTS (src/sse/format.ts) —
    //                   the public stream is deliberately quieter.
    //   llm.toolResult  not an event at all: the SDK auto-executes tools, and
    //                   the result only exists inside the runner's execute
    //                   wrapper, which hands it to the store.
    //
    // Both come off the store, so the web console sees exactly what the
    // terminal saw. The public default filter is untouched.
    const off = ctx.store.on((effect) => {
        if (effect.kind !== "tool.call" && effect.kind !== "tool.result") return;
        if (agent && effect.agent !== agent) return;
        const base = { agent: effect.agent, callId: effect.call?.id };
        const frame = effect.kind === "tool.call"
            ? formatSSE("llm.toolCall", { ...base, toolCalls: [{ name: effect.name, arguments: effect.args }] })
            : formatSSE("llm.toolResult", { ...base, name: effect.name, result: effect.result });
        try { res.write(frame); } catch { off(); }
    });

    req.on("close", () => {
        off();
        try { res.end(); } catch { /* already gone */ }
    });
}

/** Set-Cookie survives an explicit writeHead — carry it over by hand. */
function cookieHeader(res: ServerResponse): Record<string, string> {
    const set = res.getHeader("Set-Cookie");
    return set ? { "Set-Cookie": String(set) } : {};
}

// ── /token and /chat-token ───────────────────────────────────────────────

async function token(req: IncomingMessage, res: ServerResponse, ctx: Ctx, channel: "webrtc" | "chat"): Promise<void> {
    const body = await readJson(req);
    const agentId = typeof body?.agent === "string" ? body.agent : "";
    if (!agentId || !ctx.host.agents.has(agentId)) {
        send(res, 404, { error: "no_such_agent", agent: agentId });
        return;
    }
    try {
        const minted = await ctx.host.createToken(channel, agentId, { console: true });
        send(res, 200, { token: minted.token, server: minted.server ?? ctx.host.apiUrl, agent: agentId });
    } catch (err) {
        // The voice server refused (agent not online yet, plan, scope) — pass
        // its reason through rather than inventing one.
        send(res, 502, { error: "token_failed", message: (err as Error)?.message ?? String(err) });
    }
}

// ── Static files ─────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".map": "application/json; charset=utf-8",
};

function serveStatic(res: ServerResponse, ctx: Ctx, path: string): void {
    const dir = ctx.uiDir;
    if (!dir || !existsSync(join(dir, "index.html"))) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...cookieHeader(res) });
        res.end(missingUiPage());
        return;
    }

    // No traversal: resolve inside dir, fall back to the SPA entry.
    const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
    let file = rel ? join(dir, rel) : join(dir, "index.html");
    if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) {
        file = join(dir, "index.html");
    }

    const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    const cache = file.endsWith("index.html") ? "no-cache" : "public, max-age=3600";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": cache, ...cookieHeader(res) });
    createReadStream(file).pipe(res);
}

/** A source checkout before `npm run build`: say so instead of a blank 404. */
function missingUiPage(): string {
    return `<!doctype html><meta charset="utf-8"><title>Pinecall console</title>
<style>body{font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:44rem;margin:12vh auto;padding:0 1.5rem;background:#0d0d10;color:#e7e7ea}
h1{font-size:1.1rem;font-weight:600;color:#cd58b2}code{color:#8fd6ff}li{margin:.15rem 0}</style>
<h1>Pinecall console — the web app is not built</h1>
<p>This package has no <code>dist/ui/</code>. That is normal in a source checkout: run
<code>npm run build</code> in the SDK, then reload.</p>
<p>The process is still fully observable over HTTP:</p>
<ul>
<li><code>GET /events</code> — SSE, every agent event (<code>console.hello</code> first)</li>
<li><code>GET /api/agents</code></li>
<li><code>GET /api/calls</code></li>
<li><code>POST /token</code> · <code>POST /chat-token</code> — <code>{ "agent": "&lt;id&gt;" }</code></li>
<li><code>POST /api/calls/&lt;id&gt;/hangup</code></li>
</ul>`;
}

// ── Plumbing ─────────────────────────────────────────────────────────────

function send(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(json),
        ...cookieHeader(res),
    });
    res.end(json);
}

/** Read a JSON body, capped — the console talks to itself, not to the internet. */
function readJson(req: IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
        let raw = "";
        let dead = false;
        req.on("data", (chunk) => {
            if (dead) return;
            raw += chunk;
            if (raw.length > 64 * 1024) { dead = true; resolve(null); }
        });
        req.on("end", () => {
            if (dead) return;
            try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); }
        });
        req.on("error", () => resolve(null));
    });
}

function cookie(req: IncomingMessage, name: string): string | null {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(";")) {
        const eq = part.indexOf("=");
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return null;
}

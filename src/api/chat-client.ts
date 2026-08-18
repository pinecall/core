/**
 * Chat client — the `llm.chat` WebSocket protocol, once.
 *
 * Two commands talk text to a live agent: `pinecall chat` (a REPL) and
 * `pinecall test` (a judge LLM driving a scripted conversation). They differ in
 * what they DO with the stream, never in how they read it, so the socket, the
 * connect handshake, the 30s ping and the event decoding live here and each
 * command listens for the events it cares about.
 *
 * Not exported from `src/index.ts` — this is internal to the CLI for now.
 * Adapted from pinecall-test/src/client.ts.
 */

import WebSocket from "ws";
import { EventEmitter } from "node:events";

const DEFAULT_SERVER = "wss://voice.pinecall.io/client";

/** One tool call as the agent reported it. */
export interface ToolCallInfo {
    name: string;
    arguments: string;
}

export interface ChatClientOptions {
    server?: string;
    apiKey: string;
    agentId: string;
    /**
     * Prefix of the generated `session_id`. The server treats it as opaque, but
     * it is what a human reads in the call log — "chat-" for the REPL, "test-"
     * for a spec run.
     */
    sessionPrefix?: string;
}

export class ChatClient extends EventEmitter {
    private ws: WebSocket | null = null;
    private opts: ChatClientOptions;
    private _sessionId: string | null = null;
    private _connected = false;
    private _agentId: string;
    private _pingTimer: ReturnType<typeof setInterval> | null = null;

    constructor(opts: ChatClientOptions) {
        super();
        this.opts = opts;
        this._agentId = opts.agentId;
    }

    get connected(): boolean { return this._connected; }
    get sessionId(): string | null { return this._sessionId; }

    async connect(): Promise<void> {
        const url = this.opts.server || DEFAULT_SERVER;

        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            this.ws = ws;

            const timeout = setTimeout(() => {
                reject(new Error("Connection timeout (10s)"));
                ws.close();
            }, 10000);

            ws.on("open", () => {
                ws.send(JSON.stringify({
                    event: "connect",
                    api_key: this.opts.apiKey,
                }));
            });

            ws.on("message", (raw: Buffer) => {
                try {
                    const data = JSON.parse(raw.toString());
                    this._handleEvent(data, () => {
                        clearTimeout(timeout);
                        resolve();
                    }, (err: Error) => {
                        clearTimeout(timeout);
                        reject(err);
                    });
                } catch { /* ignore non-JSON */ }
            });

            ws.on("close", () => {
                this._connected = false;
                this._stopPing();
                this.emit("disconnected");
            });

            ws.on("error", (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
    }

    private _handleEvent(data: any, onReady?: () => void, onError?: (err: Error) => void): void {
        const evt = data.event;
        switch (evt) {
            case "connected":
                this._connected = true;
                this._startPing();
                this.emit("ready", { orgId: data.org_id });
                onReady?.();
                break;
            case "error":
                this.emit("error", new Error(data.error || "Unknown error"));
                onError?.(new Error(data.error || "Unknown error"));
                break;
            case "ping":
                this.ws?.send(JSON.stringify({ event: "pong" }));
                break;
            case "llm.chat.started":
                this.emit("started", { model: data.model });
                break;
            case "llm.chat.token":
                this.emit("token", { token: data.token ?? "", text: data.text ?? "" });
                break;
            case "llm.chat.done":
                this.emit("done", { text: data.text ?? "", model: data.model });
                break;
            case "llm.chat.tool_call":
                this.emit("tool_call", {
                    tools: (data.tool_calls ?? []).map((tc: any) => ({
                        name: tc.name,
                        arguments: tc.arguments,
                    })),
                });
                break;
            case "llm.chat.tool_result":
                this.emit("tool_result", { result: data.result ?? data.text ?? "" });
                break;
            case "llm.chat.error":
                this.emit("chat_error", { error: data.error });
                break;
        }
    }

    sendMessage(text: string): string {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("Not connected");
        }
        if (!this._sessionId) {
            this._sessionId = (this.opts.sessionPrefix ?? "test-") + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
        }
        this.ws.send(JSON.stringify({
            event: "llm.chat",
            session_id: this._sessionId,
            agent_id: this._agentId,
            text: text.trim(),
        }));
        return this._sessionId;
    }

    /** Wait for agent to finish responding */
    waitForResponse(timeoutMs = 30000): Promise<{ text: string; toolCalls: ToolCallInfo[] }> {
        return new Promise((resolve, reject) => {
            let text = "";
            const toolCalls: ToolCallInfo[] = [];
            let done = false;

            const timer = setTimeout(() => {
                if (!done) { done = true; cleanup(); reject(new Error(`Response timeout (${timeoutMs / 1000}s)`)); }
            }, timeoutMs);

            const onToken = ({ token }: { token: string }) => { text += token; };
            const onDone = ({ text: fullText }: { text: string }) => {
                if (done) return;
                done = true;
                cleanup();
                resolve({ text: fullText || text, toolCalls });
            };
            const onToolCall = ({ tools }: { tools: ToolCallInfo[] }) => {
                toolCalls.push(...tools);
            };
            const onError = ({ error }: { error: string }) => {
                if (done) return;
                done = true;
                cleanup();
                reject(new Error(error));
            };

            const cleanup = () => {
                clearTimeout(timer);
                this.removeListener("token", onToken);
                this.removeListener("done", onDone);
                this.removeListener("tool_call", onToolCall);
                this.removeListener("chat_error", onError);
            };

            this.on("token", onToken);
            this.on("done", onDone);
            this.on("tool_call", onToolCall);
            this.on("chat_error", onError);
        });
    }

    resetSession(): void { this._sessionId = null; }

    close(): void {
        this._stopPing();
        this.ws?.close();
        this.ws = null;
    }

    private _startPing(): void {
        this._stopPing();
        this._pingTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ event: "ping" }));
            }
        }, 30000);
    }

    private _stopPing(): void {
        if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    }
}

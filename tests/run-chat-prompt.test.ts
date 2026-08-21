/**
 * The terminal chat prompt behind `c` in `pinecall run`.
 *
 * Nothing here touches a network or a real terminal: stdin is a fake emitter
 * with an `isTTY` flag, stdout is the live view's fake stream, and the "agent"
 * is an object with a `_send` that records frames. What is asserted is the
 * contract the runner depends on:
 *
 *   - the line editor (typing, backspace, Ctrl-U, Enter, Esc, Ctrl-C)
 *   - the frame that goes on the wire — `llm.chat` on the AGENT's socket, with
 *     the `chat-` session prefix `ToolHandler` routes tool calls on
 *   - off a TTY it is inert: no raw mode, no listener, nothing sent
 *   - the prompt owns the last terminal row while it is open, and gives it back
 */

import { describe, it, expect, vi } from "vitest";
import { openPrompt } from "../src/cli/console/prompt.js";
import { chatFrame, isChatCapable, newChatSession, sendChat } from "../src/cli/console/chat.js";
import { createLiveView } from "../src/cli/live-view.js";

// ── Fakes ────────────────────────────────────────────────────────────────

class FakeStdin {
    isTTY: boolean;
    raw: boolean | null = null;
    resumed = 0;
    paused = 0;
    encoding: string | null = null;
    #handlers = new Set<(chunk: string) => void>();
    constructor(isTTY = true) { this.isTTY = isTTY; }
    setRawMode(raw: boolean) { this.raw = raw; }
    resume() { this.resumed++; }
    pause() { this.paused++; }
    setEncoding(enc: string) { this.encoding = enc; }
    on(_e: "data", handler: (chunk: string) => void) { this.#handlers.add(handler); return this; }
    off(_e: "data", handler: (chunk: string) => void) { this.#handlers.delete(handler); return this; }
    get listeners() { return this.#handlers.size; }
    type(text: string) { for (const h of [...this.#handlers]) h(text); }
}

class FakeAgent {
    sent: Array<Record<string, unknown>> = [];
    constructor(public id: string) {}
    _send(data: Record<string, unknown>) { this.sent.push(data); }
}

/** Collect the frames `render` was asked to draw. */
function recorder() {
    const frames: Array<string | null> = [];
    return { frames, render: (line: string | null) => { frames.push(line); } };
}

// ── The line editor ──────────────────────────────────────────────────────

describe("the `c` prompt", () => {
    it("reads a line and submits it on Enter, then stays open", () => {
        const input = new FakeStdin();
        const r = recorder();
        const submitted: string[] = [];
        const closed = vi.fn();

        const p = openPrompt({
            input, label: "you › ", render: r.render,
            onSubmit: (t) => submitted.push(t), onClose: closed,
        })!;

        expect(p).not.toBeNull();
        expect(input.raw).toBe(true);
        expect(r.frames[0]).toBe("you › ");

        input.type("hi");
        expect(p.value).toBe("hi");
        expect(r.frames.at(-1)).toBe("you › hi");

        input.type("\r");
        expect(submitted).toEqual(["hi"]);
        expect(closed).not.toHaveBeenCalled();     // ready for the next line
        expect(p.value).toBe("");

        input.type("and again\r");
        expect(submitted).toEqual(["hi", "and again"]);
    });

    it("edits: backspace, Ctrl-U, and control bytes that are not keys", () => {
        const input = new FakeStdin();
        const r = recorder();
        const submitted: string[] = [];
        openPrompt({ input, label: "> ", render: r.render, onSubmit: (t) => submitted.push(t) });

        input.type("helllo");
        input.type("\x7f");
        expect(r.frames.at(-1)).toBe("> helll");
        input.type("o\r");
        expect(submitted).toEqual(["helllo"]);

        input.type("throw this away\x15kept\r");
        expect(submitted).toEqual(["helllo", "kept"]);
    });

    it("closes on Esc, on an empty line and on Ctrl-C — and releases the row", () => {
        for (const key of ["\x1b", "\r", "\x03", "\x04"]) {
            const input = new FakeStdin();
            const r = recorder();
            const closed = vi.fn();
            const p = openPrompt({ input, label: "> ", render: r.render, onSubmit: () => {}, onClose: closed })!;
            input.type(key);
            expect(closed, `key ${JSON.stringify(key)}`).toHaveBeenCalledOnce();
            expect(r.frames.at(-1)).toBeNull();     // the row was handed back
            expect(input.listeners).toBe(0);        // stdin is free for the shortcuts
            p.close();                              // idempotent
            expect(closed).toHaveBeenCalledOnce();
        }
    });

    it("ignores an escape SEQUENCE (an arrow key is not Esc)", () => {
        const input = new FakeStdin();
        const r = recorder();
        const closed = vi.fn();
        const p = openPrompt({ input, label: "> ", render: r.render, onSubmit: () => {}, onClose: closed })!;
        input.type("\x1b[A");
        expect(closed).not.toHaveBeenCalled();
        expect(p.value).toBe("");
        input.type("ok");
        expect(p.value).toBe("ok");
    });

    it("is inert off a TTY — no raw mode, no listener, no prompt", () => {
        const input = new FakeStdin(false);
        const r = recorder();
        const opened = openPrompt({ input, label: "> ", render: r.render, onSubmit: () => {} });
        expect(opened).toBeNull();
        expect(input.raw).toBeNull();
        expect(input.listeners).toBe(0);
        expect(r.frames).toEqual([]);
    });
});

// ── The wire frame ───────────────────────────────────────────────────────

describe("chat over the agent's own socket", () => {
    it("sends llm.chat with the agent id, the session and the console marker", () => {
        const agent = new FakeAgent("nova");
        const session = newChatSession();
        sendChat(agent, session, "  where is my order?  ".trim());

        expect(agent.sent).toEqual([{
            event: "llm.chat",
            agent_id: "nova",
            session_id: session,
            text: "where is my order?",
            metadata: { console: true },
        }]);
    });

    it("keeps the `chat-` session prefix — llm.tool_call routes on it", () => {
        expect(newChatSession()).toMatch(/^chat-/);
        expect(newChatSession()).not.toBe(newChatSession());
        expect(chatFrame("a", "chat-1", "x").session_id).toBe("chat-1");
    });

    it("recognises an agent it can chat with", () => {
        expect(isChatCapable(new FakeAgent("nova"))).toBe(true);
        expect(isChatCapable({ id: "nope" })).toBe(false);
        expect(isChatCapable(null)).toBe(false);
    });
});

// ── The pinned row ───────────────────────────────────────────────────────

class FakeOut {
    chunks: string[] = [];
    columns = 100;
    write(chunk: string) { this.chunks.push(chunk); return true; }
    get text() { return this.chunks.join(""); }
}

describe("the prompt owns the last row while it is open", () => {
    it("keeps the transcript scrolling above the pinned line, then gives it back", () => {
        const out = new FakeOut();
        const view = createLiveView({ out, tty: true, color: false });
        const agent = { id: "nova", on() {}, off() {} };
        view.attach(agent as any);

        view.pin("  you › hel");
        expect(out.text.endsWith("  you › hel")).toBe(true);

        // The transcript keeps moving without stealing the row from the prompt…
        out.chunks.length = 0;
        view.print("  caller › hello");
        expect(out.text).toContain("caller › hello");
        expect(out.text.endsWith("  you › hel")).toBe(true);   // redrawn under it

        view.pin(null);
        expect(out.text.endsWith("\r\x1b[2K")).toBe(true);      // row released
    });

    it("pin is a no-op off a TTY — a log file has no last line to own", () => {
        const out = new FakeOut();
        const view = createLiveView({ out, tty: false, color: false });
        view.pin("  you › typing");
        expect(out.text).toBe("");
    });
});

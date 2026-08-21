/**
 * The one-line prompt under `pinecall run` — the terminal half of the console's
 * text chat (`c`).
 *
 * Why not `node:readline`? The runner already holds stdin in RAW mode for its
 * single-key shortcuts, and readline wants cooked mode plus its own idea of
 * where the cursor is. Two owners of one terminal row is a fight nobody wins.
 * So this is a deliberately small line editor over the SAME raw stream the keys
 * use: it takes the row, draws it through the live view's pin (so the transcript
 * keeps scrolling ABOVE the prompt), and gives the row back on close.
 *
 * It writes nothing itself — `render` does — so tests drive it with a fake
 * stdin and collect frames.
 *
 * Off a TTY it is inert by construction: `openPrompt` returns null and stdin is
 * never touched. Piped stdin stays exactly as the developer's own code left it.
 */

import type { KeyInput } from "./keys.js";

export interface PromptOptions {
    /** The raw stdin slice — the same shape `attachKeys` takes. */
    input: KeyInput;
    /** What sits before the cursor, e.g. `"you › "`. */
    label: string;
    /** Draw the whole line (label + text). `null` clears it. */
    render(line: string | null): void;
    /** Enter on a non-empty line. The prompt stays open, ready for the next one. */
    onSubmit(text: string): void;
    /** Esc, Ctrl-C, Ctrl-D or Enter on an empty line. Always the last call. */
    onClose?(): void;
}

export interface OpenPrompt {
    /** What has been typed so far. */
    readonly value: string;
    /** Close it from the outside (quitting, an agent going away). Idempotent. */
    close(): void;
}

/**
 * Take the terminal row and read a line. Returns null off a TTY — the caller
 * prints a notice instead of hanging on a stream that will never deliver a key.
 */
export function openPrompt(opts: PromptOptions): OpenPrompt | null {
    const input = opts.input;
    if (!input.isTTY) return null;

    let buffer = "";
    let closed = false;

    const draw = () => opts.render(opts.label + buffer);

    const close = () => {
        if (closed) return;
        closed = true;
        input.off("data", onData);
        opts.render(null);
        opts.onClose?.();
    };

    const onData = (chunk: string) => {
        if (closed) return;
        const text = String(chunk);

        // An escape SEQUENCE (arrows, home, a mouse report) is not Esc: it is
        // input we have no use for. Bare Esc — and only bare Esc — closes.
        if (text.startsWith("\x1b")) {
            if (text === "\x1b") close();
            return;
        }

        for (const ch of text) {
            if (closed) return;
            if (ch === "\r" || ch === "\n") {
                const line = buffer.trim();
                buffer = "";
                if (line === "") { close(); return; }
                draw();
                opts.onSubmit(line);
                continue;
            }
            if (ch === "\x03" || ch === "\x04") { close(); return; }  // Ctrl-C / Ctrl-D
            if (ch === "\x7f" || ch === "\b") { buffer = buffer.slice(0, -1); continue; }
            if (ch === "\x15") { buffer = ""; continue; }             // Ctrl-U: kill the line
            if (ch < " ") continue;                                    // any other control byte
            buffer += ch;
        }
        if (!closed) draw();
    };

    input.setRawMode?.(true);
    input.resume?.();
    input.setEncoding?.("utf8");
    input.on("data", onData);
    draw();

    return {
        get value() { return buffer; },
        close,
    };
}

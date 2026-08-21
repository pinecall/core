/**
 * Keyboard shortcuts for `pinecall run`.
 *
 * A TTY only: with stdin piped (CI, `| tee`, a supervisor) nothing is touched —
 * no raw mode, no listener, no swallowed input. Raw mode also means Ctrl-C no
 * longer arrives as SIGINT, so `\x03` is bound to the same graceful quit.
 *
 * The live view owns stdout; this file never writes. Bindings print through
 * the runner, which prints through the view.
 */

/** The slice of process.stdin used — injectable so tests drive a fake. */
export interface KeyInput {
    isTTY?: boolean;
    isRaw?: boolean;
    setRawMode?(raw: boolean): unknown;
    resume?(): unknown;
    pause?(): unknown;
    setEncoding?(enc: string): unknown;
    on(event: "data", handler: (chunk: string) => void): unknown;
    off(event: "data", handler: (chunk: string) => void): unknown;
    unref?(): unknown;
}

export interface KeysOptions {
    input: KeyInput;
    /** key → what it does. Single lowercase characters. */
    bindings: Record<string, () => void>;
    /** `q` and Ctrl-C. Called once; the runner closes the server and exits. */
    onQuit: () => void;
}

/** Bind the keys. Returns the release (restores cooked mode). No-op off a TTY. */
export function attachKeys(opts: KeysOptions): () => void {
    const input = opts.input;
    if (!input.isTTY) return () => {};

    let quitting = false;
    const onData = (chunk: string) => {
        const key = String(chunk);
        if (key === "\x03" || key === "q") {
            if (quitting) return;
            quitting = true;
            opts.onQuit();
            return;
        }
        const action = opts.bindings[key.toLowerCase()];
        if (action) action();
    };

    input.setRawMode?.(true);
    input.resume?.();
    input.setEncoding?.("utf8");
    input.on("data", onData);

    return () => {
        input.off("data", onData);
        input.setRawMode?.(false);
        input.pause?.();
    };
}

/** Open a URL in the default browser. Returns false when the platform is unknown. */
export function openInBrowser(
    url: string,
    spawn: (cmd: string, args: string[], opts: { stdio: "ignore"; detached: boolean }) => { unref(): void },
    platform: string = process.platform,
): boolean {
    const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
    const args = platform === "win32" ? ["/c", "start", "", url] : [url];
    try {
        spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
        return true;
    } catch {
        return false;
    }
}

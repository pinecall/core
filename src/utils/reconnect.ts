/**
 * Exponential backoff reconnection logic.
 */

export interface ReconnectOptions {
    /** Initial delay in ms (default: 1000) */
    initialDelay?: number;
    /** Maximum delay in ms (default: 30000) */
    maxDelay?: number;
    /** Multiplier per attempt (default: 2) */
    factor?: number;
    /** Add random jitter 0-25% (default: true) */
    jitter?: boolean;
}

const DEFAULTS: Required<ReconnectOptions> = {
    initialDelay: 1000,
    maxDelay: 30000,
    factor: 2,
    jitter: true,
};

export class Reconnector {
    private opts: Required<ReconnectOptions>;
    private _attempt = 0;
    private _timer: ReturnType<typeof setTimeout> | null = null;

    constructor(opts?: ReconnectOptions) {
        this.opts = { ...DEFAULTS, ...opts };
    }

    get attempt(): number {
        return this._attempt;
    }

    /** Calculate delay for the next attempt. */
    nextDelay(): number {
        const base = Math.min(
            this.opts.initialDelay * Math.pow(this.opts.factor, this._attempt),
            this.opts.maxDelay,
        );
        const jitter = this.opts.jitter ? base * Math.random() * 0.25 : 0;
        this._attempt++;
        return Math.round(base + jitter);
    }

    /** Wait for the next backoff delay. Returns the delay used. */
    async wait(): Promise<number> {
        const delay = this.nextDelay();
        await new Promise<void>((resolve) => {
            this._timer = setTimeout(resolve, delay);
        });
        return delay;
    }

    /** Reset attempt counter (call on successful connection). */
    reset(): void {
        this._attempt = 0;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }

    /** Cancel any pending wait. */
    cancel(): void {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }
}

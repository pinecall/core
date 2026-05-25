/**
 * Reconnector — exponential backoff reconnection logic.
 *
 * Port of src.bkp/utils/reconnect.ts with maxAttempts addition.
 * When maxAttempts is exceeded, wait() rejects.
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
    /** Maximum attempts before giving up (default: Infinity) */
    maxAttempts?: number;
}

const DEFAULTS: Required<ReconnectOptions> = {
    initialDelay: 1000,
    maxDelay: 30000,
    factor: 2,
    jitter: true,
    maxAttempts: Infinity,
};

export class Reconnector {
    #opts: Required<ReconnectOptions>;
    #attempt = 0;
    #timer: ReturnType<typeof setTimeout> | null = null;

    constructor(opts?: ReconnectOptions) {
        this.#opts = { ...DEFAULTS, ...opts };
    }

    get attempt(): number {
        return this.#attempt;
    }

    /** Calculate delay for the next attempt. */
    nextDelay(): number {
        const base = Math.min(
            this.#opts.initialDelay * Math.pow(this.#opts.factor, this.#attempt),
            this.#opts.maxDelay,
        );
        const jitter = this.#opts.jitter ? base * Math.random() * 0.25 : 0;
        this.#attempt++;
        return Math.round(base + jitter);
    }

    /** Wait for the next backoff delay. Rejects if maxAttempts exceeded. */
    async wait(): Promise<number> {
        if (this.#attempt >= this.#opts.maxAttempts) {
            throw new Error(`Reconnect failed after ${this.#opts.maxAttempts} attempts`);
        }
        const delay = this.nextDelay();
        await new Promise<void>((resolve) => {
            this.#timer = setTimeout(resolve, delay);
        });
        return delay;
    }

    /** Reset attempt counter (call on successful connection). */
    reset(): void {
        this.#attempt = 0;
        if (this.#timer) {
            clearTimeout(this.#timer);
            this.#timer = null;
        }
    }

    /** Cancel any pending wait. */
    cancel(): void {
        if (this.#timer) {
            clearTimeout(this.#timer);
            this.#timer = null;
        }
    }
}

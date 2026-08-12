/**
 * TypedEventBus — zero-dependency typed event emitter.
 *
 * Improvements over the previous TypedEmitter:
 *   1. Handler errors routed to onError callback (not console.error).
 *   2. once-handlers removed BEFORE invocation (prevents re-entry bugs).
 *   3. emit is protected (subclass-only).
 *   4. listenerCount() added.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EventMap = { [key: string]: (...args: any[]) => void };

export interface EventBusOptions {
    /** Called when a handler throws. If unset, error surfaces via queueMicrotask. */
    onError?: (err: unknown, event: string, args: unknown[]) => void;
}

export class TypedEventBus<E extends EventMap> {
    #handlers = new Map<keyof E, Set<E[keyof E]>>();
    #onceSet = new WeakSet<Function>();
    #onError: ((err: unknown, event: string, args: unknown[]) => void) | undefined;

    constructor(opts?: EventBusOptions) {
        this.#onError = opts?.onError;
    }

    on<K extends keyof E>(event: K, handler: E[K]): this {
        let set = this.#handlers.get(event);
        if (!set) {
            set = new Set();
            this.#handlers.set(event, set);
        }
        set.add(handler);
        return this;
    }

    off<K extends keyof E>(event: K, handler: E[K]): this {
        this.#handlers.get(event)?.delete(handler);
        return this;
    }

    once<K extends keyof E>(event: K, handler: E[K]): this {
        const wrapped = ((...args: Parameters<E[K]>) => {
            // Remove BEFORE invocation — prevents re-entry from re-emitting
            this.off(event, wrapped as E[K]);
            (handler as (...a: unknown[]) => void)(...args);
        }) as E[K];
        this.#onceSet.add(wrapped);
        return this.on(event, wrapped);
    }

    protected emit<K extends keyof E>(event: K, ...args: Parameters<E[K]>): void {
        const set = this.#handlers.get(event);
        if (!set) return;
        for (const handler of set) {
            try {
                (handler as (...a: unknown[]) => void)(...args);
            } catch (err) {
                if (this.#onError) {
                    this.#onError(err, String(event), args as unknown[]);
                } else {
                    // Surface via unhandled rejection — never swallow silently
                    queueMicrotask(() => { throw err; });
                }
            }
        }
    }

    /**
     * Like `emit`, but KEEPS what each handler returned.
     *
     * Exists for `call.preparing`: the server holds the turn open while the app
     * refreshes its per-turn variables, so the SDK has to know when the app is
     * actually done — which for an async handler means awaiting the promise it
     * returned. Plain `emit` throws that value away, and the SDK could only
     * guess, which is exactly how the barrier used to be lost.
     */
    protected emitCollect<K extends keyof E>(event: K, ...args: Parameters<E[K]>): unknown[] {
        const set = this.#handlers.get(event);
        if (!set) return [];
        const results: unknown[] = [];
        for (const handler of set) {
            try {
                results.push((handler as (...a: unknown[]) => unknown)(...args));
            } catch (err) {
                if (this.#onError) {
                    this.#onError(err, String(event), args as unknown[]);
                } else {
                    queueMicrotask(() => { throw err; });
                }
            }
        }
        return results;
    }

    listenerCount<K extends keyof E>(event: K): number {
        return this.#handlers.get(event)?.size ?? 0;
    }

    removeAllListeners(event?: keyof E): void {
        if (event) {
            this.#handlers.delete(event);
        } else {
            this.#handlers.clear();
        }
    }
}

/**
 * Typed EventEmitter — zero dependencies.
 *
 * Usage:
 *   const ee = new TypedEmitter<{ "foo": (x: number) => void }>();
 *   ee.on("foo", (x) => console.log(x));   // x is typed as number
 *   ee.emit("foo", 42);
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventMap = { [key: string]: (...args: any[]) => void };

export class TypedEmitter<E extends EventMap> {
    private _handlers = new Map<keyof E, Set<E[keyof E]>>();

    on<K extends keyof E>(event: K, handler: E[K]): this {
        let set = this._handlers.get(event);
        if (!set) {
            set = new Set();
            this._handlers.set(event, set);
        }
        set.add(handler);
        return this;
    }

    off<K extends keyof E>(event: K, handler: E[K]): this {
        this._handlers.get(event)?.delete(handler);
        return this;
    }

    once<K extends keyof E>(event: K, handler: E[K]): this {
        const wrapped = ((...args: Parameters<E[K]>) => {
            this.off(event, wrapped as E[K]);
            (handler as (...a: unknown[]) => void)(...args);
        }) as E[K];
        return this.on(event, wrapped);
    }

    protected emit<K extends keyof E>(event: K, ...args: Parameters<E[K]>): void {
        const set = this._handlers.get(event);
        if (!set) return;
        for (const handler of set) {
            try {
                (handler as (...a: unknown[]) => void)(...args);
            } catch (err) {
                console.error(`[pinecall] Error in "${String(event)}" handler:`, err);
            }
        }
    }

    removeAllListeners(event?: keyof E): void {
        if (event) {
            this._handlers.delete(event);
        } else {
            this._handlers.clear();
        }
    }
}

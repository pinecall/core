/**
 * Dispatcher — ordered handler registry, first-match wins.
 *
 * Built once at Pinecall construction time with all handlers.
 * For each incoming WireEvent, the dispatcher iterates handlers
 * and stops at the first one that returns true.
 */

import type { EventHandler, DispatchContext } from "./handler.js";
import type { WireEvent } from "../protocol/wire.js";

export class Dispatcher {
    readonly #handlers: EventHandler[];
    readonly #eventMap: Map<string, EventHandler[]>;

    constructor(handlers: EventHandler[]) {
        this.#handlers = handlers;
        // Pre-build a lookup map: event name → handlers that care about it
        this.#eventMap = new Map();
        for (const handler of handlers) {
            for (const event of handler.events) {
                let list = this.#eventMap.get(event);
                if (!list) {
                    list = [];
                    this.#eventMap.set(event, list);
                }
                list.push(handler);
            }
        }
    }

    dispatch(wire: WireEvent, ctx: DispatchContext): boolean {
        const eventName = wire.event;
        const handlers = this.#eventMap.get(eventName);

        if (handlers) {
            for (const handler of handlers) {
                if (handler.handle(wire, ctx)) return true;
            }
        }

        // Fall back to wildcard handlers (those listening to "*")
        const wildcards = this.#eventMap.get("*");
        if (wildcards) {
            for (const handler of wildcards) {
                if (handler.handle(wire, ctx)) return true;
            }
        }

        return false;
    }
}

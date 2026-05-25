/**
 * System handler — heartbeat and connection maintenance.
 *
 * Handles: ping (server-initiated)
 * Responds with pong.
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";

export class SystemHandler implements EventHandler {
    readonly events = ["ping"] as const;

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        if (wire.event === "ping") {
            ctx.send({ event: "pong" });
            return true;
        }
        return false;
    }
}

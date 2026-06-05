/**
 * RingingCall — lightweight handle for an inbound call pending accept/reject.
 *
 * Created when the server sends `call.ringing` (opt-in via `ringing: true`
 * on the phone channel). Unlike `Call`, this object only has `accept()` and
 * `reject()` — no `say()`, `reply()`, `hangup()`, etc.
 *
 * If neither method is called within the server timeout (5s), the call is
 * auto-accepted and `call.started` fires as usual.
 */

export class RingingCall {
    readonly callId: string;
    readonly from: string;
    readonly to: string;
    readonly direction: "inbound" = "inbound";

    #send: (data: Record<string, unknown>) => void;
    #agentId: string;
    #settled = false;

    constructor(
        data: { callId: string; from: string; to: string; agentId: string },
        send: (data: Record<string, unknown>) => void,
    ) {
        this.callId = data.callId;
        this.from = data.from;
        this.to = data.to;
        this.#agentId = data.agentId;
        this.#send = send;
    }

    /** Whether accept() or reject() has been called. */
    get settled(): boolean {
        return this.#settled;
    }

    /** Accept the call — proceeds to call.started. */
    accept(): void {
        if (this.#settled) return;
        this.#settled = true;
        this.#send({
            event: "call.accept",
            agent_id: this.#agentId,
            call_id: this.callId,
        });
    }

    /**
     * Reject the call — caller hears a rejection tone, call.started never fires.
     *
     * @param reason - `"busy"` (busy tone) or `"rejected"` (generic rejection).
     *                 Default: `"busy"`.
     */
    reject(reason: "busy" | "rejected" = "busy"): void {
        if (this.#settled) return;
        this.#settled = true;
        this.#send({
            event: "call.reject",
            agent_id: this.#agentId,
            call_id: this.callId,
            reason,
        });
    }
}

/**
 * phone-routing — READ BACK who actually answers a number, instead of assuming.
 *
 * WHY THIS EXISTS (the mechanism, from the server's code — not guessed):
 *
 * `agent.addPhoneNumber(n)` sends `channel.add` over the client WebSocket and
 * returns immediately. It is FIRE-AND-FORGET: the SDK never awaits an ack.
 *
 * On the server (sdk-server `transports/client/handler.py`, `channel.add`),
 * a `dev-` slug does NOT claim the number in the prod map — it writes into
 * `ClientManager._phone_dev_override`, and only if the number is free of OTHER
 * non-prod agents:
 *
 *     existing_dev_ckey = client_manager._phone_dev_override.get(normalized)
 *     if existing_dev_ckey and existing_dev_ckey != ckey:
 *         if existing_dev.is_active:  ->  send {"event":"error","code":"PHONE_IN_USE"}; continue
 *
 * `continue` — the override is NOT moved. The rejection comes back as a plain
 * `error` event, and the SDK's ErrorHandler (src/dispatch/handlers/error.ts)
 * handles it by `console.warn` + deleting the local channel. Nothing rejects,
 * nothing throws, `agent.ready` has already fired. That is exactly how
 * configure_agent came to report `phoneNumber: "+1318..."` for a number whose
 * dev override belonged to `dev-bistro` — and a real inbound call proved it.
 *
 * So the only honest answer comes from reading the server's live state back:
 * `GET /api/sdk/agents` returns `dev_overrides` (phone -> slug, built straight
 * from `_phone_dev_override`, filtered to active agents and this org),
 * `phone_map` (the prod route) and `dev_callers`.
 *
 * And `dev_callers` matters for the truth too: `get_client_for_phone`
 * (session/manager.py) only honours a dev override when the CALLER is in
 * `_dev_allowed_callers` — when that whitelist is non-empty, every other caller
 * falls through to the prod agent. A `routed: true` that hides this would be
 * the same class of lie in a smaller box.
 *
 * Taking an override away from a LIVE dev agent is not possible from here: the
 * server refuses it. It frees itself when that agent's socket closes (see
 * `unregister_client` clearing `_phone_dev_override`), or via `pinecall kick`.
 */

/** The shape of `GET /api/sdk/agents` we depend on. */
export interface RoutingState {
    phone_map?: Record<string, string> | null;
    dev_overrides?: Record<string, string> | null;
    dev_callers?: string[] | null;
}

export interface PhoneRouting {
    /** The number as the SERVER keys it — normalized exactly like `_normalize_phone`. */
    number: string;
    /** True only when this slug actually holds the route right now. */
    routed: boolean;
    /** The slug that actually holds it, when it is not ours. */
    routedTo?: string;
    /** Plain-language why, always present. */
    reason: string;
    /** The number a human should dial to reach THIS agent — null when nobody should. */
    dial: string | null;
    /** Present when a caller whitelist is active: ONLY these callers reach the dev agent. */
    callersWhitelist?: string[];
}

/**
 * Mirror of sdk-server `ClientManager._normalize_phone`. The maps are keyed by
 * its output, so comparing against the raw argument would miss a match on any
 * formatted input (`+1 318 633 0963`).
 */
export function normalizePhone(phone: string): string {
    const stripped = phone.trim();
    if (stripped.toLowerCase().startsWith("sip:")) {
        const rest = stripped.slice(4);
        const user = rest.includes("@") ? rest.split("@")[0]! : rest;
        if (/^\d{7,}$/.test(user)) return "+" + user;
        return stripped;
    }
    const cleaned = stripped.replace(/[\s\-()]/g, "");
    return cleaned.startsWith("+") ? cleaned : "+" + cleaned;
}

/** Decide the truth from one snapshot of the server's routing state. */
export function judgeRouting(slug: string, phone: string, state: RoutingState): PhoneRouting {
    const number = normalizePhone(phone);
    const overrides = state.dev_overrides ?? {};
    const prod = state.phone_map ?? {};
    const callers = (state.dev_callers ?? []).filter(Boolean);
    const holder = overrides[number];
    const prodOwner = prod[number];

    if (holder === slug) {
        if (callers.length > 0) {
            return {
                number,
                routed: true,
                reason:
                    `"${slug}" holds the dev route for ${number}, but a dev caller whitelist is active on this org: ` +
                    `the server only sends a call to a dev agent when the CALLER is one of ${callers.join(", ")}. ` +
                    `A call from any other number falls through to ` +
                    (prodOwner ? `the production agent "${prodOwner}"` : "no agent at all") + `.`,
                dial: number,
                callersWhitelist: callers,
            };
        }
        return {
            number,
            routed: true,
            reason: `The server's dev_overrides map has ${number} -> "${slug}", so an inbound call to it reaches this agent (dev overrides win over the production map) for as long as this session holds the agent open.`,
            dial: number,
        };
    }

    if (holder) {
        return {
            number,
            routed: false,
            routedTo: holder,
            reason:
                `NOT ROUTED. ${number} is held by the dev agent "${holder}", which is connected right now, so the server ` +
                `REFUSED this claim with PHONE_IN_USE (transports/client/handler.py) and left the override where it was — ` +
                `an inbound call to ${number} reaches "${holder}", not "${slug}". This cannot be taken from here: the ` +
                `override is only released when "${holder}" disconnects (\`pinecall kick ${holder}\`, or stopping that ` +
                `process), and then this agent must be configured again. Pick a free number with list_phones instead. ` +
                `Do NOT tell anyone to dial ${number} to reach "${slug}".`,
            dial: null,
        };
    }

    if (prodOwner) {
        return {
            number,
            routed: false,
            routedTo: prodOwner,
            reason:
                `NOT ROUTED. The server has no dev override for ${number} — the claim never landed — and the number is ` +
                `answered by the production agent "${prodOwner}". Do NOT tell anyone to dial it to reach "${slug}".`,
            dial: null,
        };
    }

    return {
        number,
        routed: false,
        reason:
            `NOT ROUTED. After registering, the server's routing state has no entry for ${number} at all — neither a dev ` +
            `override nor a production owner. Check the number is in this org's inventory (list_phones); it may not be ` +
            `imported, in which case no call can arrive on it.`,
        dial: null,
    };
}

/**
 * Poll `GET /api/sdk/agents` until the override we asked for shows up, and
 * judge whatever is there when we stop.
 *
 * The poll exists because `channel.add` is fire-and-forget: the write to
 * `_phone_dev_override` happens on the server AFTER `agent.created` came back,
 * so a single immediate read can be a false negative. A rejection, by contrast,
 * is stable — so we only retry while the answer is "not ours yet".
 */
export async function verifyPhoneRouting(
    slug: string,
    phone: string,
    read: () => Promise<RoutingState>,
    opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<PhoneRouting> {
    const attempts = opts.attempts ?? 4;
    const delayMs = opts.delayMs ?? 400;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    let last: PhoneRouting | undefined;
    for (let i = 0; i < attempts; i++) {
        if (i > 0) await sleep(delayMs);
        last = judgeRouting(slug, phone, await read());
        // Ours, or somebody else's — both are settled answers. Only "nothing
        // there yet" is worth another look.
        if (last.routed || last.routedTo) return last;
    }
    return last!;
}

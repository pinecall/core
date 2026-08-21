/**
 * `pinecall run agent.mjs --call +34600000000` — the agent rings YOU.
 *
 * The fastest possible loop for a voice agent: no phone to pick up in the web
 * console, no browser, no Twilio console. The runner waits until the agent is
 * registered server-side and then places one outbound call through the ordinary
 * SDK path (`agent.dial`), so the call arrives at both observers — the terminal
 * live view and the web console — as any other call does.
 *
 * Nothing here prints: it returns the line to print. The runner owns stdout
 * (through the live view), and library code never console.logs.
 *
 * Every refusal is a REASON plus the fix, on one line. `agent.dial` already
 * rejects fast with the carrier's own word (`no-answer`, `busy`, `failed`,
 * `canceled`) instead of hanging for 30s, so the developer learns why the
 * phone did not ring while they are still looking at the terminal.
 */

/** The slice of Agent used to place the call. */
export interface DialAgentLike {
    id: string;
    _getChannels(): Map<string, { type: string; ref?: string }>;
    dial(options: {
        to: string;
        metadata?: Record<string, unknown>;
    }): Promise<{ id?: string; to?: string } | undefined>;
}

export type RingRefusal = "bad_number" | "no_phone" | "refused";

export interface RingResult {
    ok: boolean;
    /** Why not, when `ok` is false. */
    reason?: RingRefusal;
    /** One line, ready to print: what happened and — when it failed — the fix. */
    message: string;
    /** The number that was actually dialled (trimmed). */
    to: string;
}

/**
 * E.164, or a SIP URI. Deliberately strict about the leading `+`: "600000000"
 * reaching Twilio as a national number is a support ticket, not a call.
 */
export function isDialable(to: string): boolean {
    const v = to.trim();
    if (v.toLowerCase().startsWith("sip:")) return v.length > 4;
    return /^\+[1-9]\d{6,14}$/.test(v);
}

/** The agent's first phone channel — what an outbound call is placed FROM. */
export function phoneChannels(agent: DialAgentLike): string[] {
    const found: string[] = [];
    for (const [, ch] of agent._getChannels()) {
        if (ch.type === "phone" && ch.ref && !found.includes(ch.ref)) found.push(ch.ref);
    }
    return found;
}

/**
 * Place the call. Never throws — a refusal is a value, because the runner shows
 * it and keeps running: the agent is still live and still worth talking to.
 */
export async function ringMe(agent: DialAgentLike, rawTo: string): Promise<RingResult> {
    const to = rawTo.trim();

    if (!isDialable(to)) {
        return {
            ok: false, reason: "bad_number", to,
            message: `--call ${to || "(empty)"} is not a number I can dial — use E.164, e.g. --call +34600000000`,
        };
    }

    const phones = phoneChannels(agent);
    if (phones.length === 0) {
        return {
            ok: false, reason: "no_phone", to,
            message: `${agent.id} has no phone number to call FROM — give it one (phoneNumber: "+1…" in the agent config, or agent.addPhoneNumber("+1…")) and run again`,
        };
    }

    try {
        const call = await agent.dial({ to, metadata: { console: true } });
        return { ok: true, to, message: `ringing ${to} from ${phones[0]}${call?.id ? ` · ${call.id}` : ""}` };
    } catch (err) {
        return { ok: false, reason: "refused", to, message: refusal(to, err) };
    }
}

/** Carrier and server refusals in the developer's language, with the fix. */
export function refusal(to: string, err: unknown): string {
    const raw = ((err as Error)?.message ?? String(err)).trim();
    const known: Record<string, string> = {
        "no-answer": `${to} did not answer`,
        busy: `${to} is busy`,
        canceled: `the call to ${to} was canceled`,
        failed: `the carrier could not complete the call to ${to} — check the number and that the caller ID is verified`,
    };
    const hit = known[raw.toLowerCase()];
    if (hit) return hit;
    if (/dial timeout/i.test(raw)) {
        return `no answer from the server for the call to ${to} — is the agent still connected?`;
    }
    if (/multiple phone channels/i.test(raw)) {
        return `${raw} — --call uses the agent's only number, so dial from your own code when there are several`;
    }
    if (/plan|upgrade|not allowed|forbidden|payment/i.test(raw)) {
        return `outbound calling is not enabled on this plan — ${raw}`;
    }
    return `could not call ${to} — ${raw}`;
}

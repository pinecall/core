/**
 * Balance API — Twilio and account balance.
 */

import { DEFAULT_API_URL } from "./http.js";

export interface FetchTwilioBalanceOptions {
    apiKey?: string;
    apiUrl?: string;
}

export interface TwilioBalance {
    balance: string;
    currency: string;
}

export interface FetchBalanceOptions {
    apiKey: string;
    apiUrl?: string;
}

export interface Balance {
    balance: string;
    currency: string;
}

export async function fetchTwilioBalance(opts: FetchTwilioBalanceOptions = {}): Promise<TwilioBalance | null> {
    const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
    const url = `${apiUrl}/api/sdk/twilio-balance`;

    const headers: Record<string, string> = {};
    if (opts.apiKey) headers["Authorization"] = `Bearer ${opts.apiKey}`;

    let res: Response;
    try {
        res = await fetch(url, { headers });
    } catch {
        return null;
    }

    if (!res.ok) return null;

    const data = await res.json();
    if (!data.success) return null;

    return {
        balance: data.balance,
        currency: data.currency,
    };
}

export async function fetchBalance(_opts: FetchBalanceOptions): Promise<Balance | null> {
    throw new Error("fetchBalance is not yet implemented. Use fetchTwilioBalance() for now.");
}

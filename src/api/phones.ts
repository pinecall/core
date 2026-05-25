/**
 * Phone API — fetch account phone numbers.
 */

import { DEFAULT_API_URL } from "./http.js";

export interface Phone {
    number: string;
    name: string;
    sid: string;
    isSdk?: boolean;
}

export interface FetchPhonesOptions {
    apiKey: string;
    apiUrl?: string;
}

export async function fetchPhones(opts: FetchPhonesOptions): Promise<Phone[]> {
    const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
    const url = `${apiUrl}/api/sdk/phone-numbers`;

    let res: Response;
    try {
        res = await fetch(url, {
            headers: { Authorization: `Bearer ${opts.apiKey}` },
        });
    } catch (err) {
        throw new Error(`Network error fetching phone numbers: ${err}`);
    }

    if (!res.ok) {
        throw new Error(`Failed to fetch phone numbers: HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data.success) return [];

    const raw: Record<string, unknown>[] = data.phones ?? data.phoneNumbers ?? [];
    return raw.map(mapPhone);
}

function mapPhone(raw: Record<string, unknown>): Phone {
    return {
        number: (raw.number ?? "") as string,
        name: (raw.name ?? raw.number ?? "") as string,
        sid: (raw.sid ?? "") as string,
        isSdk: (raw.isSdk ?? false) as boolean,
    };
}

/**
 * list_phones — every phone number in the org, and who holds it.
 *
 * Two sources, and the difference between them is the whole point of the tool:
 *
 *   GET {playground}/api/playground/phones  → the org's numbers and their
 *       STORED assignment: `[{number, name, agent|null}]` plus the same thing as a
 *       `phone_map`. This is the durable truth — it survives the owning process being
 *       down, which is exactly why the CLI's live-only view is not enough here: a
 *       number whose agent is merely offline is NOT free, and the server refuses to
 *       let a second agent claim it.
 *
 *   GET {server}/api/sdk/agents  → the LIVE in-memory routing map of the agents
 *       connected right now: `phone_map` (who is answering) and `dev_overrides`
 *       (a `dev-` agent that has temporarily hijacked a number; it evaporates when
 *       that agent disconnects and the stored owner takes the number back).
 *
 * So `agent` is the owner, `live` says whether that owner is actually up, and
 * `dev_override` is the temporary hijack. Only a row with `agent: null` is free.
 *
 * A number that only exists in a routing map (an agent declaring a number the org
 * never imported) is merged in and flagged `inInventory: false` rather than dropped.
 */

import { z } from "zod";
import { defineTool } from "./types.js";

interface OrgPhone { number: string; name?: string; agent?: string | null }
interface PlaygroundPhonesResponse { phones?: OrgPhone[]; phone_map?: Record<string, string> }
interface AgentsResponse {
    phone_map?: Record<string, string>;
    dev_overrides?: Record<string, string> | null;
}

/**
 * Canadian NANP area codes — the ONLY way to split +1 into US vs CA, since both
 * share the dialling code. A finite, slow-moving list; anything else under +1 is US.
 */
const CA_AREA_CODES = new Set([
    "204", "226", "236", "249", "250", "263", "289", "306", "343", "354", "365", "367",
    "368", "382", "387", "403", "416", "418", "428", "431", "437", "438", "450", "468",
    "474", "506", "514", "519", "548", "579", "581", "584", "587", "600", "604", "613",
    "639", "647", "672", "683", "705", "709", "742", "753", "778", "780", "782", "807",
    "819", "825", "867", "873", "879", "902", "905",
]);

/** Dialling code → ISO 3166-1 alpha-2, longest prefix wins. Unknown → null. */
const DIAL_CODES: Record<string, string> = {
    "20": "EG", "27": "ZA", "30": "GR", "31": "NL", "32": "BE", "33": "FR", "34": "ES",
    "36": "HU", "39": "IT", "40": "RO", "41": "CH", "43": "AT", "44": "GB", "45": "DK",
    "46": "SE", "47": "NO", "48": "PL", "49": "DE", "51": "PE", "52": "MX", "53": "CU",
    "54": "AR", "55": "BR", "56": "CL", "57": "CO", "58": "VE", "60": "MY", "61": "AU",
    "62": "ID", "63": "PH", "64": "NZ", "65": "SG", "66": "TH", "81": "JP", "82": "KR",
    "84": "VN", "86": "CN", "90": "TR", "91": "IN", "92": "PK", "93": "AF", "94": "LK",
    "95": "MM", "98": "IR", "212": "MA", "213": "DZ", "216": "TN", "218": "LY",
    "220": "GM", "233": "GH", "234": "NG", "254": "KE", "255": "TZ", "256": "UG",
    "263": "ZW", "351": "PT", "352": "LU", "353": "IE", "354": "IS", "355": "AL",
    "356": "MT", "357": "CY", "358": "FI", "359": "BG", "370": "LT", "371": "LV",
    "372": "EE", "380": "UA", "381": "RS", "385": "HR", "386": "SI", "420": "CZ",
    "421": "SK", "852": "HK", "886": "TW", "961": "LB", "962": "JO", "965": "KW",
    "966": "SA", "971": "AE", "972": "IL", "974": "QA", "977": "NP", "998": "UZ",
};

export function countryOf(number: string): string | null {
    const digits = number.replace(/[^\d]/g, "");
    if (!digits) return null;
    if (digits.startsWith("1")) {
        return CA_AREA_CODES.has(digits.slice(1, 4)) ? "CA" : "US";
    }
    if (digits.startsWith("7")) return "RU";
    for (const len of [3, 2]) {
        const iso = DIAL_CODES[digits.slice(0, len)];
        if (iso) return iso;
    }
    return null;
}

export interface PhoneRow {
    number: string;
    /** The number's OWNER — the stored assignment. null = free, and only then is it claimable. */
    agent: string | null;
    /** true when that owner is connected right now and actually answering. */
    live: boolean;
    /** Present ONLY when a `dev-` agent is temporarily hijacking routing for this number. */
    dev_override?: string;
    country: string | null;
    /** The label a human gave it; omitted when it is just the number reformatted. */
    name?: string;
    /** false = the number appears only in a routing map, not in the org's inventory. */
    inInventory: boolean;
}

export function buildRows(
    phones: OrgPhone[],
    storedMap: Record<string, string>,
    livePhoneMap: Record<string, string>,
    devOverrides: Record<string, string>,
): PhoneRow[] {
    const rows: PhoneRow[] = [];
    const seen = new Set<string>();

    const row = (number: string, name: string | undefined, agent: string | null, inInventory: boolean): PhoneRow => {
        const override = devOverrides[number];
        const owner = agent ?? storedMap[number] ?? livePhoneMap[number] ?? null;
        // Twilio's default friendlyName is the number reformatted ("(218) 414-7420"),
        // country code dropped — carrying that as a "name" is noise, so compare on digits
        // by suffix and keep the label only when a human actually named it.
        const nameDigits = (name ?? "").replace(/[^\d]/g, "");
        const numDigits = number.replace(/[^\d]/g, "");
        const isEcho = nameDigits.length > 0 && numDigits.endsWith(nameDigits);
        const label = name && !isEcho ? name : undefined;
        return {
            number,
            agent: owner,
            live: livePhoneMap[number] !== undefined || override !== undefined,
            ...(override ? { dev_override: override } : {}),
            country: countryOf(number),
            ...(label ? { name: label } : {}),
            inInventory,
        };
    };

    for (const p of phones) {
        if (!p.number || seen.has(p.number)) continue;
        seen.add(p.number);
        rows.push(row(p.number, p.name, p.agent ?? null, true));
    }
    const extra = new Set([...Object.keys(storedMap), ...Object.keys(livePhoneMap), ...Object.keys(devOverrides)]);
    for (const number of extra) {
        if (seen.has(number)) continue;
        seen.add(number);
        rows.push(row(number, undefined, null, false));
    }
    return rows;
}

export default defineTool({
    name: "list_phones",
    description:
        "Every phone number in the org with its assignment (agent slug or free), whether that agent is live, and any dev- routing override.",
    schema: {
        free: z
            .boolean()
            .optional()
            .describe("Only the unassigned numbers — the ones safe to claim."),
    },
    manual: "`agent: null` is the only free number. A stored `agent` with `live: false` is owned-but-offline, NOT free: a second agent steals its calls.",
    async handler(args: { free?: boolean }, { session }) {
        const [org, live] = await Promise.all([
            // The stored assignment — survives the owner being offline.
            session.playground<PlaygroundPhonesResponse>("/playground/phones"),
            // The live routing map + dev overrides.
            session.server<AgentsResponse>("/api/sdk/agents"),
        ]);

        const all = buildRows(
            org.phones ?? [],
            org.phone_map ?? {},
            live.phone_map ?? {},
            live.dev_overrides ?? {},
        );
        const phones = args.free ? all.filter((p) => p.agent === null) : all;

        return {
            phones,
            total: phones.length,
            free: all.filter((p) => p.agent === null).length,
            assigned: all.filter((p) => p.agent !== null).length,
        };
    },
});

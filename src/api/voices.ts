/**
 * Voice API — fetch available TTS voices.
 */

import { DEFAULT_API_URL } from "./http.js";

export interface Voice {
    id: string;
    name: string;
    /** Friendly alias for use in `voice` config, e.g. "sarah" → `"elevenlabs/sarah"` */
    alias?: string;
    provider: string;
    gender?: string;
    style?: string;
    languages: VoiceLanguage[];
    description?: string;
    previewUrl?: string;
}

export interface VoiceLanguage {
    code: string;
    name: string;
    flag?: string;
    nativeName?: string;
    region?: string;
}

export interface FetchVoicesOptions {
    provider?: string;
    language?: string;
    apiUrl?: string;
}

export async function fetchVoices(opts: FetchVoicesOptions = {}): Promise<Voice[]> {
    const provider = opts.provider ?? "elevenlabs";
    const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
    const url = `${apiUrl}/api/sdk/voices?provider=${encodeURIComponent(provider)}`;

    let res: Response;
    try {
        res = await fetch(url);
    } catch (err) {
        throw new Error(`Network error fetching voices: ${err}`);
    }

    if (!res.ok) {
        throw new Error(`Failed to fetch voices: HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data.success || !Array.isArray(data.voices)) return [];

    let voices: Voice[] = data.voices.map(mapVoice(provider));

    if (opts.language) {
        const lang = opts.language.toLowerCase();
        voices = voices.filter((v) =>
            v.languages.some((l) => l.code.toLowerCase().startsWith(lang)),
        );
    }

    return voices;
}

function mapVoice(provider: string): (raw: Record<string, unknown>) => Voice {
    return (v) => ({
        id: (v.id ?? v.voice_id ?? "") as string,
        name: (v.name ?? "Unknown") as string,
        alias: v.alias as string | undefined,
        provider,
        gender: v.gender as string | undefined,
        style: v.style as string | undefined,
        languages: Array.isArray(v.languages) ? v.languages.map(mapLanguage) : [],
        description: v.description as string | undefined,
        previewUrl: v.preview_url as string | undefined,
    });
}

function mapLanguage(raw: unknown): VoiceLanguage {
    if (typeof raw === "string") return { code: raw, name: raw };
    const l = raw as Record<string, unknown>;
    return {
        code: (l.code ?? "") as string,
        name: (l.name ?? "") as string,
        flag: l.flag as string | undefined,
        nativeName: l.nativeName as string | undefined,
        region: l.region as string | undefined,
    };
}

/**
 * Pinecall REST API — fetch voices and phone numbers.
 *
 * These are simple HTTP helpers that talk to the Pinecall management API.
 * They do NOT require a WebSocket connection.
 */

// ─── Types ───────────────────────────────────────────────────────────────

/** A voice available for TTS. */
export interface Voice {
    /** Provider-specific voice ID (use in config `tts.voice_id`). */
    id: string;
    /** Human-readable name. */
    name: string;
    /** TTS provider (e.g. "elevenlabs", "cartesia"). */
    provider: string;
    /** Gender label. */
    gender?: string;
    /** Style label (e.g. "professional", "friendly"). */
    style?: string;
    /** Languages this voice supports. */
    languages: VoiceLanguage[];
    /** Description of the voice characteristics. */
    description?: string;
    /** URL to a preview audio clip. */
    preview_url?: string;
}

export interface VoiceLanguage {
    code: string;
    name: string;
    flag?: string;
    nativeName?: string;
    region?: string;
}

/** A phone number associated with your account. */
export interface Phone {
    /** E.164 format: +12705173618 */
    number: string;
    /** Display name: (270) 517-3618 */
    name: string;
    /** Twilio SID. */
    sid: string;
    /** Whether this phone was registered via SDK. */
    isSdk?: boolean;
}

// ─── Options ─────────────────────────────────────────────────────────────

export interface FetchVoicesOptions {
    /** TTS provider to list voices for. Default: `"elevenlabs"`. */
    provider?: string;
    /** Filter by language code (e.g. `"es"`, `"en"`). */
    language?: string;
    /** SDK server base URL (e.g. `"http://localhost:1337"`). */
    apiUrl?: string;
}

export interface FetchPhonesOptions {
    /** Your Pinecall API key. */
    apiKey: string;
    /** SDK server base URL (e.g. `"http://localhost:1337"`). */
    apiUrl?: string;
}

export interface FetchWebRTCTokenOptions {
    /** Agent ID to get a token for. */
    agentId: string;
    /** Voice server base URL. Default: `"https://voice.pinecall.io"`. */
    apiUrl?: string;
    /**
     * API key for authenticated requests (server-side).
     * When provided, the token endpoint validates the key instead of
     * relying on Origin headers. Recommended for production.
     */
    apiKey?: string;
}

/** WebRTC token response from the Pinecall API. */
export interface WebRTCToken {
    /** Signed HMAC token (wrt_...). */
    token: string;
    /** Voice server URL for the WebRTC connection. */
    server?: string;
}

/** Token response for browser connections (WebRTC or Chat). */
export interface TokenResponse {
    /** Signed token (wrt_... for WebRTC, cht_... for Chat). */
    token: string;
    /** Voice server URL. */
    server: string;
    /** Token TTL in seconds. */
    expires_in: number;
}

export interface CreateTokenOptions {
    /** Channel type to create a token for. */
    channel: "webrtc" | "chat";
    /** Agent ID (slug). */
    agentId: string;
    /** Your Pinecall API key. Required for authenticated token generation. */
    apiKey: string;
    /** Voice server base URL. Default: `"https://voice.pinecall.io"`. */
    apiUrl?: string;
}

// ─── API ─────────────────────────────────────────────────────────────────

const DEFAULT_API_URL = "https://voice.pinecall.io";

/**
 * Fetch available TTS voices from the Pinecall API.
 *
 * @example
 * ```ts
 * const voices = await fetchVoices({ provider: "elevenlabs", language: "es" });
 * voices.forEach(v => console.log(`${v.name} (${v.id})`));
 * ```
 */
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
    if (!data.success || !Array.isArray(data.voices)) {
        return [];
    }

    let voices: Voice[] = data.voices.map(mapVoice(provider));

    // Filter by language if requested
    if (opts.language) {
        const lang = opts.language.toLowerCase();
        voices = voices.filter((v) =>
            v.languages.some((l) => l.code.toLowerCase().startsWith(lang)),
        );
    }

    return voices;
}

/**
 * Fetch phone numbers associated with your Pinecall account.
 *
 * @example
 * ```ts
 * const phones = await fetchPhones({ apiKey: "pk_..." });
 * phones.forEach(p => console.log(`${p.name} → ${p.number}`));
 * ```
 */
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
    if (!data.success) {
        return [];
    }

    // Server may return either "phones" or "phoneNumbers" depending on API version
    const raw: Record<string, unknown>[] = data.phones ?? data.phoneNumbers ?? [];

    return raw.map(mapPhone);
}

/**
 * Fetch a WebRTC token for browser connections.
 *
 * When `apiKey` is provided, sends an authenticated request (recommended
 * for server-side usage). Otherwise falls back to public access (requires
 * the agent to have `allowedOrigins` configured).
 *
 * @example
 * ```ts
 * // Server-side (authenticated — recommended)
 * const { token, server } = await fetchWebRTCToken({ agentId: "my-agent", apiKey: "pk_..." });
 *
 * // Browser-side (requires allowedOrigins on the agent)
 * const { token, server } = await fetchWebRTCToken({ agentId: "my-agent" });
 * ```
 */
export async function fetchWebRTCToken(opts: FetchWebRTCTokenOptions): Promise<WebRTCToken> {
    const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
    const headers: Record<string, string> = {};
    if (opts.apiKey) headers["Authorization"] = `Bearer ${opts.apiKey}`;

    let res: Response;
    try {
        res = await fetch(
            `${apiUrl}/webrtc/token?agent_id=${encodeURIComponent(opts.agentId)}`,
            { headers },
        );
    } catch (err) {
        throw new Error(`Network error fetching WebRTC token: ${err}`);
    }

    if (!res.ok) {
        const data = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(`Failed to fetch WebRTC token: ${(data as any).detail || `HTTP ${res.status}`}`);
    }

    const data = await res.json() as Record<string, unknown>;
    if (typeof data.token !== "string") {
        throw new Error("WebRTC token response missing 'token' field");
    }

    return {
        token: data.token,
        server: (data.server as string) || undefined,
    };
}

/**
 * Create a signed token for browser connections (WebRTC or Chat).
 *
 * This is the **recommended** way to generate tokens for production.
 * The API key authenticates the request — no Origin header validation needed.
 *
 * @example
 * ```ts
 * // In your Express/Next.js route handler:
 * app.get("/api/token", authMiddleware, async (req, res) => {
 *   const token = await createToken({
 *     channel: "webrtc",
 *     agentId: "florencia",
 *     apiKey: process.env.PINECALL_API_KEY!,
 *   });
 *   res.json(token);
 * });
 * ```
 */
export async function createToken(opts: CreateTokenOptions): Promise<TokenResponse> {
    const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
    const endpoint = opts.channel === "chat" ? "/chat/token" : "/webrtc/token";
    const url = `${apiUrl}${endpoint}?agent_id=${encodeURIComponent(opts.agentId)}`;

    let res: Response;
    try {
        res = await fetch(url, {
            headers: { Authorization: `Bearer ${opts.apiKey}` },
        });
    } catch (err) {
        throw new Error(`Network error creating ${opts.channel} token: ${err}`);
    }

    if (!res.ok) {
        const data = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(
            `Failed to create ${opts.channel} token: ${(data as any).detail || `HTTP ${res.status}`}`,
        );
    }

    const data = await res.json() as Record<string, unknown>;
    if (typeof data.token !== "string") {
        throw new Error(`Token response missing 'token' field`);
    }

    return {
        token: data.token as string,
        server: (data.server as string) || apiUrl,
        expires_in: (data.expires_in as number) || 60,
    };
}

// ─── Twilio Balance ──────────────────────────────────────────────────────

export interface FetchTwilioBalanceOptions {
    /** Your Pinecall API key. */
    apiKey?: string;
    /** SDK server base URL (e.g. `"http://localhost:1337"`). */
    apiUrl?: string;
}

export interface TwilioBalance {
    /** Account balance as a string (e.g. "125.45"). */
    balance: string;
    /** Currency code (e.g. "USD"). */
    currency: string;
}

/**
 * Fetch the Twilio account balance from the Pinecall API.
 *
 * Returns null if no Twilio credentials are configured.
 *
 * @example
 * ```ts
 * const balance = await fetchTwilioBalance({ apiKey: "pk_..." });
 * if (balance) console.log(`$${balance.balance} ${balance.currency}`);
 * ```
 */
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

// ─── Account Balance ─────────────────────────────────────────────────────

export interface FetchBalanceOptions {
    /** Your Pinecall API key. */
    apiKey: string;
    /** SDK server base URL. */
    apiUrl?: string;
}

export interface Balance {
    /** Account balance as a string (e.g. "125.45"). */
    balance: string;
    /** Currency code (e.g. "USD"). */
    currency: string;
}

/**
 * Fetch the Pinecall account balance.
 *
 * @example
 * ```ts
 * const balance = await fetchBalance({ apiKey: "pk_..." });
 * if (balance) console.log(`$${balance.balance} ${balance.currency}`);
 * ```
 */
export async function fetchBalance(_opts: FetchBalanceOptions): Promise<Balance | null> {
    // TODO: implement when /api/sdk/balance endpoint is available
    throw new Error("fetchBalance is not yet implemented. Use fetchTwilioBalance() for now.");
}

// ─── Typed mappers ───────────────────────────────────────────────────────

function mapVoice(provider: string): (raw: Record<string, unknown>) => Voice {
    return (v) => ({
        id: (v.id ?? v.voice_id ?? "") as string,
        name: (v.name ?? "Unknown") as string,
        provider,
        gender: v.gender as string | undefined,
        style: v.style as string | undefined,
        languages: Array.isArray(v.languages) ? v.languages.map(mapLanguage) : [],
        description: v.description as string | undefined,
        preview_url: v.preview_url as string | undefined,
    });
}

function mapLanguage(raw: unknown): VoiceLanguage {
    if (typeof raw === "string") {
        return { code: raw, name: raw };
    }
    const l = raw as Record<string, unknown>;
    return {
        code: (l.code ?? "") as string,
        name: (l.name ?? "") as string,
        flag: l.flag as string | undefined,
        nativeName: l.nativeName as string | undefined,
        region: l.region as string | undefined,
    };
}

function mapPhone(raw: Record<string, unknown>): Phone {
    return {
        number: (raw.number ?? "") as string,
        name: (raw.name ?? raw.number ?? "") as string,
        sid: (raw.sid ?? "") as string,
        isSdk: (raw.isSdk ?? false) as boolean,
    };
}

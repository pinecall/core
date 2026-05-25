/**
 * Token API — create tokens for browser connections.
 */

import { DEFAULT_API_URL } from "./http.js";

export interface WebRTCToken {
    token: string;
    server?: string;
}

export interface TokenResponse {
    token: string;
    server: string;
    expiresIn: number;
}

export interface FetchWebRTCTokenOptions {
    agentId: string;
    apiUrl?: string;
    apiKey?: string;
}

export interface CreateTokenOptions {
    channel: "webrtc" | "chat";
    agentId: string;
    apiKey: string;
    apiUrl?: string;
}

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
        expiresIn: (data.expires_in as number) || 60,
    };
}

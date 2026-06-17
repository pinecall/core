/**
 * pinecall test — Tester TTS (voice mode)
 *
 * Synthesizes the judge's text into raw PCM so it can be streamed into the
 * call as the synthetic caller's voice. Only ElevenLabs is supported for the
 * tester side — it returns raw 16kHz PCM directly (output_format=pcm_16000),
 * which is exactly what the WebRTC audio source wants.
 *
 * Needs ELEVENLABS_API_KEY in the environment.
 */

/** Named ElevenLabs voices → voice IDs (a handful of common ones). */
const ELEVENLABS_VOICES: Record<string, string> = {
    sarah: "EXAVITQu4vr4xnSDxMaL",
    rachel: "21m00Tcm4TlvDq8ikWAM",
    adam: "pNInz6obpgDQGcFmaJgB",
    antoni: "ErXwobaYiN019PkySvjV",
    bella: "EXAVITQu4vr4xnSDxMaL",
    domi: "AZnzlk1XvdvUeBnXmlld",
    elli: "MF3mGyEYCl7XYWbV9V6O",
    josh: "TxGEqnHWrfWFTfGW9XjX",
    arnold: "VR6AewLTigWG4xSOukaG",
};

/** Tester voice resolved to a provider + ElevenLabs voice ID. */
export interface TesterVoice {
    provider: "elevenlabs";
    voiceId: string;
    /** Original spec string, for logs */
    label: string;
}

/**
 * Parse a `--voice` value like "elevenlabs/sarah" or "elevenlabs/EXAV..."
 * into a resolved tester voice. Bare values (no provider) are assumed
 * ElevenLabs.
 */
export function parseTesterVoice(spec: string): TesterVoice {
    const raw = spec.includes("/") ? spec.split("/").slice(1).join("/") : spec;
    const provider = spec.includes("/") ? spec.split("/")[0].toLowerCase() : "elevenlabs";

    if (provider !== "elevenlabs") {
        throw new Error(
            `Tester voice provider "${provider}" not supported. Use elevenlabs/<voice> (e.g. elevenlabs/sarah).`,
        );
    }

    const name = raw.toLowerCase();
    // A 20-char alphanumeric value is treated as a raw voice ID.
    const voiceId = ELEVENLABS_VOICES[name] ?? (/^[A-Za-z0-9]{20}$/.test(raw) ? raw : "");
    if (!voiceId) {
        const known = Object.keys(ELEVENLABS_VOICES).join(", ");
        throw new Error(`Unknown ElevenLabs voice "${raw}". Known: ${known} — or pass a 20-char voice ID.`);
    }

    return { provider: "elevenlabs", voiceId, label: spec };
}

/**
 * Synthesize `text` to raw PCM (s16le, mono, 16kHz) via ElevenLabs.
 * Returns a Buffer of little-endian 16-bit samples.
 */
export async function synthesize(text: string, voice: TesterVoice): Promise<Buffer> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
        throw new Error("ELEVENLABS_API_KEY not set — required for the tester voice (--voice).");
    }

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice.voiceId}?output_format=pcm_16000`;
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
            Accept: "audio/pcm",
        },
        body: JSON.stringify({
            text,
            model_id: "eleven_flash_v2_5",
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`ElevenLabs TTS error ${res.status}: ${body.slice(0, 300)}`);
    }

    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
}

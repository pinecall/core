/**
 * Session configuration types — mirrors PROTOCOL.md §5.
 *
 * Provider-specific fields keep snake_case to mirror their underlying APIs.
 * This is the documented hybrid naming convention.
 */

// ─── STT ─────────────────────────────────────────────────────────────────

export interface DeepgramSTTConfig {
    provider: "deepgram";
    language?: string;
    model?: string;
    interim_results?: boolean;
    smart_format?: boolean;
    punctuate?: boolean;
    profanity_filter?: boolean;
    use_native_vad?: boolean;
    endpointing_ms?: number;
    utterance_end_ms?: number;
    keywords?: string[];
    keyterms?: string[];
    min_confidence?: number | null;
}

export interface FluxSTTConfig {
    provider: "deepgram-flux";
    language?: string;
    language_hint?: string;
    eot_threshold?: number;
    eager_eot_threshold?: number;
    eot_timeout_ms?: number;
    keyterms?: string[];
    min_confidence?: number | null;
}

export interface GladiaSTTConfig {
    provider: "gladia";
    language?: string;
    model?: string;
    endpointing?: number;
    max_duration_without_endpointing?: number;
    speech_threshold?: number;
    code_switching?: boolean;
    audio_enhancer?: boolean;
}

export interface TranscribeSTTConfig {
    provider: "transcribe";
    language?: string;
}

/**
 * Soniox real-time STT (`stt-rt-v5`, 60+ languages, one model).
 *
 * Soniox has SEMANTIC endpointing — it decides the user is done from pauses,
 * intonation and whether the utterance is complete — so by default it is also
 * the session's turn detector (like Flux). `turn` hands that job to the local
 * SmartTurn model instead; the `endpoint_*` fields tune Soniox's own decision
 * when you keep it.
 */
export interface SonioxSTTConfig {
    provider: "soniox";
    language?: string;
    model?: string;
    /**
     * Who ends the turn. `"native"` (default): Soniox's semantic endpointing.
     * `"smart_turn"`: the local SmartTurn model, with Soniox as transcriber only.
     * Pick `"smart_turn"` when `max_endpoint_delay_ms` keeps cutting long
     * mid-sentence pauses and raising it makes every reply wait.
     */
    turn?: "native" | "smart_turn";
    enable_endpoint_detection?: boolean;
    /** 0–3, higher = ends the turn sooner. Default 2. */
    endpoint_latency_adjustment_level?: number;
    /** -1.0..1.0, positive = more endpoints. Default 0.3. */
    endpoint_sensitivity?: number;
    /** Hard cap on the wait, 500–3000. Default 1500. */
    max_endpoint_delay_ms?: number;
    /** Free-form recognition bias; `keyterms` is folded into it. */
    context?: string;
    keyterms?: string[];
}

export type STTConfig =
    | DeepgramSTTConfig
    | FluxSTTConfig
    | GladiaSTTConfig
    | TranscribeSTTConfig
    | SonioxSTTConfig;

// ─── TTS ─────────────────────────────────────────────────────────────────

export interface ElevenLabsTTSConfig {
    provider: "elevenlabs";
    voice_id?: string;
    model?: string;
    speed?: number;
    stability?: number;
    similarity_boost?: number;
    style?: number;
    use_speaker_boost?: boolean;
    language?: string | null;
}

export interface CartesiaTTSConfig {
    provider: "cartesia";
    voice_id?: string;
    model?: string;
    speed?: number;
    volume?: number;
    emotion?: string | null;
    language?: string;
}

export interface PollyTTSConfig {
    provider: "polly";
    voice_id?: string;
    engine?: "neural" | "standard";
    language?: string;
    rate?: string | null;
    volume?: string | null;
    pitch?: string | null;
}

export type TTSConfig =
    | ElevenLabsTTSConfig
    | CartesiaTTSConfig
    | PollyTTSConfig;

// ── Interruption ────────────────────────────────────────────────────────

export interface InterruptionConfig {
    enabled?: boolean;
    energy_threshold_db?: number;
    min_duration_ms?: number;
}

// ─── Speaker Filter ──────────────────────────────────────────────────────

export interface SpeakerFilterConfig {
    enabled?: boolean;
    energy_threshold_db?: number;
    warmup_seconds?: number;
}

// ─── Analysis ────────────────────────────────────────────────────────────

export interface AnalysisConfig {
    send_audio_metrics?: boolean;
    audio_metrics_interval_ms?: number;
    send_turn_audio?: boolean;
    send_bot_audio?: boolean;
}

// ─── Combined Session Config ─────────────────────────────────────────────

export interface SessionConfig {
    stt?: STTConfig;
    tts?: TTSConfig;
    interruption?: InterruptionConfig;
    speaker_filter?: SpeakerFilterConfig;
    analysis?: AnalysisConfig;
}

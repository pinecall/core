/**
 * GENERATED FILE — do not edit. `npm run gen:catalog` in mcp/ rewrites it.
 *
 * Source: docs/reference/{llm,stt,tts}-providers.md at docsSha 133a26dc538b.
 * See scripts/gen-catalog.mjs for why this is static and what stays live.
 */

export interface CatalogModel {
    /** The EXACT string an agent config uses, e.g. "deepgram/flux". */
    shortcut: string;
    provider: string;
    model: string | null;
    /** From the docs table; `list_models` overrides it with the live rate table. */
    managed: boolean | null;
    /** Equivalent spellings of the same model, e.g. "claude/claude-sonnet-4-6". */
    aliasForms: string[];
    /** For TTS providers: documented example voice strings. */
    examples: string[];
    notes: string[];
}

export interface CatalogProvider {
    name: string;
    aliases: string[];
    managed: boolean;
    note: string | null;
}

export interface CatalogKind {
    source: string;
    /** The agent-config field this kind is written under. */
    field: string;
    models: CatalogModel[];
    providers: CatalogProvider[];
}

export interface Catalog {
    /** Date the table was generated from the docs (YYYY-MM-DD). */
    staleAsOf: string;
    docsSha: string;
    kinds: Record<"llm" | "stt" | "tts", CatalogKind>;
}

export const CATALOG: Catalog = {
    "staleAsOf": "2026-08-12",
    "docsSha": "133a26dc538b",
    "kinds": {
        "llm": {
            "source": "docs/reference/llm-providers.md",
            "field": "llm",
            "models": [
                {
                    "shortcut": "openai/gpt-5.3-chat-latest",
                    "provider": "openai",
                    "model": "gpt-5.3-chat-latest",
                    "managed": true,
                    "aliasForms": [],
                    "examples": [],
                    "notes": [
                        "Best for: Most agents — strong reasoning, good cost (recommended default)",
                        "Default, recommended"
                    ]
                },
                {
                    "shortcut": "anthropic/claude-haiku-4-5",
                    "provider": "anthropic",
                    "model": "claude-haiku-4-5",
                    "managed": true,
                    "aliasForms": [],
                    "examples": [],
                    "notes": [
                        "Best for: Most voice agents — fast and low cost (recommended default)"
                    ]
                },
                {
                    "shortcut": "mistral/mistral-medium",
                    "provider": "mistral",
                    "model": "mistral-medium",
                    "managed": true,
                    "aliasForms": [],
                    "examples": [],
                    "notes": [
                        "mid-call swap"
                    ]
                },
                {
                    "shortcut": "pinecall/gpt-realtime",
                    "provider": "pinecall",
                    "model": "gpt-realtime",
                    "managed": null,
                    "aliasForms": [],
                    "examples": [],
                    "notes": [
                        "server-side realtime speech-to-speech",
                        "Best for: Speech-to-speech — the model listens and speaks directly (no STT/TTS). Lowest latency, native barge-in. See [Realtime speech-to-speech](#realtime-speech-to-speech-gpt-realtime) below and the [full guide](/guides/realtime-speech)."
                    ]
                },
                {
                    "shortcut": "google/gemini-2.5-flash",
                    "provider": "google",
                    "model": "gemini-2.5-flash",
                    "managed": true,
                    "aliasForms": [
                        "gemini/gemini-2.5-flash"
                    ],
                    "examples": [],
                    "notes": [
                        "Best for: Most voice agents — fast, low cost, strong reasoning (recommended default)"
                    ]
                },
                {
                    "shortcut": "anthropic/claude-sonnet-4-6",
                    "provider": "anthropic",
                    "model": "claude-sonnet-4-6",
                    "managed": true,
                    "aliasForms": [
                        "claude/claude-sonnet-4-6"
                    ],
                    "examples": [],
                    "notes": [
                        "Best for: Higher reasoning quality when latency/cost matter less"
                    ]
                },
                {
                    "shortcut": "xai/grok-4",
                    "provider": "xai",
                    "model": "grok-4",
                    "managed": false,
                    "aliasForms": [],
                    "examples": [],
                    "notes": [
                        "\"grok\" is accepted as an alias for \"xai\"",
                        "Add an xAI key"
                    ]
                },
                {
                    "shortcut": "groq/llama-3.3-70b-versatile",
                    "provider": "groq",
                    "model": "llama-3.3-70b-versatile",
                    "managed": false,
                    "aliasForms": [],
                    "examples": [],
                    "notes": [
                        "Add a Groq key"
                    ]
                },
                {
                    "shortcut": "cerebras/llama-3.3-70b",
                    "provider": "cerebras",
                    "model": "llama-3.3-70b",
                    "managed": false,
                    "aliasForms": [],
                    "examples": [],
                    "notes": [
                        "Add a Cerebras key"
                    ]
                },
                {
                    "shortcut": "deepseek/deepseek-chat",
                    "provider": "deepseek",
                    "model": "deepseek-chat",
                    "managed": false,
                    "aliasForms": [],
                    "examples": [],
                    "notes": [
                        "or \"deepseek/deepseek-reasoner\" (no tools)",
                        "Add a DeepSeek key"
                    ]
                }
            ],
            "providers": [
                {
                    "name": "openai",
                    "aliases": [],
                    "managed": true,
                    "note": "Default, recommended"
                },
                {
                    "name": "anthropic",
                    "aliases": [
                        "claude"
                    ],
                    "managed": true,
                    "note": null
                },
                {
                    "name": "google",
                    "aliases": [
                        "gemini"
                    ],
                    "managed": true,
                    "note": null
                },
                {
                    "name": "mistral",
                    "aliases": [],
                    "managed": true,
                    "note": null
                },
                {
                    "name": "xai",
                    "aliases": [
                        "grok"
                    ],
                    "managed": false,
                    "note": "Add an xAI key"
                },
                {
                    "name": "groq",
                    "aliases": [],
                    "managed": false,
                    "note": "Add a Groq key"
                },
                {
                    "name": "cerebras",
                    "aliases": [],
                    "managed": false,
                    "note": "Add a Cerebras key"
                },
                {
                    "name": "deepseek",
                    "aliases": [],
                    "managed": false,
                    "note": "Add a DeepSeek key"
                },
                {
                    "name": "openrouter",
                    "aliases": [],
                    "managed": false,
                    "note": "One key → many models; model = full slug, e.g. x-ai/grok-4"
                }
            ]
        },
        "stt": {
            "source": "docs/reference/stt-providers.md",
            "field": "stt",
            "models": [
                {
                    "shortcut": "deepgram/flux",
                    "provider": "deepgram",
                    "model": "flux",
                    "managed": true,
                    "aliasForms": [],
                    "examples": [],
                    "notes": [
                        "auto-selects en/multi based on language",
                        "Best for: Real-time voice agents · Trade-off: Lowest latency; English, Spanish, French, German, Portuguese, and ~15 more",
                        "Turn Detection: Native (built-in) · VAD: Native (built-in)",
                        "Default, recommended",
                        "Language auto-select: \"deepgram/flux\" picks flux-general-en when language: \"en\" and flux-general-multi otherwise.",
                        "Deepgram Flux supports ~20 languages including: English, Spanish, French, German, Portuguese, Italian, Dutch, Russian, Ukrainian, Turkish, Polish, Swedish, Norwegian, Danish, Finnish, Indonesian, Malay, Korean, Japanese, Chinese (Mandarin)."
                    ]
                },
                {
                    "shortcut": "deepgram/flux-en",
                    "provider": "deepgram",
                    "model": "flux-en",
                    "managed": true,
                    "aliasForms": [],
                    "examples": [],
                    "notes": [
                        "force English-only model",
                        "Default, recommended",
                        "Language auto-select: \"deepgram/flux\" picks flux-general-en when language: \"en\" and flux-general-multi otherwise.",
                        "Deepgram Flux supports ~20 languages including: English, Spanish, French, German, Portuguese, Italian, Dutch, Russian, Ukrainian, Turkish, Polish, Swedish, Norwegian, Danish, Finnish, Indonesian, Malay, Korean, Japanese, Chinese (Mandarin).",
                        "Deepgram Nova-3 supports 60+ languages including everything Flux covers plus: Arabic, Hindi, Urdu, Bengali, Thai, Vietnamese, Hebrew, Farsi, Swahili, Tamil, Telugu, and many more."
                    ]
                },
                {
                    "shortcut": "deepgram/flux-multi",
                    "provider": "deepgram",
                    "model": "flux-multi",
                    "managed": true,
                    "aliasForms": [],
                    "examples": [],
                    "notes": [
                        "force multilingual model",
                        "Default, recommended",
                        "Language auto-select: \"deepgram/flux\" picks flux-general-en when language: \"en\" and flux-general-multi otherwise.",
                        "Deepgram Flux supports ~20 languages including: English, Spanish, French, German, Portuguese, Italian, Dutch, Russian, Ukrainian, Turkish, Polish, Swedish, Norwegian, Danish, Finnish, Indonesian, Malay, Korean, Japanese, Chinese (Mandarin).",
                        "Deepgram Nova-3 supports 60+ languages including everything Flux covers plus: Arabic, Hindi, Urdu, Bengali, Thai, Vietnamese, Hebrew, Farsi, Swahili, Tamil, Telugu, and many more."
                    ]
                },
                {
                    "shortcut": "deepgram/nova-3",
                    "provider": "deepgram",
                    "model": "nova-3",
                    "managed": true,
                    "aliasForms": [],
                    "examples": [],
                    "notes": [
                        "mid-call swap",
                        "Best for: Arabic, Hindi, Thai, CJK, and 60+ languages · Trade-off: Slightly higher latency; smart_turn + silero VAD",
                        "Turn Detection: Smart turn · VAD: Silero",
                        "Default, recommended",
                        "Deepgram Nova-3 supports 60+ languages including everything Flux covers plus: Arabic, Hindi, Urdu, Bengali, Thai, Vietnamese, Hebrew, Farsi, Swahili, Tamil, Telugu, and many more."
                    ]
                },
                {
                    "shortcut": "deepgram/nova-2",
                    "provider": "deepgram",
                    "model": "nova-2",
                    "managed": true,
                    "aliasForms": [],
                    "examples": [],
                    "notes": [
                        "Default, recommended",
                        "Deepgram Nova-3 supports 60+ languages including everything Flux covers plus: Arabic, Hindi, Urdu, Bengali, Thai, Vietnamese, Hebrew, Farsi, Swahili, Tamil, Telugu, and many more."
                    ]
                },
                {
                    "shortcut": "gladia/solaria",
                    "provider": "gladia",
                    "model": "solaria",
                    "managed": true,
                    "aliasForms": [],
                    "examples": [],
                    "notes": [
                        "Best for: Code-switching, multilingual · Trade-off: Higher latency than Deepgram",
                        "Turn Detection: Smart turn · VAD: Silero"
                    ]
                },
                {
                    "shortcut": "transcribe",
                    "provider": "transcribe",
                    "model": "transcribe",
                    "managed": true,
                    "aliasForms": [],
                    "examples": [],
                    "notes": [
                        "Best for: AWS-native deployments · Trade-off: AWS pricing model"
                    ]
                },
                {
                    "shortcut": "cartesia/ink-whisper",
                    "provider": "cartesia",
                    "model": "ink-whisper",
                    "managed": true,
                    "aliasForms": [],
                    "examples": [],
                    "notes": [
                        "Cartesia Ink-Whisper",
                        "Best for: Single-vendor with Cartesia TTS · Trade-off: Managed (shared key)",
                        "Same key as Cartesia TTS — Pinecall hosts it"
                    ]
                },
                {
                    "shortcut": "elevenlabs/scribe",
                    "provider": "elevenlabs",
                    "model": "scribe",
                    "managed": true,
                    "aliasForms": [],
                    "examples": [],
                    "notes": [
                        "ElevenLabs Scribe v2 (realtime)",
                        "Best for: Single-vendor with ElevenLabs TTS · Trade-off: Managed (shared key)",
                        "Same key as ElevenLabs TTS — Pinecall hosts it"
                    ]
                },
                {
                    "shortcut": "assemblyai/universal",
                    "provider": "assemblyai",
                    "model": "universal",
                    "managed": false,
                    "aliasForms": [],
                    "examples": [],
                    "notes": [
                        "AssemblyAI Universal-3",
                        "Best for: Accuracy + diarization · Trade-off: BYOK only",
                        "Add an AssemblyAI key"
                    ]
                },
                {
                    "shortcut": "soniox/realtime",
                    "provider": "soniox",
                    "model": "realtime",
                    "managed": true,
                    "aliasForms": [],
                    "examples": [],
                    "notes": [
                        "Soniox real-time, 60 languages",
                        "Best for: Multilingual (60 langs, one model), single-vendor with Soniox TTS · Trade-off: Managed (shared key)",
                        "60 languages. Same key as Soniox TTS — Pinecall hosts it",
                        "Real-time multilingual STT — one model, stt-rt-v5, covering 60 languages with no per-language model switch.",
                        "language is sent as a hint, not a lock — Soniox keeps detecting across the 60 languages, so a caller who switches mid-sentence is still transcribed.",
                        "Set language: \"multi\" to send no hint at all and let it detect freely."
                    ]
                },
                {
                    "shortcut": "xai/grok-stt",
                    "provider": "xai",
                    "model": "grok-stt",
                    "managed": false,
                    "aliasForms": [],
                    "examples": [],
                    "notes": [
                        "xAI Grok STT (BYOK)",
                        "Best for: Single-vendor with Grok LLM + TTS · Trade-off: BYOK only",
                        "Same xAI key as Grok LLM/TTS"
                    ]
                }
            ],
            "providers": [
                {
                    "name": "deepgram",
                    "aliases": [],
                    "managed": true,
                    "note": "Default, recommended"
                },
                {
                    "name": "gladia",
                    "aliases": [],
                    "managed": true,
                    "note": null
                },
                {
                    "name": "transcribe",
                    "aliases": [],
                    "managed": true,
                    "note": null
                },
                {
                    "name": "cartesia",
                    "aliases": [],
                    "managed": true,
                    "note": "Same key as Cartesia TTS — Pinecall hosts it"
                },
                {
                    "name": "elevenlabs",
                    "aliases": [],
                    "managed": true,
                    "note": "Same key as ElevenLabs TTS — Pinecall hosts it"
                },
                {
                    "name": "soniox",
                    "aliases": [],
                    "managed": true,
                    "note": "60 languages. Same key as Soniox TTS — Pinecall hosts it"
                },
                {
                    "name": "assemblyai",
                    "aliases": [],
                    "managed": false,
                    "note": "Add an AssemblyAI key"
                },
                {
                    "name": "xai",
                    "aliases": [],
                    "managed": false,
                    "note": "Same xAI key as Grok LLM/TTS"
                }
            ]
        },
        "tts": {
            "source": "docs/reference/tts-providers.md",
            "field": "voice",
            "models": [
                {
                    "shortcut": "elevenlabs/<voice-alias>",
                    "provider": "elevenlabs",
                    "model": null,
                    "managed": true,
                    "examples": [
                        "elevenlabs/sarah",
                        "elevenlabs/agustin",
                        "elevenlabs/valentina",
                        "elevenlabs/agus",
                        "elevenlabs/daniel"
                    ],
                    "notes": [
                        "Default, recommended",
                        "The server picks the ElevenLabs model from your language:",
                        "flash is a sibling of language (not inside voice), so it reads cleanly with the rest of the shortcuts.",
                        "- Works per-channel too: phoneNumbers: [{ number, language: \"es\", flash: true }]."
                    ],
                    "aliasForms": []
                },
                {
                    "shortcut": "cartesia/<voice-alias>",
                    "provider": "cartesia",
                    "model": null,
                    "managed": true,
                    "examples": [
                        "cartesia/yumiko",
                        "cartesia/blake"
                    ],
                    "notes": [
                        "- model: \"sonic-3.5\" — latest/fastest Cartesia model (sub-90ms, 42 languages), designed for streaming."
                    ],
                    "aliasForms": []
                },
                {
                    "shortcut": "polly/<voice-alias>",
                    "provider": "polly",
                    "model": null,
                    "managed": true,
                    "examples": [
                        "polly/lucia"
                    ],
                    "notes": [],
                    "aliasForms": []
                },
                {
                    "shortcut": "soniox/<voice-alias>",
                    "provider": "soniox",
                    "model": null,
                    "managed": true,
                    "examples": [],
                    "notes": [
                        "28 voices, 63 languages. Same key as Soniox STT",
                        "Real-time TTS in 63 languages with 28 voices — no key needed.",
                        "Every voice speaks every one of the 63 languages — the voice does not pin the language, language does.",
                        "pinecall voices --provider=soniox --language=es ranks the accent-matching voices first but still lists the rest — any of them will speak Spanish."
                    ],
                    "aliasForms": []
                },
                {
                    "shortcut": "rime/<voice-alias>",
                    "provider": "rime",
                    "model": null,
                    "managed": false,
                    "examples": [],
                    "notes": [
                        "Add a Rime key under Provider Keys"
                    ],
                    "aliasForms": []
                },
                {
                    "shortcut": "xai/<voice-alias>",
                    "provider": "xai",
                    "model": null,
                    "managed": false,
                    "examples": [],
                    "notes": [
                        "Same xAI key as Grok LLM"
                    ],
                    "aliasForms": []
                }
            ],
            "providers": [
                {
                    "name": "elevenlabs",
                    "aliases": [],
                    "managed": true,
                    "note": "Default, recommended"
                },
                {
                    "name": "cartesia",
                    "aliases": [],
                    "managed": true,
                    "note": null
                },
                {
                    "name": "polly",
                    "aliases": [],
                    "managed": true,
                    "note": null
                },
                {
                    "name": "soniox",
                    "aliases": [],
                    "managed": true,
                    "note": "28 voices, 63 languages. Same key as Soniox STT"
                },
                {
                    "name": "rime",
                    "aliases": [],
                    "managed": false,
                    "note": "Add a Rime key under Provider Keys"
                },
                {
                    "name": "xai",
                    "aliases": [],
                    "managed": false,
                    "note": "Same xAI key as Grok LLM"
                }
            ]
        }
    }
};

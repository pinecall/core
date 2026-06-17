/**
 * pinecall test — Types
 */

// ── Spec file schema ─────────────────────────────────

export interface Spec {
    /** Agent name (as registered with pc.agent()) */
    agent: string;
    /** Human-readable description */
    description?: string;
    /** Per-turn timeout in ms (default: 30000) */
    timeout?: number;
    /** Judge LLM configuration */
    judge?: JudgeConfig;
    /** Natural language workflow for the tester LLM */
    workflow: string;

    // ── Voice mode (real voice call) ──
    /** "chat" (default, text) or "voice" (real WebRTC voice call). */
    mode?: "chat" | "voice";
    /** Tester's spoken voice for voice mode, e.g. "elevenlabs/sarah". */
    voice?: string;
    /** Session STT provider for voice mode, e.g. "flux". */
    stt?: string;
    /** Language override (e.g. "es"). */
    language?: string;
    /**
     * Tester greeting (voice mode): the judge speaks this to OPEN the call.
     * Omit to let the agent greet first and have the judge wait for it.
     */
    greeting?: string;
    /**
     * Detect the agent's end-of-turn so the judge knows when to reply.
     * Default true in voice mode. See dial({ detectTurnEnd }).
     */
    detectTurnEnd?: boolean;

    /** Source file path (set at load time) */
    _file?: string;
}

export interface JudgeConfig {
    /** LLM provider: anthropic | openai | google | deepseek | ollama */
    provider: "anthropic" | "openai" | "google" | "deepseek" | "ollama";
    /** Model name */
    model: string;
    /** Max turns before forcing a result (default: 20) */
    maxTurns?: number;
}

// ── Judge LLM interaction ────────────────────────────

export interface JudgeMessage {
    role: "system" | "user" | "assistant";
    content: string | JudgeContentPart[];
}

export interface JudgeContentPart {
    type: "text" | "tool_use" | "tool_result";
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    tool_use_id?: string;
    content?: string;
}

export interface JudgeTool {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}

// ── Test results ─────────────────────────────────────

export interface SpecResult {
    file: string;
    agent: string;
    description: string;
    passed: boolean;
    summary: string;
    turns: TurnRecord[];
    durationMs: number;
    error?: string;
    /** Voice mode: path to the WAV recording of the call. */
    recordingPath?: string;
    /** Voice mode: recorded duration in seconds. */
    recordingDuration?: number;
}

export interface TurnRecord {
    /** Message sent to agent (from judge LLM) */
    testerMessage: string;
    /** Agent's response text */
    agentResponse: string;
    /** Tool calls the agent made */
    agentToolCalls: ToolCallInfo[];
}

export interface ToolCallInfo {
    name: string;
    arguments: string;
}

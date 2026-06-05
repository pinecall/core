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

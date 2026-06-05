/**
 * pinecall test — Multi-provider Judge LLM
 *
 * Calls Anthropic, OpenAI, or Google LLMs with tool support.
 * Uses raw fetch() — zero SDK dependencies.
 *
 * The judge has two tools:
 *   test_passed(summary)  — marks the test as passed
 *   test_failed(reason)   — marks the test as failed
 *
 * The judge's TEXT response is the next message to send to the agent.
 * When it calls a tool instead, the test ends.
 */

import type { JudgeConfig, JudgeMessage } from "./types.js";

// ── Tool definitions ────────────────────────────────────

const TOOLS_ANTHROPIC = [
    {
        name: "test_passed",
        description: "Call this when the workflow test has PASSED. All expected behaviors were observed.",
        input_schema: {
            type: "object" as const,
            properties: {
                summary: { type: "string", description: "Brief summary of what was verified" },
            },
            required: ["summary"],
        },
    },
    {
        name: "test_failed",
        description: "Call this when the workflow test has FAILED. An expected behavior was NOT observed.",
        input_schema: {
            type: "object" as const,
            properties: {
                reason: { type: "string", description: "What failed and why" },
            },
            required: ["reason"],
        },
    },
];

const TOOLS_OPENAI = TOOLS_ANTHROPIC.map((t) => ({
    type: "function" as const,
    function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
    },
}));

const TOOLS_GOOGLE = TOOLS_ANTHROPIC.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: {
        type: "OBJECT" as const,
        properties: Object.fromEntries(
            Object.entries(t.input_schema.properties).map(([k, v]) => [
                k,
                { type: "STRING", description: (v as any).description },
            ])
        ),
        required: t.input_schema.required,
    },
}));

// ── Provider API keys ───────────────────────────────────

function getApiKey(provider: string): string {
    const envMap: Record<string, string> = {
        anthropic: "ANTHROPIC_API_KEY",
        openai: "OPENAI_API_KEY",
        google: "GOOGLE_API_KEY",
        deepseek: "DEEPSEEK_API_KEY",
    };
    const envVar = envMap[provider];
    if (!envVar) {
        if (provider === "ollama") return ""; // Ollama is local, no key needed
        throw new Error(`Unknown judge provider: ${provider}`);
    }
    const key = process.env[envVar];
    if (!key) throw new Error(`${envVar} not set. Required for judge provider "${provider}".`);
    return key;
}

// ── Response types ──────────────────────────────────────

export interface JudgeResponse {
    /** Text message from the judge (to send to agent) */
    text: string | null;
    /** Tool call if the judge is reporting a result */
    toolCall: { name: string; args: Record<string, string> } | null;
    /** Stop reason */
    stopReason: "text" | "tool" | "end_turn";
}

// ── Anthropic ───────────────────────────────────────────

async function callAnthropic(
    messages: JudgeMessage[],
    config: JudgeConfig,
    apiKey: string,
): Promise<JudgeResponse> {
    const system = messages.find((m) => m.role === "system")?.content as string ?? "";
    const chat = messages.filter((m) => m.role !== "system");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
            model: config.model,
            max_tokens: 1024,
            system,
            messages: chat,
            tools: TOOLS_ANTHROPIC,
        }),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Anthropic API error ${res.status}: ${body}`);
    }

    const data = await res.json() as any;
    let text: string | null = null;
    let toolCall: JudgeResponse["toolCall"] = null;

    for (const block of data.content ?? []) {
        if (block.type === "text") text = block.text;
        if (block.type === "tool_use") {
            toolCall = { name: block.name, args: block.input };
        }
    }

    return {
        text,
        toolCall,
        stopReason: data.stop_reason === "tool_use" ? "tool" : "text",
    };
}

// ── OpenAI ──────────────────────────────────────────────

async function callOpenAI(
    messages: JudgeMessage[],
    config: JudgeConfig,
    apiKey: string,
): Promise<JudgeResponse> {
    const mapped = messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: config.model,
            messages: mapped,
            tools: TOOLS_OPENAI,
            max_completion_tokens: 1024,
        }),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`OpenAI API error ${res.status}: ${body}`);
    }

    const data = await res.json() as any;
    const choice = data.choices?.[0];
    const msg = choice?.message;

    let toolCall: JudgeResponse["toolCall"] = null;
    if (msg?.tool_calls?.length) {
        const tc = msg.tool_calls[0];
        toolCall = {
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments || "{}"),
        };
    }

    return {
        text: msg?.content || null,
        toolCall,
        stopReason: choice?.finish_reason === "tool_calls" ? "tool" : "text",
    };
}

// ── Google (Gemini) ─────────────────────────────────────

async function callGoogle(
    messages: JudgeMessage[],
    config: JudgeConfig,
    apiKey: string,
): Promise<JudgeResponse> {
    const system = messages.find((m) => m.role === "system")?.content as string ?? "";
    const chat = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
        }));

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            system_instruction: { parts: [{ text: system }] },
            contents: chat,
            tools: [{ function_declarations: TOOLS_GOOGLE }],
        }),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Google API error ${res.status}: ${body}`);
    }

    const data = await res.json() as any;
    const parts = data.candidates?.[0]?.content?.parts ?? [];

    let text: string | null = null;
    let toolCall: JudgeResponse["toolCall"] = null;

    for (const part of parts) {
        if (part.text) text = part.text;
        if (part.functionCall) {
            toolCall = { name: part.functionCall.name, args: part.functionCall.args };
        }
    }

    return { text, toolCall, stopReason: toolCall ? "tool" : "text" };
}

// ── DeepSeek (OpenAI-compatible) ────────────────────────

async function callDeepSeek(
    messages: JudgeMessage[],
    config: JudgeConfig,
    apiKey: string,
): Promise<JudgeResponse> {
    const mapped = messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));

    const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: config.model || "deepseek-v4-flash",
            messages: mapped,
            tools: TOOLS_OPENAI,
            max_tokens: 1024,
        }),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`DeepSeek API error ${res.status}: ${body}`);
    }

    const data = await res.json() as any;
    const choice = data.choices?.[0];
    const msg = choice?.message;

    let toolCall: JudgeResponse["toolCall"] = null;
    if (msg?.tool_calls?.length) {
        const tc = msg.tool_calls[0];
        toolCall = {
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments || "{}"),
        };
    }

    return {
        text: msg?.content || null,
        toolCall,
        stopReason: choice?.finish_reason === "tool_calls" ? "tool" : "text",
    };
}

// ── Ollama (local, OpenAI-compatible) ───────────────────

async function callOllama(
    messages: JudgeMessage[],
    config: JudgeConfig,
): Promise<JudgeResponse> {
    const mapped = messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));

    const url = process.env.OLLAMA_HOST || "http://localhost:11434";
    const res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: config.model || "gemma3:4b",
            messages: mapped,
            tools: TOOLS_OPENAI,
            stream: false,
        }),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ollama error ${res.status}: ${body}`);
    }

    const data = await res.json() as any;
    const msg = data.message;

    let toolCall: JudgeResponse["toolCall"] = null;
    if (msg?.tool_calls?.length) {
        const tc = msg.tool_calls[0];
        toolCall = {
            name: tc.function.name,
            args: tc.function.arguments ?? {},
        };
    }

    return {
        text: msg?.content || null,
        toolCall,
        stopReason: toolCall ? "tool" : "text",
    };
}

// ── Public API ──────────────────────────────────────────

/** Default judge config */
export const DEFAULT_JUDGE: JudgeConfig = {
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    maxTurns: 20,
};

/** Call the judge LLM */
export async function callJudge(
    messages: JudgeMessage[],
    config: JudgeConfig,
): Promise<JudgeResponse> {
    const apiKey = getApiKey(config.provider);

    switch (config.provider) {
        case "anthropic": return callAnthropic(messages, config, apiKey);
        case "openai":    return callOpenAI(messages, config, apiKey);
        case "google":    return callGoogle(messages, config, apiKey);
        case "deepseek":  return callDeepSeek(messages, config, apiKey);
        case "ollama":    return callOllama(messages, config);
        default: throw new Error(`Unknown provider: ${config.provider}`);
    }
}

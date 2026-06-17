/**
 * pinecall test — Spec Runner
 *
 * Core execution engine:
 *   1. Load YAML spec
 *   2. Connect to agent via ChatClient
 *   3. Run judge LLM loop:
 *      - Judge generates text → sent to agent
 *      - Agent responds → fed back to judge as "user" message
 *      - Judge evaluates → generates next message or calls test_passed/test_failed
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Spec, JudgeConfig, JudgeMessage, SpecResult, TurnRecord, ToolCallInfo } from "./types.js";
import { ChatClient } from "./chat-client.js";
import { VoiceClient } from "./voice-client.js";
import { parseTesterVoice } from "./tts.js";
import { callJudge, DEFAULT_JUDGE, type JudgeResponse } from "./judge.js";
import { c } from "../../ui.js";

// ── YAML parser (minimal, no deps) ──────────────────────

export function parseSpec(content: string): Spec {
    // Simple YAML parser for our flat schema + multiline workflow block
    const lines = content.split("\n");
    const spec: Record<string, any> = {};
    let inBlock: string | null = null;
    let blockIndent = 0;
    let blockLines: string[] = [];
    let judgeBlock: Record<string, any> = {};
    let inJudge = false;

    for (const line of lines) {
        // Skip comments and empty
        if (line.trimStart().startsWith("#") || line.trim() === "") {
            if (inBlock) blockLines.push("");
            continue;
        }

        // Check for multiline block continuation
        if (inBlock) {
            const indent = line.length - line.trimStart().length;
            if (indent >= blockIndent && line.trim() !== "") {
                blockLines.push(line.slice(blockIndent));
                continue;
            } else {
                // Block ended
                spec[inBlock] = blockLines.join("\n").trim();
                inBlock = null;
                blockLines = [];
            }
        }

        // Judge sub-keys (indented) — must check BEFORE the top-level regex
        // because `  provider: anthropic` won't match ^(\w+) due to leading spaces.
        if (inJudge && line.startsWith("  ")) {
            const subMatch = line.trim().match(/^(\w+):\s*(.*)/);
            if (subMatch) {
                const [, sk, sv] = subMatch;
                judgeBlock[sk] = isNaN(Number(sv)) ? sv : Number(sv);
            }
            continue;
        } else if (inJudge) {
            spec.judge = judgeBlock;
            inJudge = false;
        }

        // Top-level key: value
        const match = line.match(/^(\w+):\s*(.*)/);
        if (!match) continue;

        const [, key, rawVal] = match;
        const val = rawVal.trim();

        if (key === "judge") {
            inJudge = true;
            judgeBlock = {};
            continue;
        }

        // Multiline block (workflow: |)
        if (val === "|") {
            inBlock = key;
            // Detect indent of next non-empty line
            const nextIdx = lines.indexOf(line) + 1;
            for (let i = nextIdx; i < lines.length; i++) {
                if (lines[i].trim()) {
                    blockIndent = lines[i].length - lines[i].trimStart().length;
                    break;
                }
            }
            continue;
        }

        // Quoted or unquoted string
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            spec[key] = val.slice(1, -1);
        } else if (val === "true" || val === "false") {
            spec[key] = val === "true";
        } else if (val.endsWith("s") && !isNaN(Number(val.slice(0, -1)))) {
            // Duration like "30s" → ms
            spec[key] = Number(val.slice(0, -1)) * 1000;
        } else if (!isNaN(Number(val))) {
            spec[key] = Number(val);
        } else {
            spec[key] = val;
        }
    }

    // Flush remaining block
    if (inBlock) {
        spec[inBlock] = blockLines.join("\n").trim();
    }
    if (inJudge) {
        spec.judge = judgeBlock;
    }

    if (!spec.agent) throw new Error("Spec missing required 'agent' field");
    if (!spec.workflow) throw new Error("Spec missing required 'workflow' field");

    return spec as Spec;
}

export function loadSpec(filePath: string): Spec {
    const content = fs.readFileSync(filePath, "utf-8");
    const spec = parseSpec(content);
    spec._file = filePath;
    return spec;
}

export function discoverSpecs(dirOrFile: string): string[] {
    const stat = fs.statSync(dirOrFile);
    if (stat.isFile()) return [dirOrFile];
    const files: string[] = [];
    for (const entry of fs.readdirSync(dirOrFile)) {
        if (entry.endsWith(".spec.yaml") || entry.endsWith(".spec.yml")) {
            files.push(path.join(dirOrFile, entry));
        }
    }
    return files.sort();
}

// ── System prompt for the judge ─────────────────────────

function buildSystemPrompt(spec: Spec): string {
    const today = new Date().toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
    });

    return [
        `You are a QA tester evaluating the AI agent "${spec.agent}".`,
        `Today is ${today}.`,
        "",
        "## Your role",
        "You will have a conversation with the agent by sending messages as a user would.",
        "Each message you write will be sent directly to the agent.",
        "The agent's response (including any tool calls it made) will be shown to you.",
        "",
        "## How to report results",
        "You have two tools:",
        "- `test_passed(summary)` — call when the workflow test PASSES",
        "- `test_failed(reason)` — call when something goes WRONG",
        "",
        "## Rules",
        "- Follow the workflow steps in order",
        "- Write natural, realistic user messages (not robotic test commands)",
        "- Evaluate EACH agent response before continuing",
        "- If the agent says something incorrect, call test_failed immediately",
        "- If all steps pass, call test_passed with a summary",
        "- Keep messages SHORT. You are a customer, not a tester.",
        "- Write in the same language the agent uses",
        "",
        "## Workflow to test",
        spec.workflow,
    ].join("\n");
}

// ── Format agent response for the judge ─────────────────

function formatAgentResponse(text: string, toolCalls: ToolCallInfo[]): string {
    let msg = `[Agent responded]:\n${text}`;
    if (toolCalls.length > 0) {
        msg += "\n\n[Agent tool calls]:";
        for (const tc of toolCalls) {
            msg += `\n- ${tc.name}(${tc.arguments})`;
        }
    }
    return msg;
}

// ── Run a single spec ───────────────────────────────────

export interface RunOptions {
    apiKey: string;
    server?: string;
    verbose?: boolean;
    /** Override agent name from CLI */
    agentOverride?: string;
    /** Override judge config from CLI */
    judgeOverride?: JudgeConfig;
    /** Per-turn timeout ms */
    timeout?: number;
    /** Log callback for real-time output */
    log?: (msg: string) => void;
    /** Voice-mode config — when set, the test runs as a real voice call. */
    voice?: VoiceRunOptions;
}

export interface VoiceRunOptions {
    /** Tester voice spec, e.g. "elevenlabs/sarah". */
    spec: string;
    /** Session STT provider (e.g. "deepgram-flux"). */
    stt: string;
    /** HTTPS server base, e.g. https://voice.pinecall.io */
    server: string;
    /** Where to write the WAV recording. */
    recordPath: string;
    /** Play live mixed audio through the speakers. */
    play: boolean;
    /** Optional language override. */
    language?: string;
    /** Tester greeting (judge opens the call). Omit to let the agent greet first. */
    greeting?: string;
    /** Ask the server to emit the agent's turn.end to the judge. Default true. */
    detectTurnEnd?: boolean;
}

export async function runSpec(spec: Spec, opts: RunOptions): Promise<SpecResult> {
    const log = opts.log ?? (() => {});
    const agentId = opts.agentOverride ?? spec.agent;
    const judgeConfig: JudgeConfig = { ...DEFAULT_JUDGE, ...spec.judge, ...opts.judgeOverride };
    const maxTurns = judgeConfig.maxTurns ?? 20;
    const timeout = opts.timeout ?? spec.timeout ?? 30000;
    const startTime = Date.now();
    const turns: TurnRecord[] = [];

    // Connect to agent — text chat by default, real voice call when opts.voice is set.
    const client: ChatClient | VoiceClient = opts.voice
        ? new VoiceClient({
            apiKey: opts.apiKey,
            agentId,
            server: opts.voice.server,
            voice: parseTesterVoice(opts.voice.spec),
            stt: opts.voice.stt,
            recordPath: opts.voice.recordPath,
            play: opts.voice.play,
            language: opts.voice.language,
            greeting: opts.voice.greeting,
            detectTurnEnd: opts.voice.detectTurnEnd ?? true,
            log,
        })
        : new ChatClient({
            apiKey: opts.apiKey,
            agentId,
            server: opts.server,
        });

    try {
        await client.connect();
    } catch (err: any) {
        try { client.close(); } catch { /* ignore */ }
        return {
            file: spec._file ?? "unknown",
            agent: agentId,
            description: spec.description ?? "",
            passed: false,
            summary: "",
            turns: [],
            durationMs: Date.now() - startTime,
            error: `Connection failed: ${err.message}`,
        };
    }

    // ── Voice pre-step: greeting + capture the agent's opening ──
    // In a real call the agent usually greets first. We optionally have the
    // judge speak an opening greeting, then capture whatever the agent says so
    // the judge's first message is a natural REPLY, not a blind opener.
    let opening = "";
    if (opts.voice) {
        if (opts.voice.greeting) {
            log(`    ${c.cyan("┌ Tester [greeting]")}`);
            log(`    ${c.cyan("│")} ${c.dim(opts.voice.greeting)}`);
            log(`    ${c.cyan("└")}`);
            await (client as VoiceClient).sendMessage(opts.voice.greeting);
        }
        const greetWait = Math.min(timeout, 12000);
        const first = await client.waitForResponse(greetWait).catch(() => ({ text: "", toolCalls: [] }));
        if (first.text || first.toolCalls.length) {
            opening = formatAgentResponse(first.text, first.toolCalls);
            log(`    ${c.purple("┌ Agent [greeting]")}`);
            for (const ml of (first.text || "(tool call)").split("\n").slice(0, 6)) log(`    ${c.purple("│")} ${ml}`);
            log(`    ${c.purple("└")}`);
        }
    }

    // Build judge conversation
    const beginContent = opening
        ? `The agent opened the call with:\n\n${opening}\n\nNow begin the workflow test by responding as a realistic user.`
        : "Begin the workflow test now. Send your first message to the agent.";
    const messages: JudgeMessage[] = [
        { role: "system", content: buildSystemPrompt(spec) },
        { role: "user", content: beginContent },
    ];

    let result: { passed: boolean; summary: string } | null = null;

    try {
        for (let turn = 0; turn < maxTurns; turn++) {
            // 1. Ask judge for next message
            const judgeRes: JudgeResponse = await callJudge(messages, judgeConfig);

            // 2. Check if judge called a tool (test done)
            if (judgeRes.toolCall) {
                const { name, args } = judgeRes.toolCall;
                if (name === "test_passed") {
                    result = { passed: true, summary: args.summary ?? "" };
                } else if (name === "test_failed") {
                    result = { passed: false, summary: args.reason ?? "" };
                }
                break;
            }

            // 3. Judge sent a text message → send to agent
            const testerMsg = judgeRes.text;
            if (!testerMsg) {
                result = { passed: false, summary: "Judge produced empty response" };
                break;
            }

            // ── Tester message ──
            log(``);
            log(`    ${c.cyan(`┌ Tester [${turn + 1}]`)}`);
            // Judge writes internal notes then the user message, separated by \n\n.
            // Display only the last paragraph (the actual message to the agent).
            const paragraphs = testerMsg.split("\n\n").filter(p => p.trim());
            const userMsg = paragraphs[paragraphs.length - 1]?.trim() ?? testerMsg;
            const displayMsg = userMsg.length > 160 ? userMsg.slice(0, 160) + "…" : userMsg;
            for (const ml of displayMsg.split("\n")) {
                log(`    ${c.cyan("│")} ${c.dim(ml)}`);
            }
            log(`    ${c.cyan("└")}`);

            messages.push({ role: "assistant", content: testerMsg });

            // 4. Send to agent and wait for response.
            // In voice mode we speak only the user message (the last paragraph),
            // never the judge's internal notes.
            await client.sendMessage(opts.voice ? userMsg : testerMsg);
            const agentRes = await client.waitForResponse(timeout);

            // ── Agent response ──
            const preview = agentRes.text.length > 200 ? agentRes.text.slice(0, 200) + "…" : agentRes.text;
            log(`    ${c.purple("┌ Agent")}`);
            for (const responseLine of preview.split("\n").slice(0, 8)) {
                log(`    ${c.purple("│")} ${responseLine}`);
            }
            if (agentRes.toolCalls.length > 0) {
                log(`    ${c.purple("│")}`);
                for (const tc of agentRes.toolCalls) {
                    const argsPreview = tc.arguments.length > 80 ? tc.arguments.slice(0, 80) + "…" : tc.arguments;
                    log(`    ${c.purple("│")} ${c.yellow(`⚡ ${tc.name}`)}${c.dim(`(${argsPreview})`)}`);
                }
            }
            log(`    ${c.purple("└")}`);

            turns.push({
                testerMessage: testerMsg,
                agentResponse: agentRes.text,
                agentToolCalls: agentRes.toolCalls,
            });

            // 5. Feed agent response back to judge
            messages.push({
                role: "user",
                content: formatAgentResponse(agentRes.text, agentRes.toolCalls),
            });
        }

        if (!result) {
            result = { passed: false, summary: `Max turns (${maxTurns}) reached without result` };
        }
    } catch (err: any) {
        result = { passed: false, summary: `Error: ${err.message}` };
    } finally {
        client.close();
    }

    const isVoice = client instanceof VoiceClient;
    return {
        file: spec._file ?? "unknown",
        agent: agentId,
        description: spec.description ?? "",
        passed: result.passed,
        summary: result.summary,
        turns,
        durationMs: Date.now() - startTime,
        ...(isVoice ? { recordingPath: client.recordingPath, recordingDuration: client.recordingDuration } : {}),
    };
}

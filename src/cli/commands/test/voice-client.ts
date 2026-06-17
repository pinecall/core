/**
 * pinecall test — Voice mode (agent-to-agent)
 *
 * The judge is a NORMAL Pinecall agent: server-side LLM (Anthropic), its prompt
 * is the test workflow, and it carries local `test_passed`/`test_failed` tools.
 * It's bridged to the target agent — two independent agents, two WebSockets, one
 * call. Both run the full server pipeline (STT → LLM → TTS → turn-detection), so
 * turn-taking is real and the target can't tell the caller is a bot.
 *
 *   target ↔ (bridged audio) ↔ judge(LLM)         the server runs BOTH pipelines
 *   judge LLM calls test_passed/test_failed  →  SDK runs the local tool → verdict
 *
 * The CLI just observes: it streams the transcript, records the mixed call to a
 * WAV, opens the hosted live player, and waits for the verdict (tool / hangup /
 * timeout). Needs only PINECALL_API_KEY (+ the server's Anthropic key for the
 * judge LLM). No ElevenLabs, no client-side turn logic.
 */

import WebSocket from "ws";
import { writeFileSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { Pinecall, tool } from "../../../index.js";
import { c } from "../../ui.js";

/** Debug trace to /tmp/debug.log (CLIENT side) to correlate with the server's. */
function cdbg(msg: string): void {
    try { appendFileSync("/tmp/debug.log", `${(Date.now() / 1000).toFixed(3)} CLIENT ${msg}\n`); } catch { /* ignore */ }
}
import { WavWriter } from "./wav.js";
import type { Spec, SpecResult, JudgeConfig } from "./types.js";

const SAMPLE_RATE = 16000;

/**
 * Minimal Zod-like schema for tool() — the SDK only needs `.parse()` + `._def`
 * (it duck-types Zod), so we avoid adding zod as a dependency. Builds an object
 * schema of required string fields.
 */
function stringObjectSchema(fields: Record<string, string>): any {
    const shape: Record<string, any> = {};
    for (const [key, description] of Object.entries(fields)) {
        shape[key] = { _def: { typeName: "ZodString", description }, parse: (x: unknown) => x };
    }
    return { _def: { typeName: "ZodObject", shape: () => shape }, parse: (x: unknown) => x };
}

export interface VoiceBridgeOptions {
    spec: Spec;
    /** Target agent slug (the agent under test). */
    target: string;
    /** Judge LLM, e.g. { provider: "anthropic", model: "claude-haiku-4-5-20251001" }. */
    judge: JudgeConfig;
    apiKey: string;
    /** HTTPS/WSS base, e.g. https://voice.pinecall.io */
    server: string;
    voice: string;
    stt: string;
    recordPath: string;
    play: boolean;
    language?: string;
    /** Tester greeting — judge opens. Omit to let the target greet first. */
    greeting?: string;
    /** Max call duration before giving up on a verdict (ms). */
    maxDurationMs?: number;
    log?: (msg: string) => void;
}

function buildVoicePrompt(spec: Spec, target: string): string {
    const today = new Date().toLocaleDateString("en-US", {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
    });
    return [
        `You are a QA tester on a live VOICE call with the AI agent "${target}". You are testing it by talking to it like a real customer would.`,
        `Today is ${today}.`,
        ``,
        `## How to behave`,
        `- Speak naturally and KEEP IT SHORT — one short sentence per turn. You are a caller, not a robot.`,
        `- Do NOT say you are a tester. Just behave like a real caller.`,
        `- Always reply in the same language the agent speaks.`,
        `- Work through the workflow below in order, evaluating each agent response.`,
        ``,
        `## Reporting the result (tools)`,
        `- Call \`test_passed(summary)\` as soon as the whole workflow is verified.`,
        `- Call \`test_failed(reason)\` the moment the agent says something wrong or fails a step.`,
        ``,
        `## Workflow to test`,
        spec.workflow,
    ].join("\n");
}

/**
 * Run a spec as a real voice call (judge agent ↔ target agent). Returns a
 * SpecResult just like the chat runner.
 */
export async function runVoiceBridge(opts: VoiceBridgeOptions): Promise<SpecResult> {
    const log = opts.log ?? (() => {});
    const startTime = Date.now();
    const wssBase = opts.server.replace(/^https:/, "wss:").replace(/^http:/, "ws:").replace(/\/$/, "");
    const httpBase = opts.server.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/$/, "");
    const judgeModel = `${opts.judge.provider}/${opts.judge.model}`;

    const pc = new Pinecall({ apiKey: opts.apiKey, apiUrl: wssBase });

    // ── Verdict: the judge LLM calls these local tools ──
    let resolveVerdict!: (v: { passed: boolean; summary: string }) => void;
    const verdictP = new Promise<{ passed: boolean; summary: string }>((r) => { resolveVerdict = r; });
    const testPassed = tool({
        name: "test_passed",
        description: "Call this when the workflow test has PASSED — all expected behaviors were observed.",
        schema: stringObjectSchema({ summary: "Brief summary of what was verified" }),
        execute: async ({ summary }: { summary: string }) => { resolveVerdict({ passed: true, summary }); return { ok: true }; },
    });
    const testFailed = tool({
        name: "test_failed",
        description: "Call this when the workflow test has FAILED — an expected behavior was NOT observed.",
        schema: stringObjectSchema({ reason: "What failed and why" }),
        execute: async ({ reason }: { reason: string }) => { resolveVerdict({ passed: false, summary: reason }); return { ok: true }; },
    });

    const judgeName = `judge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const judge = pc.agent(judgeName, {
        llm: judgeModel,
        prompt: buildVoicePrompt(opts.spec, opts.target),
        voice: opts.voice,
        stt: opts.stt,
        ...(opts.language ? { language: opts.language } : {}),
        tools: [testPassed, testFailed],
    } as any);

    // ── Transcript display ──
    // For a server-LLM agent the spoken line arrives as `message.confirmed`
    // (the confirmed assistant message), NOT bot.word — so:
    //   🗣 judge  ← message.confirmed (what the judge said)
    //   🎧 <target> ← user.message  (what the judge heard the target say)

    cdbg(`runVoiceBridge target=${opts.target} judgeModel=${judgeModel} voice=${opts.voice} stt=${opts.stt}`);
    for (const ev of ["call.started", "bot.speaking", "bot.word", "bot.finished", "user.speaking", "user.message", "turn.end", "message.confirmed", "llm.toolCall", "call.ended"]) {
        judge.on(ev as any, (a: any) => {
            const t = typeof a?.text === "string" ? ` text=${JSON.stringify(a.text.slice(0, 50))}`
                : typeof a?.word === "string" ? ` word=${a.word}` : "";
            cdbg(`recv ${ev}${t}`);
        });
    }

    const transcript: Array<{ who: string; text: string }> = [];
    // Color the speakers and leave a blank line whenever the floor changes hands,
    // so each turn reads as its own block instead of one dense wall of text.
    const judgeLabel = c.bold(c.purple("🗣  judge"));
    const targetLabel = c.bold(c.cyan(`🎧 ${opts.target}`));
    let lastWho = "";
    const speak = (who: string, label: string, text: string) => {
        if (lastWho && lastWho !== who) log("");
        lastWho = who;
        log(`  ${label}${c.dim(":")} ${text}`);
    };
    judge.on("message.confirmed", (e: any) => {
        if (e?.text) { speak("judge", judgeLabel, e.text); transcript.push({ who: "judge", text: e.text }); }
    });
    judge.on("user.message", (e: any) => {
        if (e?.text) { speak("target", targetLabel, e.text); transcript.push({ who: opts.target, text: e.text }); }
    });

    let endedReason = "";
    const endedP = new Promise<void>((r) => { judge.on("call.ended", (_c: any, reason: string) => { endedReason = reason || "ended"; r(); }); });
    const timeoutP = new Promise<void>((r) => setTimeout(r, opts.maxDurationMs ?? 180000));

    let liveWs: WebSocket | null = null;
    let wav: WavWriter | null = null;

    try {
        await pc.ready;
        const call = await judge.bridge(opts.target, {
            greeting: opts.greeting,
            media: { live: true, recording: true },
        });

        // Hosted live player (clean browser playback).
        const playerUrl = `${httpBase}/live/${call.id}/player?token=${encodeURIComponent(opts.apiKey)}`;
        log(`  ${c.dim("🔊 live:")} ${c.cyan(playerUrl)}`);
        log("");
        if (opts.play) openInBrowser(playerUrl);

        // Record the mixed call to a WAV.
        const wsUrl = httpBase.replace(/^http/, "ws") + `/live/${call.id}/ws?token=${encodeURIComponent(opts.apiKey)}`;
        liveWs = new WebSocket(wsUrl);
        liveWs.binaryType = "nodebuffer";
        wav = new WavWriter(opts.recordPath, SAMPLE_RATE, 1);
        liveWs.on("message", (data: Buffer, isBinary: boolean) => {
            if (isBinary && data.length >= 4) wav?.write(data);
        });
        liveWs.on("error", () => { /* non-fatal */ });

        // Wait for a verdict (tool), the call ending, or a timeout.
        const verdict = await Promise.race([
            verdictP,
            endedP.then(() => ({ passed: false, summary: `Call ended (${endedReason}) before a verdict` })),
            timeoutP.then(() => ({ passed: false, summary: "Timed out before the judge reached a verdict" })),
        ]);

        try { call.hangup?.(); } catch { /* ignore */ }

        return {
            file: opts.spec._file ?? "unknown",
            agent: opts.target,
            description: opts.spec.description ?? "",
            passed: verdict.passed,
            summary: verdict.summary,
            turns: transcript.map((t) => ({ testerMessage: t.who === "judge" ? t.text : "", agentResponse: t.who !== "judge" ? t.text : "", agentToolCalls: [] })),
            durationMs: Date.now() - startTime,
            recordingPath: opts.recordPath,
            recordingDuration: wav?.durationSeconds ?? 0,
        };
    } catch (err: any) {
        return {
            file: opts.spec._file ?? "unknown",
            agent: opts.target,
            description: opts.spec.description ?? "",
            passed: false,
            summary: "",
            turns: [],
            durationMs: Date.now() - startTime,
            error: err?.message ?? String(err),
        };
    } finally {
        try { liveWs?.close(); } catch { /* ignore */ }
        wav?.close();
        try { pc.disconnect(); } catch { /* ignore */ }
        if (transcript.length) {
            const lines = transcript.map((t) => `${t.who}: ${t.text}`).join("\n");
            try { writeFileSync(opts.recordPath.replace(/\.wav$/i, "") + ".transcript.txt", lines + "\n"); } catch { /* ignore */ }
        }
    }
}

function openInBrowser(url: string): void {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); } catch { /* ignore */ }
}

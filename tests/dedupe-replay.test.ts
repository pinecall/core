/**
 * Replay test — tk-476280.
 *
 * Feeds the captured `GET /events` frames (tests/fixtures/ev-replay.json, a
 * real WebRTC call against dev-acme where `user.message` and
 * `message.confirmed` each arrived TWICE for the same messageId) through
 * BOTH transcript reducers — the CLI console's (src/cli/console/
 * transcript-reducer.ts) and the browser's (ui/src/state/transcript-
 * reducer.ts) — and asserts each produces exactly ONE caller line and ONE
 * agent line for the duplicated call, not two.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTranscriptStore, type TranscriptCall } from "../src/cli/console/transcript-reducer.js";
import { apply, initialState, type ConsoleEvent } from "../ui/src/state/transcript-reducer.js";

const fixture = JSON.parse(
    readFileSync(fileURLToPath(new URL("./fixtures/ev-replay.json", import.meta.url)), "utf8"),
) as { frames: Array<{ event: string; data: Record<string, unknown> }> };

const WEBRTC_CALL_ID = "5cc5f7ae-6fb7-4baf-a45b-33401194f7e9";
const CALLER_TEXT = "Hello?";
const AGENT_TEXT = "Hello! Thanks for calling Acme Cleaners. How can I help you with your cleaning needs today?";

describe("dedupe replay (ev.log) — tk-476280", () => {
    it("src/cli/console/transcript-reducer.ts: one caller line, one agent line", () => {
        const store = createTranscriptStore();

        for (const frame of fixture.frames) {
            const data = frame.data as Record<string, unknown>;
            const agentId = String(data.agent ?? "dev-acme");
            const callId = String(data.callId ?? "");

            if (frame.event === "call.started") {
                store.feed(agentId, "call.started", [callArg(data)]);
                continue;
            }
            if (frame.event === "call.ended") {
                store.feed(agentId, "call.ended", [callArg(data), String(data.reason ?? "")]);
                continue;
            }
            store.feed(agentId, frame.event, [data, callArg({ ...data, callId })]);
        }

        const snapshot = store.get(WEBRTC_CALL_ID);
        expect(snapshot).toBeDefined();
        const callerLines = snapshot!.lines.filter((l) => l.who === "caller" && l.text === CALLER_TEXT);
        const agentLines = snapshot!.lines.filter((l) => l.who === "agent" && l.text === AGENT_TEXT);
        expect(callerLines).toHaveLength(1);
        expect(agentLines).toHaveLength(1);
    });

    it("ui/src/state/transcript-reducer.ts: one caller line, one agent line", () => {
        let state = initialState;

        fixture.frames.forEach((frame, i) => {
            const event: ConsoleEvent = { name: frame.event, data: frame.data as Record<string, unknown>, at: i * 1000 };
            state = apply(state, event);
        });

        const call = state.calls.find((c) => c.id === WEBRTC_CALL_ID);
        expect(call).toBeDefined();
        const callerLines = call!.lines.filter((l) => l.who === "caller" && l.text === CALLER_TEXT);
        const agentLines = call!.lines.filter((l) => l.who === "agent" && l.text === AGENT_TEXT);
        expect(callerLines).toHaveLength(1);
        expect(agentLines).toHaveLength(1);
    });
});

function callArg(data: Record<string, unknown>): TranscriptCall {
    return {
        id: String(data.callId ?? ""),
        from: typeof data.from === "string" ? data.from : undefined,
        to: typeof data.to === "string" ? data.to : undefined,
        direction: typeof data.direction === "string" ? data.direction : undefined,
        transport: typeof data.transport === "string" ? data.transport : undefined,
        duration: typeof data.duration === "number" ? data.duration : undefined,
    };
}

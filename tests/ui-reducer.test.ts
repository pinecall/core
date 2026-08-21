/**
 * The web console's transcript reducer (ui/src/state/transcript-reducer.ts).
 *
 * The same semantics the terminal live view renders, asserted on the model the
 * browser draws from: interim caller text replaced by the final, the agent's
 * line grown word by word, chat replies settled instead of finished, tools
 * inline with their result, and the cut marker on an interruption.
 */

import { describe, it, expect } from "vitest";
import {
    apply,
    seed,
    settle,
    initialState,
    type ConsoleState,
    type CallSnapshot,
} from "../ui/src/state/transcript-reducer.js";

let clock = 1_000;
const feed = (state: ConsoleState, name: string, data: Record<string, unknown> = {}, step = 100): ConsoleState => {
    clock += step;
    return apply(state, { name, data, at: clock });
};

const only = (s: ConsoleState): CallSnapshot => {
    expect(s.calls).toHaveLength(1);
    return s.calls[0];
};

const texts = (c: CallSnapshot) => c.lines.map((l) => `${l.who}: ${l.text}${l.cut ? " ⏏" : ""}`);

describe("transcript reducer — a voice call", () => {
    it("follows ringing → interims → words → tools → ended", () => {
        let s = initialState;
        s = feed(s, "call.ringing", { agent: "clara", callId: "c1", from: "+34600" });
        expect(only(s).state).toBe("ringing");

        s = feed(s, "call.started", { agent: "clara", callId: "c1", from: "+34600", to: "+3491", direction: "inbound", transport: "phone" });
        expect(only(s).channel).toBe("phone");
        expect(only(s).peer).toBe("+34600");
        expect(only(s).state).toBe("listening");

        // Interim caller text replaces itself and never lands as a line.
        for (const t of ["hola", "hola quería", "hola quería una cita"]) s = feed(s, "user.speaking", { agent: "clara", callId: "c1", text: t });
        expect(only(s).draft.caller).toBe("hola quería una cita");
        expect(only(s).lines).toHaveLength(0);

        s = feed(s, "user.message", { agent: "clara", callId: "c1", text: "Hola, quería una cita." });
        expect(only(s).draft.caller).toBeUndefined();
        expect(texts(only(s))).toEqual(["caller: Hola, quería una cita."]);

        s = feed(s, "turn.end", { agent: "clara", callId: "c1" });
        expect(only(s).state).toBe("thinking");

        s = feed(s, "llm.toolCall", {
            agent: "clara", callId: "c1",
            toolCalls: [{ name: "findSlot", arguments: '{"day":"lunes"}' }],
        });
        expect(only(s).lines[1].tool).toEqual({ name: "findSlot", args: { day: "lunes" } });
        expect(only(s).lines[1].final).toBe(false);

        s = feed(s, "llm.toolResult", { agent: "clara", callId: "c1", name: "findSlot", result: { at: "10:00" } });
        expect(only(s).lines[1]).toMatchObject({ final: true, tool: { name: "findSlot", result: { at: "10:00" } } });

        // The whole reply is announced up front but only what plays is shown.
        s = feed(s, "bot.speaking", { agent: "clara", callId: "c1", text: "Tengo hueco el lunes a las diez" });
        expect(only(s).draft.agent).toBe("");
        expect(only(s).state).toBe("speaking");
        for (const w of ["Tengo", "hueco", "el", "lunes", "a"]) s = feed(s, "bot.word", { agent: "clara", callId: "c1", word: w });
        expect(only(s).draft.agent).toBe("Tengo hueco el lunes a");
        expect(only(s).lines).toHaveLength(2);

        s = feed(s, "bot.finished", { agent: "clara", callId: "c1" });
        expect(only(s).draft.agent).toBeUndefined();
        expect(texts(only(s))[2]).toBe("agent: Tengo hueco el lunes a");
        expect(only(s).state).toBe("listening");

        s = feed(s, "call.ended", { agent: "clara", callId: "c1", reason: "hangup", duration: 12.4 });
        const call = only(s);
        expect(call.state).toBe("ended");
        expect(call.durationS).toBe(12.4);
        expect(call.reason).toBe("hangup");
        expect(call.endedAt).toBeGreaterThan(call.startedAt);
    });

    it("marks an interrupted line as cut and keeps only what was heard", () => {
        let s = initialState;
        s = feed(s, "call.started", { agent: "a", callId: "c2", transport: "webrtc" });
        s = feed(s, "bot.speaking", { agent: "a", callId: "c2", text: "Le explico todo el procedimiento con calma" });
        for (const w of ["Le", "explico", "todo"]) s = feed(s, "bot.word", { agent: "a", callId: "c2", word: w });
        s = feed(s, "bot.interrupted", { agent: "a", callId: "c2" });
        expect(texts(only(s))).toEqual(["agent: Le explico todo ⏏"]);
        expect(only(s).lines[0].cut).toBe(true);
        expect(only(s).channel).toBe("webrtc");
    });

    it("falls back to the announced text when no word ever played", () => {
        let s = initialState;
        s = feed(s, "call.started", { agent: "a", callId: "c3", transport: "phone" });
        s = feed(s, "bot.speaking", { agent: "a", callId: "c3", text: "Un momento" });
        s = feed(s, "bot.finished", { agent: "a", callId: "c3" });
        expect(texts(only(s))).toEqual(["agent: Un momento"]);
    });
});

describe("transcript reducer — a chat session", () => {
    it("opens implicitly, streams chunks into one line and settles it", () => {
        let s = initialState;
        // No call.started, no chat.started: the first event opens the session.
        s = feed(s, "user.message", { agent: "clara", callId: "s1", transport: "chat", text: "¿Abren el sábado?" });
        expect(only(s).channel).toBe("chat");
        expect(only(s).state).toBe("thinking");

        s = feed(s, "bot.speaking", { agent: "clara", callId: "s1", text: "Sí, " }, 10);
        s = feed(s, "bot.speaking", { agent: "clara", callId: "s1", text: "de 9 a 14." }, 10);
        expect(only(s).draft.agent).toBe("Sí, de 9 a 14.");
        expect(only(s).state).toBe("speaking");

        // Not settled yet — nothing is fixed.
        s = settle(s, clock + 100);
        expect(only(s).lines).toHaveLength(1);

        s = settle(s, clock + 400);
        expect(texts(only(s))).toEqual(["caller: ¿Abren el sábado?", "agent: Sí, de 9 a 14."]);
        expect(only(s).state).toBe("listening");
    });

    it("does not print a reply the server re-sends whole", () => {
        let s = initialState;
        s = feed(s, "chat.started", { agent: "a", callId: "s2", transport: "chat" });
        s = feed(s, "bot.speaking", { agent: "a", callId: "s2", text: "Hola" }, 10);
        s = settle(s, clock + 400);
        expect(texts(only(s))).toEqual(["agent: Hola"]);
        s = feed(s, "bot.speaking", { agent: "a", callId: "s2", text: "Hola" }, 10);
        s = settle(s, clock + 400);
        expect(texts(only(s))).toEqual(["agent: Hola"]);
    });

    it("closes a reply in flight when the user answers", () => {
        let s = initialState;
        s = feed(s, "chat.started", { agent: "a", callId: "s3", transport: "chat" });
        s = feed(s, "bot.speaking", { agent: "a", callId: "s3", text: "¿Algo más?" });
        s = feed(s, "user.message", { agent: "a", callId: "s3", text: "No, gracias" });
        expect(texts(only(s))).toEqual(["agent: ¿Algo más?", "caller: No, gracias"]);
    });
});

describe("transcript reducer — housekeeping", () => {
    it("seeds from console.hello snapshots and keeps applying events to them", () => {
        const snapshot: CallSnapshot = {
            id: "c9", agent: "a", channel: "phone", startedAt: 1, state: "listening", lines: [], draft: {},
        };
        let s = seed([snapshot]);
        s = feed(s, "user.message", { agent: "a", callId: "c9", text: "hola" });
        expect(texts(only(s))).toEqual(["caller: hola"]);
    });

    it("ignores stream frames that are not call events and unknown calls", () => {
        let s = initialState;
        s = feed(s, "connected", { agents: ["a"] });
        s = feed(s, "console.hello", { agents: [], calls: [] });
        s = feed(s, "user.speaking", { agent: "a", callId: "ghost", text: "…" });
        expect(s.calls).toHaveLength(0);
    });

    it("keeps calls newest first and never mutates the previous state", () => {
        let s = initialState;
        s = feed(s, "call.started", { agent: "a", callId: "one", transport: "phone" });
        const before = s;
        s = feed(s, "call.started", { agent: "a", callId: "two", transport: "phone" });
        expect(s.calls.map((c) => c.id)).toEqual(["two", "one"]);
        expect(before.calls.map((c) => c.id)).toEqual(["one"]);
    });

    it("renders a WhatsApp exchange as whole messages", () => {
        let s = initialState;
        s = feed(s, "whatsapp.message", { agent: "a", callId: "wa1", from: "+34600", text: "hola" });
        s = feed(s, "whatsapp.response", { agent: "a", callId: "wa1", text: "¡Hola!" });
        expect(only(s).channel).toBe("whatsapp");
        expect(texts(only(s))).toEqual(["caller: hola", "agent: ¡Hola!"]);
    });
});

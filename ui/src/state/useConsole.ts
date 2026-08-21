/**
 * The console's live state — one EventSource, one reducer.
 *
 * `/events` opens with a synthetic `console.hello` carrying the agents and the
 * calls so far, so a reconnecting page resyncs in a single round trip; every
 * event after it goes through the SAME transcript reducer the terminal live
 * view uses. The connection retries with a capped backoff, and each frame is
 * also kept raw for the events drawer.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { apply, seed, settle, initialState, type CallSnapshot, type ConsoleState } from "./transcript-reducer.js";
import { eventsUrl, fetchAgents, fetchCalls, type AgentInfo } from "../api.js";

/** Every frame the console listens to: the reducer's diet plus the noise the drawer shows. */
const FRAMES = [
    "console.hello", "connected",
    "call.started", "call.ended", "call.ringing", "chat.started", "whatsapp.started",
    "speech.started", "speech.ended", "user.speaking", "user.message",
    "eager.turn", "turn.pause", "turn.end", "turn.resumed", "turn.continued",
    "bot.speaking", "bot.word", "bot.finished", "bot.interrupted",
    "llm.toolCall", "llm.toolResult", "tool.result",
    "message.confirmed", "reply.rejected", "audio.metrics",
    "session.idleWarning", "session.timeout", "session.paused", "session.resumed",
    "skill.loaded", "skill.unloaded",
    "whatsapp.message", "whatsapp.response", "whatsapp.status",
];

export type StreamStatus = "connecting" | "live" | "reconnecting";

export interface RawEvent {
    seq: number;
    name: string;
    at: number;
    data: Record<string, unknown>;
}

const MAX_EVENTS = 300;

export interface Console {
    calls: CallSnapshot[];
    agents: AgentInfo[];
    status: StreamStatus;
    events: RawEvent[];
}

export function useConsole(): Console {
    const [state, setState] = useState<ConsoleState>(initialState);
    const [agents, setAgents] = useState<AgentInfo[]>([]);
    const [status, setStatus] = useState<StreamStatus>("connecting");
    const [events, setEvents] = useState<RawEvent[]>([]);
    const seq = useRef(0);

    useEffect(() => {
        let closed = false;
        let source: EventSource | null = null;
        let retry: ReturnType<typeof setTimeout> | null = null;
        let attempt = 0;

        const push = (name: string, data: Record<string, unknown>, at: number) => {
            seq.current += 1;
            const frame = { seq: seq.current, name, at, data };
            setEvents((prev) => (prev.length >= MAX_EVENTS ? [...prev.slice(prev.length - MAX_EVENTS + 1), frame] : [...prev, frame]));
        };

        const open = () => {
            source = new EventSource(eventsUrl());
            source.onopen = () => {
                attempt = 0;
                setStatus("live");
            };
            source.onerror = () => {
                if (closed) return;
                setStatus("reconnecting");
                source?.close();
                // Backoff: 0.5s, 1s, 2s, 4s, then every 8s.
                const wait = Math.min(500 * 2 ** attempt++, 8000);
                retry = setTimeout(open, wait);
            };
            for (const name of FRAMES) {
                source.addEventListener(name, (e) => {
                    const at = Date.now();
                    let data: Record<string, unknown> = {};
                    try {
                        data = JSON.parse((e as MessageEvent).data) as Record<string, unknown>;
                    } catch {
                        /* a frame we cannot read is still worth counting */
                    }
                    if (name === "console.hello") {
                        // The resync: agents and every call the process knows about.
                        if (Array.isArray(data.agents)) setAgents(data.agents as AgentInfo[]);
                        if (Array.isArray(data.calls)) setState(seed(data.calls as CallSnapshot[]));
                    } else {
                        setState((prev) => apply(prev, { name, data, at }));
                    }
                    push(name, data, at);
                });
            }
        };

        open();

        // The server may be older than the page (or `console.hello` may be
        // missing): fall back to the snapshot endpoints once on boot.
        fetchAgents().then((a) => setAgents((cur) => (cur.length ? cur : a))).catch(() => {});
        fetchCalls().then((c) => setState((cur) => (cur.calls.length ? cur : seed(c)))).catch(() => {});

        return () => {
            closed = true;
            if (retry) clearTimeout(retry);
            source?.close();
        };
    }, []);

    // Chat and WhatsApp have no `bot.finished`: their replies are fixed once
    // the chunks stop. The reducer stays clockless; the tick lives here.
    useEffect(() => {
        const t = setInterval(() => setState((prev) => settle(prev, Date.now())), 150);
        return () => clearInterval(t);
    }, []);

    return useMemo(() => ({ calls: state.calls, agents, status, events }), [state.calls, agents, status, events]);
}

/** A clock that re-renders the elapsed timers, and nothing else. */
export function useNow(everyMs = 500): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), everyMs);
        return () => clearInterval(t);
    }, [everyMs]);
    return now;
}

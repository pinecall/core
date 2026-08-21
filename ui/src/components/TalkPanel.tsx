/**
 * Talk to the agent — the two doors this console opens itself.
 *
 *   Voice  a real WebRTC call from this page (@pinecall/web/core). The token
 *          is minted by the runner (POST /token); the API key never gets here.
 *   Chat   a text session over the same agent (POST /chat-token).
 *
 * Neither renders its own transcript: both are ordinary calls of the process,
 * so they arrive on the event stream and are drawn in the centre column like a
 * phone call. Selecting them is the only thing this panel does about it.
 *
 * `@pinecall/web` is imported on demand: a console that only watches phone
 * calls never downloads the WebRTC client.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { VoiceSession, VoiceSessionState } from "@pinecall/web/core";
import type { ChatSession, ChatSessionState } from "@pinecall/web/chat";
import { Badge, Button, Input, Segmented, Waveform } from "@pinecall/react-theme";
import { chatToken, voiceToken, type AgentInfo } from "../api.js";
import type { CallSnapshot } from "../state/transcript-reducer.js";

export function TalkPanel({
    agent, calls, onCallStarted,
}: {
    agent: AgentInfo | null;
    calls: CallSnapshot[];
    onCallStarted: (id: string) => void;
}) {
    const [tab, setTab] = useState<"voice" | "chat">("voice");
    return (
        <div className="pcc-panel">
            <header className="pcc-panel-head">
                <h2 className="pcc-panel-title">Talk to {agent?.label || agent?.id || "the agent"}</h2>
                <Segmented
                    items={[{ key: "voice", label: "Voice" }, { key: "chat", label: "Chat" }]}
                    value={tab}
                    onChange={(k) => setTab(k as "voice" | "chat")}
                />
            </header>

            <div className="pcc-talk-body">
                {tab === "voice"
                    ? <Voice agent={agent} calls={calls} onCallStarted={onCallStarted} />
                    : <Chat agent={agent} calls={calls} onCallStarted={onCallStarted} />}
            </div>
        </div>
    );
}

// ── Voice ────────────────────────────────────────────────────────────────

const IDLE_VOICE = {
    status: "idle", phase: "idle", messages: [], toolCalls: [], isMuted: false,
    duration: 0, error: null, userSpeaking: false, agentSpeaking: false, idleWarning: null,
} as VoiceSessionState;

function Voice({ agent, calls, onCallStarted }: { agent: AgentInfo | null; calls: CallSnapshot[]; onCallStarted: (id: string) => void }) {
    const ref = useRef<VoiceSession | null>(null);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        if (!agent) return;
        let alive = true;
        void import("@pinecall/web/core").then(({ VoiceSession }) => {
            if (!alive) return;
            ref.current = new VoiceSession({ agent: agent.id, tokenProvider: voiceToken(agent.id) });
            setReady(true);
        });
        return () => {
            alive = false;
            ref.current?.disconnect();
            ref.current = null;
            setReady(false);
        };
    }, [agent?.id]);

    const state = useSyncExternalStore(
        useCallback((cb: () => void) => (ready && ref.current ? ref.current.subscribe(cb) : () => {}), [ready]),
        () => (ready && ref.current ? ref.current.getState() : IDLE_VOICE),
        () => IDLE_VOICE,
    );

    const live = state.status === "connected";

    // The call this page just placed is one of the process's calls: select it.
    const newest = calls.find((c) => c.channel === "webrtc" && c.state !== "ended")?.id;
    useEffect(() => {
        if (live && newest) onCallStarted(newest);
    }, [live, newest, onCallStarted]);

    return (
        <div className="pcc-talk">
            <p className="pcc-quiet">
                A real call over WebRTC — the runner mints the token, so no key ever reaches this page.
            </p>
            <div className="pcc-talk-row">
                <Button
                    variant={live ? "danger" : "primary"}
                    disabled={!ready || state.status === "connecting"}
                    loading={state.status === "connecting"}
                    onClick={() => (live ? ref.current?.disconnect() : ref.current?.connect())}
                >
                    {live ? "Hang up" : "Call the agent"}
                </Button>
                {live && (
                    <>
                        <Badge tone={state.phase === "speaking" ? "accent" : "success"} dot>{state.phase}</Badge>
                        {state.agentSpeaking && <Waveform bars={7} className="pcc-wave" />}
                        <span className="mono pcc-elapsed">{fmt(state.duration)}</span>
                        <Button size="sm" variant="ghost" onClick={() => ref.current?.toggleMute()}>
                            {state.isMuted ? "Unmute" : "Mute"}
                        </Button>
                    </>
                )}
            </div>
            {state.error && <p className="pcc-error">{state.error}</p>}
            {agent?.phone && (
                <p className="pcc-quiet">
                    Or ring <span className="mono">{agent.phone}</span> — that call lands in the same list.
                </p>
            )}
        </div>
    );
}

// ── Chat ─────────────────────────────────────────────────────────────────

const IDLE_CHAT = { status: "idle", error: null, messages: [], typing: false, streamingText: "", sessionId: null } as ChatSessionState;

function Chat({ agent, calls, onCallStarted }: { agent: AgentInfo | null; calls: CallSnapshot[]; onCallStarted: (id: string) => void }) {
    const ref = useRef<ChatSession | null>(null);
    const [ready, setReady] = useState(false);
    const [text, setText] = useState("");

    useEffect(() => {
        if (!agent) return;
        let alive = true;
        void import("@pinecall/web/chat").then(({ ChatSession }) => {
            if (!alive) return;
            ref.current = new ChatSession({ agent: agent.id, tokenProvider: chatToken(agent.id) });
            setReady(true);
        });
        return () => {
            alive = false;
            ref.current?.destroy();
            ref.current = null;
            setReady(false);
        };
    }, [agent?.id]);

    const state = useSyncExternalStore(
        useCallback((cb: () => void) => (ready && ref.current ? ref.current.subscribe(cb) : () => {}), [ready]),
        () => (ready && ref.current ? ref.current.getState() : IDLE_CHAT),
        () => IDLE_CHAT,
    );

    const connected = state.status === "connected";
    const newest = calls.find((c) => c.channel === "chat" && c.state !== "ended")?.id;
    useEffect(() => {
        if (connected && newest) onCallStarted(newest);
    }, [connected, newest, onCallStarted]);

    const send = async () => {
        const body = text.trim();
        if (!body || !ref.current) return;
        if (!connected) await ref.current.connect();
        ref.current.send(body);
        setText("");
    };

    return (
        <div className="pcc-talk">
            <p className="pcc-quiet">
                A text session on the same agent — it shows up in the list as a chat call, transcript in the middle.
            </p>
            <form
                className="pcc-talk-row"
                onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                }}
            >
                <Input
                    value={text}
                    placeholder={ready ? "Say something…" : "Loading…"}
                    disabled={!ready}
                    onChange={(e) => setText(e.currentTarget.value)}
                />
                <Button type="submit" variant="primary" disabled={!ready || !text.trim()}>Send</Button>
            </form>
            <div className="pcc-talk-row">
                <Badge tone={connected ? "success" : "neutral"} dot={connected}>{state.status}</Badge>
                {state.typing && <span className="pcc-quiet">the agent is typing…</span>}
                {connected && (
                    <Button size="sm" variant="ghost" onClick={() => ref.current?.disconnect()}>End chat</Button>
                )}
            </div>
            {state.error && <p className="pcc-error">{state.error}</p>}
        </div>
    );
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

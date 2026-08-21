/**
 * The calls column — live first, then what already ended.
 *
 * A live call carries the state the terminal shows on its last line
 * (listening / thinking / speaking) and a timer that keeps running; an ended
 * one keeps its duration, its reason and its opening line.
 */

import { Badge, Waveform } from "@pinecall/react-theme";
import type { CallSnapshot } from "../state/transcript-reducer.js";
import { useNow } from "../state/useConsole.js";

const GLYPH: Record<CallSnapshot["channel"], string> = {
    phone: "☎",
    webrtc: "◉",
    chat: "💬",
    whatsapp: "✆",
};

const TONE = {
    ringing: "info",
    listening: "success",
    thinking: "warning",
    speaking: "accent",
    ended: "neutral",
} as const;

export function CallsList({
    calls, selected, onSelect, multiAgent,
}: {
    calls: CallSnapshot[];
    selected: string | null;
    onSelect: (id: string) => void;
    multiAgent: boolean;
}) {
    const now = useNow();
    const live = calls.filter((c) => c.state !== "ended");
    const past = calls.filter((c) => c.state === "ended");

    return (
        <div className="pcc-list">
            <h2 className="pcc-title">Live {live.length > 0 && <span className="mono">{live.length}</span>}</h2>
            {live.length === 0 && <p className="pcc-quiet">No call in progress.</p>}
            {live.map((c) => (
                <CallCard key={c.id} call={c} now={now} selected={c.id === selected} onSelect={onSelect} multiAgent={multiAgent} />
            ))}

            <h2 className="pcc-title">Recent</h2>
            {past.length === 0 && <p className="pcc-quiet">Nothing yet.</p>}
            {past.map((c) => (
                <CallCard key={c.id} call={c} now={now} selected={c.id === selected} onSelect={onSelect} multiAgent={multiAgent} />
            ))}
        </div>
    );
}

function CallCard({
    call, now, selected, onSelect, multiAgent,
}: {
    call: CallSnapshot;
    now: number;
    selected: boolean;
    onSelect: (id: string) => void;
    multiAgent: boolean;
}) {
    const ended = call.state === "ended";
    const secs = ended ? (call.durationS ?? 0) : (now - call.startedAt) / 1000;
    const first = call.lines.find((l) => l.who !== "tool")?.text;

    return (
        <button
            type="button"
            className={`pcc-call${selected ? " on" : ""}${ended ? " past" : ""}`}
            onClick={() => onSelect(call.id)}
            aria-current={selected}
        >
            <span className="pcc-call-head">
                <span className="pcc-glyph" aria-hidden>{GLYPH[call.channel]}</span>
                <span className="pcc-peer">{peerOf(call)}</span>
                <span className="pcc-elapsed mono">{clock(secs)}</span>
            </span>
            <span className="pcc-call-foot">
                <Badge tone={TONE[call.state]} dot={!ended}>{call.state}</Badge>
                {call.state === "speaking" && <Waveform bars={7} className="pcc-wave" />}
                {multiAgent && <span className="pcc-quiet mono">{call.agent}</span>}
                {ended && call.reason && <span className="pcc-quiet">{call.reason}</span>}
            </span>
            {first && <span className="pcc-first">{first}</span>}
        </button>
    );
}

export function peerOf(call: CallSnapshot): string {
    if (call.peer) return call.peer;
    return call.channel === "webrtc" ? "browser" : call.channel === "chat" ? "chat" : "unknown";
}

export function clock(secs: number): string {
    const s = Math.max(0, Math.floor(secs));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

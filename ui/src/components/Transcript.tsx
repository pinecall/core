/**
 * The selected call — the same transcript the terminal draws, as bubbles.
 *
 * Caller left, agent right, tools centred. The caller's DRAFT bubble is the
 * interim STT text (dimmed, replaced by the final); the agent's draft grows
 * word by word as the audio plays and is fixed on `bot.finished` — or carries
 * `⏏` when the caller cut in. Auto-scroll follows the conversation and steps
 * aside the moment you scroll up, with a way back to live.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Badge, Button, Typing } from "@pinecall/react-theme";
import type { CallSnapshot, Line } from "../state/transcript-reducer.js";
import { hangup } from "../api.js";
import { clock, peerOf } from "./CallsList.js";
import { useNow } from "../state/useConsole.js";

export function Transcript({ call }: { call: CallSnapshot }) {
    const now = useNow();
    const scroller = useRef<HTMLDivElement>(null);
    const [follow, setFollow] = useState(true);
    const [ending, setEnding] = useState(false);
    const ended = call.state === "ended";
    const secs = ended ? (call.durationS ?? 0) : (now - call.startedAt) / 1000;

    // A new call starts at the bottom, following again.
    useEffect(() => setFollow(true), [call.id]);

    useLayoutEffect(() => {
        const el = scroller.current;
        if (el && follow) el.scrollTop = el.scrollHeight;
    });

    const onScroll = () => {
        const el = scroller.current;
        if (!el) return;
        setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
    };

    return (
        <div className="pcc-panel">
            <header className="pcc-panel-head">
                <div>
                    <h2 className="pcc-panel-title">{peerOf(call)}</h2>
                    <p className="pcc-quiet mono">
                        {call.channel}{call.direction ? ` · ${call.direction}` : ""} · {call.id}
                    </p>
                </div>
                <div className="pcc-panel-actions">
                    <span className="mono pcc-elapsed">{clock(secs)}</span>
                    <Badge tone={ended ? "neutral" : call.state === "speaking" ? "accent" : "success"} dot={!ended}>
                        {ended ? (call.reason || "ended") : call.state}
                    </Badge>
                    {!ended && (
                        <Button
                            size="sm"
                            variant="danger"
                            loading={ending}
                            onClick={() => {
                                setEnding(true);
                                hangup(call.id).catch(() => {}).finally(() => setEnding(false));
                            }}
                        >
                            Hang up
                        </Button>
                    )}
                </div>
            </header>

            <div className="pcc-scroll" ref={scroller} onScroll={onScroll}>
                <ol className="pcc-bubbles">
                    {call.lines.map((line, i) => (
                        <Bubble key={i} line={line} start={call.startedAt} />
                    ))}
                    {call.draft.caller && (
                        <Bubble line={{ who: "caller", text: call.draft.caller, at: now, final: false }} start={call.startedAt} />
                    )}
                    {call.draft.agent !== undefined && (
                        <Bubble line={{ who: "agent", text: call.draft.agent, at: now, final: false }} start={call.startedAt} />
                    )}
                    {call.state === "thinking" && <li className="pcc-thinking"><Typing /></li>}
                </ol>
            </div>

            {!follow && (
                <div className="pcc-jump">
                    <Button size="sm" onClick={() => setFollow(true)}>Jump to live ↓</Button>
                </div>
            )}
        </div>
    );
}

function Bubble({ line, start }: { line: Line; start: number }) {
    const stamp = `t+${((line.at - start) / 1000).toFixed(1)}s`;

    if (line.who === "tool") return <ToolChip line={line} stamp={stamp} />;

    const caller = line.who === "caller";
    return (
        <li className={`pcc-row ${caller ? "left" : "right"}`}>
            <p className={`pcc-bubble ${caller ? "caller" : "agent"}${line.final ? "" : " draft"}`}>
                {line.text || "…"}
                {line.cut && <span className="pcc-cut" title="interrupted"> ⏏</span>}
            </p>
            <span className="pcc-stamp mono">{stamp}</span>
        </li>
    );
}

/** `⚡ name(args)` → `✓ result`, expandable into the raw JSON. */
function ToolChip({ line, stamp }: { line: Line; stamp: string }) {
    const [open, setOpen] = useState(false);
    const tool = line.tool!;
    const done = line.final;
    return (
        <li className="pcc-row center">
            <button type="button" className={`pcc-tool${done ? " done" : ""}`} onClick={() => setOpen((o) => !o)}>
                <span className="mono">{done ? "✓" : "⚡"} {tool.name}({inline(tool.args)})</span>
                <span className="pcc-stamp mono">{stamp}</span>
            </button>
            {open && (
                <pre className="pcc-json mono">
{JSON.stringify({ args: tool.args, result: tool.result }, null, 2)}
                </pre>
            )}
        </li>
    );
}

/** A one-line argument summary — the whole JSON is one click away. */
function inline(args: unknown): string {
    if (args === undefined || args === null) return "";
    if (typeof args !== "object") return String(args);
    const entries = Object.entries(args as Record<string, unknown>);
    const text = entries.map(([k, v]) => `${k}: ${typeof v === "string" ? `"${v}"` : JSON.stringify(v)}`).join(", ");
    return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

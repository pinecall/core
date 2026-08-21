/**
 * The events drawer — what `pinecall run --events` prints, in a panel.
 *
 * Raw frames off the stream: name, agent, call and a compact payload summary,
 * newest last, capped by the stream hook.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { Button, Input } from "@pinecall/react-theme";
import type { RawEvent } from "../state/useConsole.js";

export function EventsDrawer({ events, onClose }: { events: RawEvent[]; onClose: () => void }) {
    const [filter, setFilter] = useState("");
    const box = useRef<HTMLDivElement>(null);
    const shown = filter
        ? events.filter((e) => e.name.includes(filter) || JSON.stringify(e.data).includes(filter))
        : events;

    useLayoutEffect(() => {
        const el = box.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [shown.length]);

    return (
        <aside className="pcc-drawer" aria-label="Events">
            <header className="pcc-drawer-head">
                <h2 className="pcc-panel-title">Events <span className="mono pcc-quiet">{shown.length}</span></h2>
                <Input value={filter} placeholder="filter…" onChange={(e) => setFilter(e.currentTarget.value)} />
                <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
            </header>
            <div className="pcc-drawer-body mono" ref={box}>
                {shown.map((e) => (
                    <div key={e.seq} className="pcc-event">
                        <span className="pcc-quiet">{time(e.at)}</span>
                        <span className="pcc-event-name">{e.name}</span>
                        <span className="pcc-quiet">{summary(e.data)}</span>
                    </div>
                ))}
                {shown.length === 0 && <p className="pcc-quiet">Nothing yet.</p>}
            </div>
        </aside>
    );
}

function time(at: number): string {
    const d = new Date(at);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** One compact line of payload, the way the terminal's debug mode prints it. */
function summary(data: Record<string, unknown>): string {
    const text = Object.entries(data)
        .filter(([k]) => k !== "agent")
        .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" · ");
    return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

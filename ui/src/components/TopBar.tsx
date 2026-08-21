/** The top bar: what is running, which agent, whether the stream is alive. */

import { Badge, Button, Select, ThemeToggle } from "@pinecall/react-theme";
import type { AgentInfo } from "../api.js";
import type { StreamStatus } from "../state/useConsole.js";

export function TopBar({
    agents, agent, onAgent, status, events, drawer, onDrawer,
}: {
    agents: AgentInfo[];
    agent: string;
    onAgent: (id: string) => void;
    status: StreamStatus;
    events: number;
    drawer: boolean;
    onDrawer: () => void;
}) {
    const one = agents.find((a) => a.id === agent);
    return (
        <header className="pcc-top">
            <div className="pcc-brand">
                <span className="pcc-mark" aria-hidden>◉</span>
                <span className="pcc-run mono">pinecall run</span>
                {one && (
                    <span className="pcc-meta">
                        {one.phone && <span className="mono">{one.phone}</span>}
                        {one.llm && <span className="mono">{one.llm}</span>}
                        {one.voice && <span className="mono">{one.voice}</span>}
                        {one.channels?.length > 0 && <span>{one.channels.join(" · ")}</span>}
                    </span>
                )}
            </div>

            <div className="pcc-top-right">
                {agents.length > 1 && (
                    <Select value={agent} onChange={(e) => onAgent(e.currentTarget.value)} aria-label="Agent">
                        {agents.map((a) => (
                            <option key={a.id} value={a.id}>{a.label || a.id}</option>
                        ))}
                    </Select>
                )}
                <Badge tone={status === "live" ? "success" : status === "connecting" ? "neutral" : "warning"} dot>
                    {status === "live" ? "live" : status === "connecting" ? "connecting" : "reconnecting"}
                </Badge>
                <Button size="sm" variant={drawer ? "secondary" : "ghost"} onClick={onDrawer}>
                    Events {events > 0 && <span className="pcc-count mono">{events}</span>}
                </Button>
                <ThemeToggle />
            </div>
        </header>
    );
}

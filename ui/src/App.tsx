/**
 * The console — three columns over one event stream.
 *
 *   calls (live, then recent)  ·  the selected call's transcript  ·  talk to the agent
 *
 * Everything below observes the SAME agent events the terminal live view
 * renders; nothing here holds a Pinecall key.
 */

import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "@pinecall/react-theme";
import { useConsole } from "./state/useConsole.js";
import { TopBar } from "./components/TopBar.js";
import { CallsList } from "./components/CallsList.js";
import { Transcript } from "./components/Transcript.js";
import { TalkPanel } from "./components/TalkPanel.js";
import { EventsDrawer } from "./components/EventsDrawer.js";

export function App() {
    const { calls, agents, status, events } = useConsole();
    const [agent, setAgent] = useState<string>("");
    const [selected, setSelected] = useState<string | null>(null);
    /** True once you have chosen a call yourself — then the console stops following. */
    const [pinned, setPinned] = useState(false);
    const [drawer, setDrawer] = useState(false);

    // One agent needs no choosing; several default to the first one announced.
    const current = agent || agents[0]?.id || "";
    useEffect(() => {
        if (!agent && agents.length) setAgent(agents[0].id);
    }, [agents, agent]);

    const shown = useMemo(
        () => (agents.length > 1 && current ? calls.filter((c) => c.agent === current) : calls),
        [calls, agents.length, current],
    );

    // Follow the live call: a browser call, a phone call ringing in — whatever
    // is happening is what you want on screen, until you pick something else.
    const live = shown.filter((c) => c.state !== "ended");
    const following = live[0]?.id ?? shown[0]?.id ?? null;
    useEffect(() => {
        if (pinned && selected && shown.some((c) => c.id === selected)) return;
        setSelected(following);
    }, [following, pinned, selected, shown]);

    const select = (id: string) => {
        setPinned(true);
        setSelected(id);
    };

    const call = shown.find((c) => c.id === selected) ?? null;

    return (
        <div className="pcc">
            <TopBar
                agents={agents}
                agent={current}
                onAgent={setAgent}
                status={status}
                events={events.length}
                drawer={drawer}
                onDrawer={() => setDrawer((d) => !d)}
            />

            <main className="pcc-cols">
                <section className="pcc-col pcc-calls" aria-label="Calls">
                    <CallsList calls={shown} selected={selected} onSelect={select} multiAgent={agents.length > 1} />
                </section>

                <section className="pcc-col pcc-transcript" aria-label="Transcript">
                    {call ? (
                        <Transcript call={call} />
                    ) : (
                        <div className="pcc-center">
                            <EmptyState icon={<span className="pcc-glyph">◉</span>}>
                                Nothing on the line yet — call the agent from the panel on the right, or ring its number.
                            </EmptyState>
                        </div>
                    )}
                </section>

                <section className="pcc-col pcc-talk" aria-label="Talk to the agent">
                    <TalkPanel agent={agents.find((a) => a.id === current) ?? null} onCallStarted={select} calls={shown} />
                </section>
            </main>

            {drawer && <EventsDrawer events={events} onClose={() => setDrawer(false)} />}
        </div>
    );
}

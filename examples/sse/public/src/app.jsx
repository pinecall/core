const { useState, useEffect, useRef, useCallback } = React;

// ── Helpers ─────────────────────────────────────────────────────────────

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ── Icons (inline SVG) ──────────────────────────────────────────────────

function PhoneInIcon() {
  return React.createElement("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
    React.createElement("path", { d: "M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" }),
    React.createElement("polyline", { points: "22 2 15 2 15 9" }),
    React.createElement("line", { x1: 22, y1: 2, x2: 15, y2: 9 })
  );
}

function PhoneOutIcon() {
  return React.createElement("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
    React.createElement("path", { d: "M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" }),
    React.createElement("polyline", { points: "15 2 22 2 22 9" }),
    React.createElement("line", { x1: 15, y1: 9, x2: 22, y2: 2 })
  );
}

function PhoneOffIcon() {
  return React.createElement("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
    React.createElement("path", { d: "M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" }),
    React.createElement("line", { x1: 23, y1: 1, x2: 1, y2: 23 })
  );
}

// ── useSSE hook ─────────────────────────────────────────────────────────

function useSSE() {
  const [calls, setCalls] = useState({});
  const [events, setEvents] = useState([]);

  useEffect(() => {
    const es = new EventSource("/events");

    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.event === "connected") return;

      // Append to event log (keep last 100)
      setEvents((prev) => [...prev.slice(-99), { ...data, _ts: Date.now() }]);

      const id = data.call_id;
      if (!id) return;

      setCalls((prev) => {
        const call = prev[id] || {
          id, from: "", to: "", direction: "inbound", status: "active",
          startedAt: Date.now(), messages: [], botText: "", interrupted: false,
        };

        switch (data.event) {
          case "call.started":
            return { ...prev, [id]: { ...call, from: data.from, to: data.to, direction: data.direction || "inbound", status: "active", startedAt: Date.now(), messages: [], botText: "" } };
          case "call.ended":
            return { ...prev, [id]: { ...call, status: "ended", duration: data.duration } };
          case "user.speaking":
            return { ...prev, [id]: { ...call, messages: [...call.messages.filter(m => m.type !== "user-interim"), { type: "user-interim", text: data.text, ts: Date.now() }] } };
          case "user.message":
            return { ...prev, [id]: { ...call, messages: [...call.messages.filter(m => m.type !== "user-interim"), { type: "user", text: data.text, ts: Date.now() }] } };
          case "bot.speaking":
            return { ...prev, [id]: { ...call, botText: "", interrupted: false, messages: [...call.messages, { type: "bot-speaking", text: data.text || "...", ts: Date.now() }] } };
          case "bot.word":
            return { ...prev, [id]: { ...call, botText: data.currentBotText || call.botText } };
          case "bot.finished":
            const finalText = data.currentBotText || call.botText;
            const msgs = call.messages.filter(m => m.type !== "bot-speaking");
            return { ...prev, [id]: { ...call, botText: "", messages: [...msgs, { type: "bot", text: finalText, ts: Date.now() }] } };
          case "bot.interrupted":
            const interruptedMsgs = call.messages.filter(m => m.type !== "bot-speaking");
            return { ...prev, [id]: { ...call, interrupted: true, botText: "", messages: [...interruptedMsgs, { type: "bot-interrupted", text: call.botText, playedMs: data.playedMs, ts: Date.now() }] } };
          case "turn.end":
            return { ...prev, [id]: { ...call, messages: [...call.messages, { type: "turn", probability: data.probability, ts: Date.now() }] } };
          default:
            return prev;
        }
      });
    };

    return () => es.close();
  }, []);

  return { calls, events };
}

// ── CallCard ────────────────────────────────────────────────────────────

function CallCard({ call, selected, onSelect }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (call.status !== "active") return;
    const t = setInterval(() => setElapsed(Date.now() - call.startedAt), 1000);
    return () => clearInterval(t);
  }, [call.status, call.startedAt]);

  const isActive = call.status === "active";
  const dur = isActive ? formatDuration(elapsed) : call.duration ? `${Math.round(call.duration)}s` : "—";
  const border = selected ? "border-accent-400 bg-accent-50/50" : isActive ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50";

  return React.createElement("button", {
    onClick: () => onSelect(call.id),
    className: `w-full text-left p-3 rounded-xl border ${border} transition-all hover:border-accent-300 hover:shadow-sm ${isActive ? "call-active" : ""} slide-up`,
  },
    React.createElement("div", { className: "flex items-center justify-between" },
      React.createElement("div", { className: "flex items-center gap-2" },
        React.createElement("span", { className: `${isActive ? "text-accent-500" : "text-slate-400"}` },
          call.direction === "outbound" ? React.createElement(PhoneOutIcon) : React.createElement(PhoneInIcon)
        ),
        React.createElement("div", null,
          React.createElement("div", { className: "text-sm font-medium text-slate-800" }, call.direction === "inbound" ? call.from : call.to),
          React.createElement("div", { className: "text-xs text-slate-400" },
            call.direction === "inbound" ? "Incoming" : "Outbound",
            " · ", dur
          ),
        ),
      ),
      React.createElement("span", {
        className: `text-xs font-medium px-2 py-0.5 rounded-full ${isActive ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"}`
      }, isActive ? "Live" : "Ended"),
    ),
  );
}

// ── Dialer ───────────────────────────────────────────────────────────────

function Dialer() {
  const [to, setTo] = useState("");
  const [greeting, setGreeting] = useState("");
  const [calling, setCalling] = useState(false);

  async function dial() {
    if (!to.trim()) return;
    setCalling(true);
    try {
      await fetch("/api/dial", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: to.trim(), greeting: greeting.trim() || undefined }),
      });
      setTo("");
      setGreeting("");
    } catch (err) {
      console.error("Dial failed:", err);
    }
    setCalling(false);
  }

  return React.createElement("div", { className: "bg-white rounded-xl border border-slate-200 p-4 space-y-3" },
    React.createElement("h3", { className: "text-sm font-semibold text-slate-700 flex items-center gap-2" },
      React.createElement(PhoneOutIcon), " Outbound Call"
    ),
    React.createElement("input", {
      type: "tel",
      value: to,
      onChange: (e) => setTo(e.target.value),
      placeholder: "+1 555 123 4567",
      className: "w-full px-3 py-2 text-sm rounded-lg border border-slate-200 focus:outline-none focus:border-accent-400 focus:ring-2 focus:ring-accent-100 transition-all",
    }),
    React.createElement("textarea", {
      value: greeting,
      onChange: (e) => setGreeting(e.target.value),
      placeholder: "Greeting message (optional)...",
      rows: 2,
      className: "w-full px-3 py-2 text-sm rounded-lg border border-slate-200 focus:outline-none focus:border-accent-400 focus:ring-2 focus:ring-accent-100 transition-all resize-none",
    }),
    React.createElement("button", {
      onClick: dial,
      disabled: calling || !to.trim(),
      className: `w-full py-2 px-4 rounded-lg text-sm font-medium text-white transition-all ${calling || !to.trim() ? "bg-slate-300 cursor-not-allowed" : "bg-accent-500 hover:bg-accent-600 active:bg-accent-700 shadow-sm hover:shadow"}`,
    }, calling ? "Calling..." : "Call"),
  );
}

// ── Transcript ──────────────────────────────────────────────────────────

function Transcript({ call }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [call?.messages?.length, call?.botText]);

  if (!call) {
    return React.createElement("div", { className: "flex-1 flex items-center justify-center text-slate-400 text-sm" },
      "Select a call to view the live transcript"
    );
  }

  return React.createElement("div", { className: "flex-1 flex flex-col" },
    // Header
    React.createElement("div", { className: "flex items-center justify-between px-5 py-3 border-b border-slate-100" },
      React.createElement("div", null,
        React.createElement("div", { className: "text-sm font-semibold text-slate-800" },
          call.direction === "inbound" ? call.from : call.to
        ),
        React.createElement("div", { className: "text-xs text-slate-400" },
          call.direction === "inbound" ? "Incoming call" : "Outbound call",
          call.status === "ended" && call.duration ? ` · ${Math.round(call.duration)}s` : ""
        ),
      ),
      call.status === "active" && React.createElement("button", {
        onClick: async () => { await fetch(`/api/hangup/${call.id}`, { method: "POST" }); },
        className: "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-all",
      }, React.createElement(PhoneOffIcon), " Hang up"),
    ),
    // Messages
    React.createElement("div", { className: "flex-1 overflow-y-auto px-5 py-4 space-y-3" },
      call.messages.map((msg, i) => {
        if (msg.type === "turn") {
          const prob = msg.probability ? `${(msg.probability * 100).toFixed(0)}%` : "";
          return React.createElement("div", { key: i, className: "flex justify-center" },
            React.createElement("span", { className: "text-[10px] text-slate-400 bg-slate-50 px-2.5 py-0.5 rounded-full border border-slate-100" },
              `turn ended${prob ? ` · ${prob}` : ""}`
            ),
          );
        }

        if (msg.type === "bot-interrupted") {
          return React.createElement("div", { key: i, className: "space-y-1" },
            React.createElement("div", { className: "flex justify-end" },
              React.createElement("div", { className: "bubble-bot max-w-[75%] px-3.5 py-2.5 text-sm text-slate-600 line-through opacity-60" }, msg.text || "..."),
            ),
            React.createElement("div", { className: "flex justify-center" },
              React.createElement("span", { className: "text-[10px] text-amber-600 bg-amber-50 px-2.5 py-0.5 rounded-full border border-amber-200" },
                `⚡ interrupted after ${msg.playedMs}ms`
              ),
            ),
          );
        }

        if (msg.type === "bot-speaking") {
          // Active bot bubble — show word-by-word preview
          const text = call.botText || msg.text || "...";
          return React.createElement("div", { key: i, className: "flex justify-end" },
            React.createElement("div", { className: "bubble-bot speaking max-w-[75%] px-3.5 py-2.5 text-sm text-slate-700" },
              text,
              !call.botText && React.createElement("span", { className: "inline-flex gap-0.5 ml-1.5" },
                React.createElement("span", { className: "dot-1 inline-block w-1 h-1 bg-accent-400 rounded-full" }),
                React.createElement("span", { className: "dot-2 inline-block w-1 h-1 bg-accent-400 rounded-full" }),
                React.createElement("span", { className: "dot-3 inline-block w-1 h-1 bg-accent-400 rounded-full" }),
              ),
            ),
          );
        }

        const isUser = msg.type === "user" || msg.type === "user-interim";
        const isInterim = msg.type === "user-interim";

        return React.createElement("div", { key: i, className: `flex ${isUser ? "justify-start" : "justify-end"}` },
          React.createElement("div", {
            className: `${isUser ? "bubble-user" : "bubble-bot"} max-w-[75%] px-3.5 py-2.5 text-sm ${isUser ? "text-slate-700" : "text-slate-700"} ${isInterim ? "opacity-50 italic" : ""}`,
          }, msg.text),
        );
      }),
      React.createElement("div", { ref: bottomRef }),
    ),
  );
}

// ── EventLog ────────────────────────────────────────────────────────────

function EventLog({ events }) {
  const bottomRef = useRef(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length, open]);

  return React.createElement("div", { className: "border-t border-slate-100" },
    React.createElement("button", {
      onClick: () => setOpen(!open),
      className: "w-full px-5 py-2 text-xs font-medium text-slate-400 hover:text-slate-600 flex items-center gap-1.5 transition-colors",
    }, open ? "▾" : "▸", ` Event log (${events.length})`),
    open && React.createElement("div", { className: "h-40 overflow-y-auto px-5 pb-2 font-mono text-[11px] text-slate-400 space-y-0.5" },
      events.map((evt, i) =>
        React.createElement("div", { key: i },
          React.createElement("span", { className: "text-slate-300" }, formatTime(evt._ts)),
          " ",
          React.createElement("span", { className: evt.event.startsWith("bot.") ? "text-accent-500" : evt.event.startsWith("user.") ? "text-green-500" : "text-slate-400" }, evt.event),
          evt.text ? ` "${evt.text.slice(0, 50)}"` : "",
        ),
      ),
      React.createElement("div", { ref: bottomRef }),
    ),
  );
}

// ── App ─────────────────────────────────────────────────────────────────

function App() {
  const { calls, events } = useSSE();
  const [selectedId, setSelectedId] = useState(null);
  const [info, setInfo] = useState(null);

  useEffect(() => {
    fetch("/api/info").then(r => r.json()).then(setInfo).catch(() => {});
  }, []);

  // Auto-select latest active call
  useEffect(() => {
    const active = Object.values(calls).filter(c => c.status === "active");
    if (active.length > 0 && !selectedId) {
      setSelectedId(active[active.length - 1].id);
    }
    // If a new call starts, auto-select it
    const latest = active[active.length - 1];
    if (latest && latest.id !== selectedId && latest.startedAt > Date.now() - 2000) {
      setSelectedId(latest.id);
    }
  }, [calls]);

  const callList = Object.values(calls).sort((a, b) => b.startedAt - a.startedAt);
  const selectedCall = selectedId ? calls[selectedId] : null;
  const activeCount = callList.filter(c => c.status === "active").length;

  return React.createElement("div", { className: "h-screen flex flex-col" },
    // Top bar
    React.createElement("header", { className: "flex items-center justify-between px-6 py-3 border-b border-slate-100 bg-white" },
      React.createElement("div", { className: "flex items-center gap-3" },
        React.createElement("div", { className: "w-8 h-8 rounded-lg bg-accent-500 flex items-center justify-center text-white text-sm font-bold" }, "P"),
        React.createElement("div", null,
          React.createElement("h1", { className: "text-sm font-semibold text-slate-800" }, `${info?.agent || "Agent"} — SSE Dashboard`),
          React.createElement("div", { className: "text-xs text-slate-400" }, info ? `${info.phone} · ${info.stt} · ${info.voice}` : "Connecting..."),
        ),
      ),
      React.createElement("div", { className: "flex items-center gap-2" },
        activeCount > 0 && React.createElement("span", { className: "flex items-center gap-1.5 text-xs font-medium text-green-600 bg-green-50 px-2.5 py-1 rounded-full border border-green-200" },
          React.createElement("span", { className: "w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" }),
          `${activeCount} active`
        ),
        React.createElement("span", { className: "text-xs text-slate-400" }, `${callList.length} total`),
      ),
    ),
    // Body
    React.createElement("div", { className: "flex-1 flex overflow-hidden" },
      // Sidebar
      React.createElement("div", { className: "w-80 border-r border-slate-100 flex flex-col bg-slate-25" },
        // Call list
        React.createElement("div", { className: "flex-1 overflow-y-auto p-3 space-y-2" },
          callList.length === 0
            ? React.createElement("div", { className: "text-center text-sm text-slate-400 py-12" },
                React.createElement("div", { className: "text-3xl mb-2" }, "📞"),
                "Waiting for calls...",
                React.createElement("div", { className: "text-xs mt-1 text-slate-300" }, "Make a call to the registered number or use the dialer below"),
              )
            : callList.map((call) =>
                React.createElement(CallCard, {
                  key: call.id,
                  call,
                  selected: selectedId === call.id,
                  onSelect: setSelectedId,
                })
              ),
        ),
        // Dialer
        React.createElement("div", { className: "p-3 border-t border-slate-100" },
          React.createElement(Dialer),
        ),
      ),
      // Main panel
      React.createElement("div", { className: "flex-1 flex flex-col bg-white" },
        React.createElement(Transcript, { call: selectedCall }),
        React.createElement(EventLog, { events }),
      ),
    ),
  );
}

// ── Mount ───────────────────────────────────────────────────────────────

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(React.createElement(App));

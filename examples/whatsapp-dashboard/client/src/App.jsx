import { useState, useEffect, useRef, useMemo } from "react";
import { useAgentCalls, useCall } from "@pinecall/web/log/react";

/**
 * WhatsApp Dashboard — Human Takeover UI
 *
 * The conversations and their messages come from the Call Log, read straight
 * from Pinecall over SSE with a read-only `observe` token this app's server
 * mints at /api/token. Nothing is streamed through the Node process:
 *
 *   useAgentCalls(agent, { token })  → one row per conversation (the agent log)
 *   useCall({ call, token })         → that conversation's messages
 *
 * Only the three takeover verbs go back to the server (pause / send / resume),
 * because those change the agent, they do not observe it.
 */

// ── The observe token ─────────────────────────────────────────────────────

function useObserveToken() {
  const [auth, setAuth] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/token")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((a) => alive && setAuth(a))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  return { auth, error };
}

// ── Saved conversations (the ones that already ended) ─────────────────────

function useHistory() {
  const [records, setRecords] = useState([]);
  useEffect(() => {
    fetch("/api/history")
      .then((r) => r.json())
      .then(setRecords)
      .catch(() => {
        /* no history available */
      });
  }, []);
  return records;
}

// ── API helpers ───────────────────────────────────────────────────────────

async function pause(sessionId) {
  await fetch(`/api/pause/${sessionId}`, { method: "POST" });
}

async function resume(sessionId) {
  await fetch(`/api/resume/${sessionId}`, { method: "POST" });
}

async function send(sessionId, text) {
  await fetch(`/api/send/${sessionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

// ── App ───────────────────────────────────────────────────────────────────

export default function App() {
  const { auth, error } = useObserveToken();

  if (error) {
    return (
      <div className="app">
        <div className="chat">
          <div className="empty" style={{ margin: "auto" }}>
            Could not mint an observe token: {error}
          </div>
        </div>
      </div>
    );
  }
  if (!auth) {
    return (
      <div className="app">
        <div className="chat">
          <div className="empty" style={{ margin: "auto" }}>
            Connecting…
          </div>
        </div>
      </div>
    );
  }
  return <Dashboard auth={auth} />;
}

function Dashboard({ auth }) {
  const { token, server, agent } = auth;
  // The agent log is lifecycle-only: it says which conversations exist and
  // which are live, never what was said. That is per-call, below.
  const { calls } = useAgentCalls(agent, { token, server });
  const history = useHistory();
  const [activeId, setActiveId] = useState(null);
  const [pausedIds, setPausedIds] = useState(() => new Set());

  useEffect(() => {
    fetch("/api/state")
      .then((r) => r.json())
      .then((s) => setPausedIds(new Set(s.paused || [])))
      .catch(() => {});
  }, []);

  // One row per conversation: live ones from the log, older ones from the
  // saved history, the log winning where both know a conversation.
  const sessions = useMemo(() => {
    const byId = new Map();
    for (const rec of history) {
      byId.set(rec.callId, {
        id: rec.callId,
        name: rec.metadata?.contactName || "",
        phone: rec.from || "",
        status: rec.status === "active" ? "active" : "ended",
        transcript: (rec.transcript || []).map((m) => ({
          role: m.role === "assistant" ? (m.source === "human" ? "human" : "bot") : "user",
          text: m.content,
        })),
      });
    }
    for (const c of calls) {
      const prev = byId.get(c.call) || { id: c.call, name: "", transcript: [] };
      byId.set(c.call, {
        ...prev,
        phone: c.from || prev.phone || "",
        status: c.live ? "active" : "ended",
      });
    }
    return [...byId.values()];
  }, [calls, history]);

  const active = activeId ? sessions.find((s) => s.id === activeId) : null;

  useEffect(() => {
    if (!activeId && sessions.length > 0) setActiveId(sessions[0].id);
  }, [sessions, activeId]);

  const setPaused = (id, on) =>
    setPausedIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        pausedIds={pausedIds}
        activeId={activeId}
        onSelect={setActiveId}
      />
      {active ? (
        <Chat
          key={active.id}
          session={active}
          token={token}
          server={server}
          paused={pausedIds.has(active.id)}
          onPaused={setPaused}
        />
      ) : (
        <div className="chat">
          <div className="empty" style={{ margin: "auto" }}>
            Waiting for WhatsApp messages…
            <br />
            Send a message to your WhatsApp Business number to start.
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────

function Sidebar({ sessions, pausedIds, activeId, onSelect }) {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="dot" />
        <h1>WhatsApp Dashboard</h1>
      </div>
      <div className="session-list">
        {sessions.length === 0 && <div className="empty">No active sessions</div>}
        {sessions.map((s) => {
          const last = s.transcript[s.transcript.length - 1];
          const isEnded = s.status === "ended";
          const isPaused = pausedIds.has(s.id);
          return (
            <div
              key={s.id}
              className={`session-item ${s.id === activeId ? "active" : ""} ${isEnded ? "ended" : ""}`}
              onClick={() => onSelect(s.id)}
            >
              <div className="name">
                {s.name || s.phone || s.id}
                {isEnded && <span className="badge ended">Ended</span>}
                {!isEnded && isPaused && <span className="badge paused">Paused</span>}
                {!isEnded && !isPaused && <span className="badge active">AI</span>}
              </div>
              {last && <div className="preview">{last.text}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Chat ──────────────────────────────────────────────────────────────────

function Chat({ session, token, server, paused, onPaused }) {
  const [text, setText] = useState("");
  const messagesRef = useRef(null);

  // One conversation's log. `reconnectOnMount` is on by default, so a page
  // reload picks the cursor back up instead of replaying the whole thing.
  const log = useCall({ call: session.id, token, server });

  // Live entries when the log has any; the saved transcript otherwise (an old
  // conversation whose log has aged out).
  const messages = log.messages.length
    ? log.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role === "user" ? "user" : "bot", text: m.text }))
    : session.transcript;

  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const handleSend = async () => {
    if (!text.trim()) return;
    await send(session.id, text.trim());
    setText("");
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat">
      <div className="chat-header">
        <div className="info">
          <h2>{session.name || session.phone || session.id}</h2>
          <span>{session.phone}</span>
        </div>
        <div className="actions">
          {paused ? (
            <button
              className="btn resume"
              onClick={async () => {
                await resume(session.id);
                onPaused(session.id, false);
              }}
            >
              ▶ Resume AI
            </button>
          ) : (
            <button
              className="btn pause"
              onClick={async () => {
                await pause(session.id);
                onPaused(session.id, true);
              }}
            >
              ⏸ Pause AI
            </button>
          )}
        </div>
      </div>

      <div className="messages" ref={messagesRef}>
        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role}`}>
            <div className="sender">
              {msg.role === "user"
                ? session.name || "Customer"
                : msg.role === "human"
                  ? "You (Human)"
                  : "AI Agent"}
            </div>
            {msg.text}
          </div>
        ))}
      </div>

      <div className="input-bar">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKey}
          placeholder={
            paused ? "Type a message as human operator…" : "Pause AI first to send messages"
          }
          disabled={!paused}
        />
        <button onClick={handleSend} disabled={!paused || !text.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}

import { useState, useEffect, useRef, useCallback } from "react";

/**
 * WhatsApp Dashboard — Human Takeover UI
 *
 * Connects to the backend via SSE to receive live WhatsApp events.
 * Operators can pause the AI, send messages manually, and resume.
 */

// ── SSE Hook ──────────────────────────────────────────────────────────────

function useSSE(url) {
  const [sessions, setSessions] = useState({});

  const upsertSession = useCallback((id, updater) => {
    setSessions((prev) => {
      const existing = prev[id] || { id, name: "", phone: "", messages: [], paused: false, status: "active" };
      return { ...prev, [id]: updater(existing) };
    });
  }, []);

  // Load saved conversations on mount
  useEffect(() => {
    fetch("/api/history")
      .then((r) => r.json())
      .then((records) => {
        const loaded = {};
        for (const rec of records) {
          loaded[rec.callId] = {
            id: rec.callId,
            name: rec.metadata?.contactName || "",
            phone: rec.from || "",
            status: rec.status || "ended",
            paused: false,
            messages: (rec.transcript || []).map((m) => ({
              role: m.role === "assistant" ? (m.source === "human" ? "human" : "bot") : "user",
              text: m.content,
              time: rec.startedAt * 1000,
            })),
          };
        }
        setSessions((prev) => ({ ...loaded, ...prev }));
      })
      .catch(() => { /* no history available */ });
  }, []);

  useEffect(() => {
    const es = new EventSource(url);

    es.addEventListener("whatsapp.session_started", (e) => {
      const d = JSON.parse(e.data);
      upsertSession(d.sessionId, (s) => ({
        ...s,
        name: d.contactName || s.name,
        phone: d.contactPhone || s.phone,
        status: "active",
      }));
    });

    es.addEventListener("whatsapp.message", (e) => {
      const d = JSON.parse(e.data);
      upsertSession(d.sessionId, (s) => ({
        ...s,
        name: d.name || s.name,
        paused: d.paused ?? s.paused,
        status: "active",
        messages: [
          ...s.messages,
          { role: "user", text: d.text, time: Date.now() },
        ],
      }));
    });

    es.addEventListener("whatsapp.response", (e) => {
      const d = JSON.parse(e.data);
      const role = d.source === "human" ? "human" : "bot";
      upsertSession(d.sessionId, (s) => ({
        ...s,
        messages: [
          ...s.messages,
          { role, text: d.text, time: Date.now() },
        ],
      }));
    });

    es.addEventListener("session.paused", (e) => {
      const d = JSON.parse(e.data);
      if (d.sessionId) {
        upsertSession(d.sessionId, (s) => ({ ...s, paused: true }));
      }
    });

    es.addEventListener("session.resumed", (e) => {
      const d = JSON.parse(e.data);
      if (d.sessionId) {
        upsertSession(d.sessionId, (s) => ({ ...s, paused: false }));
      }
    });

    es.addEventListener("whatsapp.session_ended", (e) => {
      const d = JSON.parse(e.data);
      if (d.sessionId) {
        upsertSession(d.sessionId, (s) => ({ ...s, status: "ended", paused: false }));
      }
    });

    return () => es.close();
  }, [url, upsertSession]);

  return sessions;
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
  const sessions = useSSE("/api/events");
  const [activeId, setActiveId] = useState(null);

  const sessionList = Object.values(sessions);
  const active = activeId ? sessions[activeId] : null;

  // Auto-select first session
  useEffect(() => {
    if (!activeId && sessionList.length > 0) {
      setActiveId(sessionList[0].id);
    }
  }, [sessionList.length, activeId]);

  return (
    <div className="app">
      <Sidebar
        sessions={sessionList}
        activeId={activeId}
        onSelect={setActiveId}
      />
      {active ? (
        <Chat session={active} />
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

function Sidebar({ sessions, activeId, onSelect }) {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="dot" />
        <h1>WhatsApp Dashboard</h1>
      </div>
      <div className="session-list">
        {sessions.length === 0 && (
          <div className="empty">No active sessions</div>
        )}
        {sessions.map((s) => {
          const last = s.messages[s.messages.length - 1];
          const isEnded = s.status === "ended";
          return (
            <div
              key={s.id}
              className={`session-item ${s.id === activeId ? "active" : ""} ${isEnded ? "ended" : ""}`}
              onClick={() => onSelect(s.id)}
            >
              <div className="name">
                {s.name || s.phone || s.id}
                {isEnded && <span className="badge ended">Ended</span>}
                {!isEnded && s.paused && <span className="badge paused">Paused</span>}
                {!isEnded && !s.paused && s.messages.length > 0 && (
                  <span className="badge active">AI</span>
                )}
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

function Chat({ session }) {
  const [text, setText] = useState("");
  const messagesRef = useRef(null);

  // Auto-scroll on new messages
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.messages.length]);

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
          {session.paused ? (
            <button className="btn resume" onClick={() => resume(session.id)}>
              ▶ Resume AI
            </button>
          ) : (
            <button className="btn pause" onClick={() => pause(session.id)}>
              ⏸ Pause AI
            </button>
          )}
        </div>
      </div>

      <div className="messages" ref={messagesRef}>
        {session.messages.map((msg, i) => (
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
            session.paused
              ? "Type a message as human operator…"
              : "Pause AI first to send messages"
          }
          disabled={!session.paused}
        />
        <button onClick={handleSend} disabled={!session.paused || !text.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}

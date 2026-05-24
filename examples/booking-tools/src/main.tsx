import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { VoiceWidget, useVoice } from "@pinecall/voice-widget";
import type { ToolUI } from "@pinecall/voice-widget";

/* ═══════════════════════════════════════════════════════════════════
   SLOT PICKER — Shows available time slots as clickable buttons
   ═══════════════════════════════════════════════════════════════════ */

function SlotPicker({ tool }: { tool: ToolUI }) {
  const { sendText, dismissTool } = useVoice();
  const slots: string[] = tool.result?.slots ?? [];
  const date: string = tool.result?.date ?? "";
  const service: string = tool.result?.service ?? "appointment";

  if (!slots.length) {
    return (
      <div style={card}>
        <div style={{ ...title, color: "#f87171" }}>No availability for {date}</div>
      </div>
    );
  }

  return (
    <div style={card}>
      <div style={title}>📅 {service} — {date}</div>
      <div style={grid}>
        {slots.map((slot) => (
          <button
            key={slot}
            style={slotBtn}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(124,58,237,.3)";
              e.currentTarget.style.borderColor = "rgba(124,58,237,.5)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(18,16,22,.7)";
              e.currentTarget.style.borderColor = "rgba(255,255,255,.08)";
            }}
            onClick={() => {
              sendText(`I'd like to book the ${slot} slot`);
              dismissTool(tool.toolCallId);
            }}
          >
            {slot}
          </button>
        ))}
      </div>
      <div style={hint}>Click a slot or say the time</div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   CONTACT FORM — Agent can auto-fill fields, user can type freely.
   Form state is synced to the LLM prompt via setContext().
   ═══════════════════════════════════════════════════════════════════ */

interface FormData {
  name: string;
  email: string;
  phone: string;
}

function ContactForm({ tool }: { tool: ToolUI }) {
  const { sendText, dismissTool, setContext, toolCalls } = useVoice();
  const [form, setForm] = useState<FormData>({
    name: tool.result?.prefill?.name ?? "",
    email: tool.result?.prefill?.email ?? "",
    phone: tool.result?.prefill?.phone ?? "",
  });
  const [submitted, setSubmitted] = useState(false);

  // Watch for fillField tool calls — agent can auto-fill fields
  const fillTool = toolCalls.find(
    (tc) => tc.name === "fillField" && tc.result !== undefined,
  );
  useEffect(() => {
    if (fillTool?.result) {
      const { field, value } = fillTool.result as { field: string; value: string };
      if (field && value && field in form) {
        setForm((prev) => ({ ...prev, [field]: value }));
        dismissTool(fillTool.toolCallId);
      }
    }
  }, [fillTool]);

  // Watch for submitForm tool call — agent can submit the form verbally
  const submitTool = toolCalls.find(
    (tc) => tc.name === "submitForm" && tc.result !== undefined,
  );
  useEffect(() => {
    if (submitTool && !submitted) {
      dismissTool(submitTool.toolCallId);
      handleSubmit();
    }
  }, [submitTool]);

  // Sync form state → LLM prompt on every change
  useEffect(() => {
    const filled = Object.entries(form)
      .map(([k, v]) => `${k}: ${v || "(empty)"}`)
      .join("\n");
    setContext(
      "contact_form",
      `The user is filling a contact form on screen. Current values:\n${filled}`,
    );
  }, [form, setContext]);

  // Clear context on unmount
  useEffect(() => {
    return () => setContext("contact_form", null);
  }, [setContext]);

  const updateField = (field: keyof FormData, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = () => {
    setSubmitted(true);
    const summary = `Form submitted: name=${form.name}, email=${form.email}, phone=${form.phone}`;
    sendText(summary);
    setContext("contact_form", null);
    setTimeout(() => dismissTool(tool.toolCallId), 2000);
  };

  const allFilled = form.name && form.email && form.phone;

  if (submitted) {
    return (
      <div style={card}>
        <div style={{ ...title, color: "#34d399" }}>✅ Details submitted</div>
        <div style={{ fontSize: 13, color: "#9ca3af", lineHeight: 1.5 }}>
          <div>👤 {form.name}</div>
          <div>✉️ {form.email}</div>
          <div>📞 {form.phone}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={card}>
      <div style={title}>📋 Contact Details</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <FormField label="Name" value={form.name} placeholder="Your full name"
          onChange={(v) => updateField("name", v)} />
        <FormField label="Email" value={form.email} placeholder="you@example.com"
          onChange={(v) => updateField("email", v)} type="email" />
        <FormField label="Phone" value={form.phone} placeholder="+1 555 000 0000"
          onChange={(v) => updateField("phone", v)} type="tel" />
      </div>
      <button
        style={{
          ...submitBtn,
          opacity: allFilled ? 1 : 0.4,
          cursor: allFilled ? "pointer" : "not-allowed",
        }}
        disabled={!allFilled}
        onClick={handleSubmit}
      >
        Confirm Details
      </button>
      <div style={hint}>Fill in or let the agent auto-fill for you</div>
    </div>
  );
}

function FormField({ label, value, placeholder, onChange, type = "text" }: {
  label: string; value: string; placeholder: string;
  onChange: (v: string) => void; type?: string;
}) {
  return (
    <div>
      <label style={fieldLabel}>{label}</label>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={fieldInput}
        onFocus={(e) => { e.currentTarget.style.borderColor = "rgba(124,58,237,.5)"; }}
        onBlur={(e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,.1)"; }}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   CONFIRM CARD — Shows booking confirmation
   ═══════════════════════════════════════════════════════════════════ */

function ConfirmCard({ tool }: { tool: ToolUI }) {
  const { confirmed, date, time, service, clientName, confirmationId } = tool.result ?? {};
  const ok = !!confirmed;

  return (
    <div style={{
      ...card,
      background: ok ? "rgba(52,211,153,.06)" : "rgba(248,113,113,.06)",
      borderColor: ok ? "rgba(52,211,153,.2)" : "rgba(248,113,113,.2)",
    }}>
      <div style={{ ...title, color: ok ? "#34d399" : "#f87171" }}>
        {ok ? "✅ Confirmed" : "❌ Failed"}
      </div>
      {ok && (
        <div style={{ fontSize: 13, color: "#d1d5db", lineHeight: 1.6 }}>
          <div>📅 {date} at {time}</div>
          <div>💇 {service}</div>
          <div>👤 {clientName}</div>
          {confirmationId && (
            <div style={{ marginTop: 4, fontSize: 11, color: "#666" }}>
              ID: {confirmationId}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   ANIMATED TOOL PANEL — Smooth crossfade between modal steps.
   Uses a transition state machine: idle → exit → enter → idle.
   ═══════════════════════════════════════════════════════════════════ */

type TransitionPhase = "idle" | "exit" | "enter";

function useAnimatedPanel(panelKey: string) {
  const [phase, setPhase] = useState<TransitionPhase>("enter");
  const [displayKey, setDisplayKey] = useState(panelKey);
  const prevKeyRef = React.useRef(panelKey);

  useEffect(() => {
    if (panelKey === prevKeyRef.current) return;
    // New content incoming — start exit animation
    setPhase("exit");
    const exitTimer = setTimeout(() => {
      setDisplayKey(panelKey);
      prevKeyRef.current = panelKey;
      setPhase("enter");
    }, 200); // match exit animation duration
    return () => clearTimeout(exitTimer);
  }, [panelKey]);

  // Reset to idle after enter animation completes
  useEffect(() => {
    if (phase === "enter") {
      const t = setTimeout(() => setPhase("idle"), 300);
      return () => clearTimeout(t);
    }
  }, [phase]);

  return { phase, displayKey };
}

function ToolPanel() {
  const { toolCalls } = useVoice();
  const slots = toolCalls.find((tc) => tc.name === "getAvailableSlots" && tc.result !== undefined);
  const contact = toolCalls.find((tc) => tc.name === "showContactForm" && tc.result !== undefined);
  const confirm = toolCalls.find((tc) => tc.name === "confirmBooking" && tc.result !== undefined);

  // Determine which panel to show (priority: confirm > contact > slots)
  let panelKey = "";
  if (confirm) panelKey = "confirm";
  else if (contact) panelKey = "contact";
  else if (slots) panelKey = "slots";

  const { phase, displayKey } = useAnimatedPanel(panelKey);

  // Show/hide state
  const [visible, setVisible] = useState(false);
  const [backdropOut, setBackdropOut] = useState(false);
  const prevVisible = React.useRef(false);

  useEffect(() => {
    if (panelKey && !prevVisible.current) {
      setVisible(true);
      setBackdropOut(false);
    } else if (!panelKey && prevVisible.current) {
      setBackdropOut(true);
      const t = setTimeout(() => { setVisible(false); setBackdropOut(false); }, 250);
      prevVisible.current = false;
      return () => clearTimeout(t);
    }
    prevVisible.current = !!panelKey;
  }, [panelKey]);

  if (!visible) return null;

  // Resolve content by displayKey (use displayKey to show the right thing during exit)
  let content: React.ReactNode = null;
  if (displayKey === "confirm" && confirm) content = <ConfirmCard tool={confirm} />;
  else if (displayKey === "contact" && contact) content = <ContactForm tool={contact} />;
  else if (displayKey === "slots" && slots) content = <SlotPicker tool={slots} />;
  // Fallback during transitions — show by panelKey
  if (!content) {
    if (panelKey === "confirm" && confirm) content = <ConfirmCard tool={confirm} />;
    else if (panelKey === "contact" && contact) content = <ContactForm tool={contact} />;
    else if (panelKey === "slots" && slots) content = <SlotPicker tool={slots} />;
  }
  if (!content) return null;

  // Animation classes
  const panelClass = phase === "exit"
    ? "tool-panel tool-panel--exit"
    : phase === "enter"
      ? "tool-panel tool-panel--enter"
      : "tool-panel";

  const backdropClass = backdropOut
    ? "tool-backdrop tool-backdrop--exit"
    : "tool-backdrop";

  return (
    <>
      <div className={backdropClass} />
      <div className={panelClass}>
        {content}
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   STYLES
   ═══════════════════════════════════════════════════════════════════ */

const card: React.CSSProperties = {
  padding: 16, borderRadius: 12,
  fontFamily: "Inter, -apple-system, sans-serif",
  background: "rgba(124,58,237,.06)",
  border: "1px solid rgba(124,58,237,.15)",
};
const title: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: "#a78bfa", marginBottom: 10,
  textTransform: "uppercase", letterSpacing: "0.04em",
};
const grid: React.CSSProperties = {
  display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6,
};
const slotBtn: React.CSSProperties = {
  padding: "10px 4px", borderRadius: 8,
  border: "1px solid rgba(255,255,255,.08)",
  background: "rgba(18,16,22,.7)", color: "#e8e4f0",
  fontSize: 13, fontWeight: 500, cursor: "pointer",
  transition: "all .15s", fontFamily: "inherit",
};
const hint: React.CSSProperties = {
  fontSize: 11, color: "rgba(255,255,255,.25)",
  textAlign: "center", marginTop: 10,
};
const fieldLabel: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: "#9ca3af",
  textTransform: "uppercase", letterSpacing: "0.04em",
  marginBottom: 4, display: "block",
};
const fieldInput: React.CSSProperties = {
  width: "100%", padding: "10px 12px", borderRadius: 8,
  border: "1px solid rgba(255,255,255,.1)",
  background: "rgba(18,16,22,.8)", color: "#e8e4f0",
  fontSize: 14, fontFamily: "inherit", outline: "none",
  transition: "border-color .15s",
};
const submitBtn: React.CSSProperties = {
  width: "100%", padding: "12px", borderRadius: 10, marginTop: 12,
  border: "none", fontFamily: "inherit",
  background: "linear-gradient(135deg, #7c3aed, #6d28d9)",
  color: "#fff", fontSize: 14, fontWeight: 600,
  transition: "opacity .15s",
};

/* ═══════════════════════════════════════════════════════════════════
   APP
   ═══════════════════════════════════════════════════════════════════ */

function App() {
  return (
    <div style={{
      minHeight: "100vh", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: 32,
      background: "linear-gradient(145deg, #08070c 0%, #120e1a 50%, #0d0b12 100%)",
      fontFamily: "Inter, -apple-system, sans-serif",
    }}>
      <div style={{ textAlign: "center" }}>
        <h1 style={{
          fontSize: 28, fontWeight: 700, color: "#e8e4f0",
          margin: "0 0 8px", letterSpacing: "-0.02em",
        }}>
          ✨ Glow Studio
        </h1>
        <p style={{
          fontSize: 14, color: "rgba(255,255,255,.4)", margin: 0,
          maxWidth: 380, lineHeight: 1.5,
        }}>
          Voice-powered booking with interactive tool UI, contact form
          auto-fill, and live prompt context injection.
        </p>
      </div>

      <div style={{
        display: "flex", gap: 20,
        fontSize: 12, color: "rgba(255,255,255,.25)",
      }}>
        <span>1️⃣ Click the orb</span>
        <span>2️⃣ Ask to book a haircut</span>
        <span>3️⃣ Fill the contact form</span>
      </div>

      <VoiceWidget
        agent="booking-demo"
        name="Glow Studio"
        label="Book an appointment"
        preset="dark"
        tokenProvider={async () => {
          const res = await fetch("/api/token");
          if (!res.ok) throw new Error(`Token failed: ${res.status}`);
          return res.json();
        }}
        trackedTools={["getAvailableSlots", "confirmBooking", "showContactForm", "fillField", "submitForm"]}
      >
        <ToolPanel />
      </VoiceWidget>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

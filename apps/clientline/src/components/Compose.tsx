import { useState } from "react";
import { api, type Contact } from "../lib/api.ts";
import { useApp } from "../App.tsx";
import { Banner, Field, Modal, useToast } from "./ui.tsx";

export function ComposeModal({
  contact,
  initial,
  onClose,
  onSent,
}: {
  contact: Contact;
  initial?: { channel?: "SMS" | "Email"; subject?: string; body?: string };
  onClose: () => void;
  onSent?: () => void;
}) {
  const { status } = useApp();
  const toast = useToast();
  const [channel, setChannel] = useState<"SMS" | "Email">(initial?.channel ?? (contact.phone ? "SMS" : "Email"));
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [busy, setBusy] = useState(false);
  const missing = channel === "SMS" ? !contact.phone : !contact.email;

  const send = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ delivered: boolean }>("/api/messages", { contactId: contact.id, channel, body, subject });
      toast(r.delivered ? `${channel === "SMS" ? "Text" : "Email"} sent via GoHighLevel` : "Saved to the demo conversation (nothing was sent)");
      onSent?.();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Send failed", "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Message ${contact.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="faint small" style={{ marginRight: "auto" }}>
            {channel === "SMS" ? `${body.length} chars · ${Math.max(1, Math.ceil(body.length / 160))} segment${body.length > 160 ? "s" : ""}` : ""}
          </span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !body.trim() || missing} onClick={send}>
            {busy ? "Sending…" : `Send ${channel === "SMS" ? "text" : "email"}`}
          </button>
        </>
      }
    >
      <div className="btn-group">
        <button className={`btn sm ${channel === "SMS" ? "on" : ""}`} onClick={() => setChannel("SMS")}>SMS</button>
        <button className={`btn sm ${channel === "Email" ? "on" : ""}`} onClick={() => setChannel("Email")}>Email</button>
      </div>
      <div className="small muted">To: {channel === "SMS" ? contact.phone || "no phone on file" : contact.email || "no email on file"}</div>
      {status?.crm.mode === "demo" && <Banner tone="warn">Demo workspace — the message is recorded locally, not sent. Connect GoHighLevel to send for real.</Banner>}
      {channel === "Email" && (
        <Field label="Subject">
          <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
      )}
      <Field label="Message">
        <textarea className="textarea" rows={channel === "SMS" ? 4 : 9} value={body} onChange={(e) => setBody(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

import { useState } from "react";
import { api, type Contact } from "../lib/api.ts";
import { useApp } from "../App.tsx";
import { Banner, Field, Modal, useToast } from "./ui.tsx";
import { CHANNEL_NAMES, ChannelIcon } from "./brand.tsx";

type Ch = "SMS" | "Email" | "IG" | "FB" | "WhatsApp";

export function ComposeModal({
  contact,
  initial,
  onClose,
  onSent,
}: {
  contact: Contact;
  initial?: { channel?: Ch; subject?: string; body?: string };
  onClose: () => void;
  onSent?: () => void;
}) {
  const { status } = useApp();
  const toast = useToast();
  const [channel, setChannel] = useState<Ch>(initial?.channel ?? (contact.phone ? "SMS" : "Email"));
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [busy, setBusy] = useState(false);
  const missing = channel === "SMS" || channel === "WhatsApp" ? !contact.phone : channel === "Email" ? !contact.email : false;

  const send = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ delivered: boolean }>("/api/messages", { contactId: contact.id, channel, body, subject });
      toast(r.delivered ? `${CHANNEL_NAMES[channel]} message sent via GoHighLevel` : "Saved to the demo conversation (nothing was sent)");
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
            {busy ? "Sending…" : `Send ${channel === "SMS" ? "text" : channel === "Email" ? "email" : "DM"}`}
          </button>
        </>
      }
    >
      <div className="btn-group">
        {(["SMS", "Email", "IG", "FB", "WhatsApp"] as const).map((ch) => (
          <button key={ch} className={`btn sm ${channel === ch ? "on" : ""}`} onClick={() => setChannel(ch)} style={{ display: "inline-flex", gap: 5 }}>
            <ChannelIcon channel={ch} /> {CHANNEL_NAMES[ch]}
          </button>
        ))}
      </div>
      <div className="small muted">
        To: {channel === "SMS" || channel === "WhatsApp" ? contact.phone || "no phone on file" : channel === "Email" ? contact.email || "no email on file" : `${contact.name} on ${CHANNEL_NAMES[channel]}`}
      </div>
      {(channel === "IG" || channel === "FB") && <div className="faint small">Meta only allows business messages within 24 hours of the person's last DM to you. Your Instagram / Facebook Page must be connected in GoHighLevel.</div>}
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

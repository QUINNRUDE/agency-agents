import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Mail, MessageSquare, Pause, Play, Plus, Send, ShieldCheck, Users, X } from "lucide-react";
import { api, type Contact, type Pipeline, type SavedView } from "../lib/api.ts";
import { relTime } from "../lib/format.ts";
import { useApp } from "../App.tsx";
import { Banner, Card, Empty, Field, LoadingRows, Modal, useAsync, useToast } from "../components/ui.tsx";
import { ConfirmModal, ContactPicker } from "../components/crm.tsx";
import { ChannelBadge } from "../components/brand.tsx";

type Channel = "SMS" | "Email";
type Audience =
  | { kind: "all" }
  | { kind: "tag"; tag: string }
  | { kind: "stage"; stageId: string }
  | { kind: "customers" }
  | { kind: "view"; viewId: string }
  | { kind: "contacts"; contactIds: string[] };

interface Counts {
  total: number;
  sent: number;
  skipped: number;
  failed: number;
  pending: number;
}
interface BroadcastRow {
  id: string;
  name: string;
  channel: Channel;
  message: string;
  audienceLabel: string;
  status: "scheduled" | "sending" | "paused" | "done" | "cancelled";
  scheduledAt: string;
  createdAt: string;
  finishedAt?: string;
  perMinute: number;
  excluded: Record<string, number>;
  counts: Counts;
}
interface Recipient {
  contactId: string;
  name: string;
  status: "pending" | "sent" | "demo" | "test_mode" | "skipped" | "failed";
  reason?: string;
  at?: string;
}
interface Preview {
  label: string;
  total: number;
  eligible: number;
  excluded: Record<string, number>;
  sample: string[];
  sampleText: string;
  sampleName: string;
}

const STATUS: Record<BroadcastRow["status"], { label: string; cls: string }> = {
  scheduled: { label: "Scheduled", cls: "accent" },
  sending: { label: "Sending", cls: "good" },
  paused: { label: "Paused", cls: "warn" },
  done: { label: "Sent", cls: "" },
  cancelled: { label: "Cancelled", cls: "bad" },
};
const R_STATUS: Record<Recipient["status"], { label: string; cls: string }> = {
  pending: { label: "Waiting", cls: "" },
  sent: { label: "Sent", cls: "good" },
  demo: { label: "Sent (demo)", cls: "accent" },
  test_mode: { label: "Test mode", cls: "warn" },
  skipped: { label: "Skipped", cls: "" },
  failed: { label: "Failed", cls: "bad" },
};
const MERGE = ["first_name", "company", "city", "my_name", "agency", "booking_link"];

export function Broadcasts() {
  const loc = useLocation();
  const nav = useNavigate();
  const toast = useToast();
  const list = useAsync(() => api.get<BroadcastRow[]>("/api/broadcasts"));
  const [composing, setComposing] = useState<Audience | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<BroadcastRow | null>(null);

  // Opened from Clients → bulk "Broadcast" with selected contacts.
  useEffect(() => {
    const ids = (loc.state as { contactIds?: string[] } | null)?.contactIds;
    if (ids?.length) {
      setComposing({ kind: "contacts", contactIds: ids });
      nav(loc.pathname, { replace: true, state: null });
    }
  }, [loc.state, loc.pathname, nav]);

  // Live progress while anything is sending.
  useEffect(() => {
    if (!list.data?.some((b) => b.status === "sending" || b.status === "scheduled")) return;
    const t = setInterval(() => void list.reload(), 4000);
    return () => clearInterval(t);
  }, [list.data, list.reload]);

  const act = async (b: BroadcastRow, action: "pause" | "resume") => {
    try {
      await api.post(`/api/broadcasts/${b.id}/${action}`);
      toast(action === "pause" ? "Broadcast paused" : "Broadcast resumed");
      void list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Update failed", "bad");
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Broadcasts</h2>
          <p>Send one text or email to a group of contacts who agreed to hear from you: promos, openings, reminders, announcements.</p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => setComposing({ kind: "customers" })}><Plus /> New broadcast</button>
        </div>
      </div>

      <Banner tone="info">
        <span className="row" style={{ gap: 6, alignItems: "flex-start" }}>
          <ShieldCheck size={16} style={{ flex: "none", marginTop: 2 }} />
          <span>
            Broadcasts automatically leave out cold prospects (from Find clients or cold lists), anyone who opted out or is on do-not-disturb, and contacts without a phone or email. Texts get “Reply STOP to opt out”, go out gradually, and wait for your sending hours (set under Automations → Safety & settings).
          </span>
        </span>
      </Banner>

      <Card flush>
        {list.loading && !list.data ? (
          <LoadingRows n={4} />
        ) : list.data?.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Broadcast</th><th>Audience</th><th>Status</th><th style={{ width: 220 }}>Progress</th><th>When</th><th /></tr>
              </thead>
              <tbody>
                {list.data.map((b) => {
                  const done = b.counts.sent + b.counts.skipped + b.counts.failed;
                  return (
                    <tr key={b.id} className="clickable" onClick={() => setOpen(b.id)}>
                      <td>
                        <div className="row" style={{ gap: 8 }}>
                          <ChannelBadge channel={b.channel} />
                          <span style={{ fontWeight: 600 }}>{b.name}</span>
                        </div>
                        <div className="faint small ellipsis" style={{ maxWidth: 360 }}>{b.message}</div>
                      </td>
                      <td className="small">{b.audienceLabel}</td>
                      <td><span className={`badge ${STATUS[b.status].cls}`}>{STATUS[b.status].label}</span></td>
                      <td>
                        <div style={{ height: 8, background: "var(--surface-sunk)", borderRadius: 99, overflow: "hidden" }}>
                          <div style={{ width: `${b.counts.total ? (done / b.counts.total) * 100 : 0}%`, height: "100%", background: "var(--grad)" }} />
                        </div>
                        <div className="faint small" style={{ marginTop: 4 }}>
                          {b.counts.sent} sent{b.counts.skipped ? ` · ${b.counts.skipped} skipped` : ""}{b.counts.failed ? ` · ${b.counts.failed} failed` : ""} of {b.counts.total}
                        </div>
                      </td>
                      <td className="small muted" style={{ whiteSpace: "nowrap" }}>
                        {b.status === "scheduled" ? `Sends ${relTime(b.scheduledAt)}` : b.finishedAt ? `Finished ${relTime(b.finishedAt)}` : `Started ${relTime(b.scheduledAt)}`}
                      </td>
                      <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
                        {(b.status === "sending" || b.status === "scheduled") && <button className="btn sm ghost" onClick={() => act(b, "pause")}><Pause /> Pause</button>}
                        {b.status === "paused" && <button className="btn sm ghost" onClick={() => act(b, "resume")}><Play /> Resume</button>}
                        {(b.status === "sending" || b.status === "scheduled" || b.status === "paused") && (
                          <button className="btn sm ghost icon" aria-label="Cancel broadcast" onClick={() => setCancelling(b)}><X /></button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={<Send />} title="No broadcasts yet">
            Send a quick update to your customers, or a promo to everyone who opted in. <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setComposing({ kind: "customers" })}><Plus /> New broadcast</button>
          </Empty>
        )}
      </Card>

      {composing && <Composer initialAudience={composing} onClose={() => setComposing(null)} onCreated={() => void list.reload()} />}
      {open && <Detail id={open} onClose={() => setOpen(null)} />}
      {cancelling && (
        <ConfirmModal
          title={`Cancel “${cancelling.name}”?`}
          confirmLabel="Cancel broadcast"
          onClose={() => setCancelling(null)}
          onConfirm={async () => {
            await api.post(`/api/broadcasts/${cancelling.id}/cancel`);
            toast("Broadcast cancelled");
            void list.reload();
          }}
        >
          Nobody who hasn't received it yet will get it. Messages already sent can't be recalled.
        </ConfirmModal>
      )}
    </div>
  );
}

function Composer({ initialAudience, onClose, onCreated }: { initialAudience: Audience; onClose: () => void; onCreated: () => void }) {
  const { status } = useApp();
  const toast = useToast();
  const pipelines = useAsync(() => api.get<Pipeline[]>("/api/pipelines"));
  const views = useAsync(() => api.get<SavedView[]>("/api/views"));
  const contacts = useAsync(() => api.get<Contact[]>("/api/contacts?limit=2000"));
  const tags = useMemo(() => [...new Set((contacts.data ?? []).flatMap((c) => c.tags))].sort(), [contacts.data]);

  const [name, setName] = useState("");
  const [channel, setChannel] = useState<Channel>("SMS");
  const [audience, setAudience] = useState<Audience>(initialAudience);
  const [message, setMessage] = useState("Hi {{first_name}}, ");
  const [subject, setSubject] = useState("");
  const [optOut, setOptOut] = useState(true);
  const [when, setWhen] = useState<"now" | "later">("now");
  const [at, setAt] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 11) + "10:00");
  const [perMinute, setPerMinute] = useState(30);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [testTo, setTestTo] = useState<Contact | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      api.post<Preview>("/api/broadcasts/preview", { audience, channel, message, optOutLine: optOut }).then(setPreview, () => setPreview(null));
    }, 350);
    return () => clearTimeout(t);
  }, [audience, channel, message, optOut]);

  const smsLength = preview?.sampleText.length ?? message.length;
  const segments = Math.max(1, Math.ceil(smsLength / 160));

  const kind = audience.kind;
  const setKind = (k: Audience["kind"]) => {
    if (k === "tag") setAudience({ kind: "tag", tag: tags[0] ?? "" });
    else if (k === "stage") setAudience({ kind: "stage", stageId: pipelines.data?.[0]?.stages[0]?.id ?? "" });
    else if (k === "view") setAudience({ kind: "view", viewId: views.data?.[0]?.id ?? "" });
    else if (k === "contacts") setAudience({ kind: "contacts", contactIds: initialAudience.kind === "contacts" ? initialAudience.contactIds : [] });
    else setAudience({ kind: k } as Audience);
  };

  const sendTest = async () => {
    if (!testTo) return;
    try {
      const r = await api.post<{ delivered: boolean }>("/api/broadcasts/test", { channel, message, subject, optOutLine: optOut, contactId: testTo.id });
      toast(r.delivered ? `Test sent to ${testTo.name}` : "Test recorded in the demo workspace (not delivered)");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Test failed", "bad");
    }
  };

  const create = async () => {
    setBusy(true);
    try {
      await api.post("/api/broadcasts", {
        name,
        channel,
        message,
        subject,
        audience,
        optOutLine: optOut,
        perMinute,
        scheduledAt: when === "later" ? new Date(at).toISOString() : undefined,
      });
      toast(when === "later" ? "Broadcast scheduled" : "Broadcast is sending");
      onCreated();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not create broadcast", "bad");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const excludedTotal = preview ? Object.values(preview.excluded).reduce((a, b) => a + b, 0) : 0;

  return (
    <Modal
      wide
      title="New broadcast"
      onClose={onClose}
      footer={
        <>
          <span className="faint small" style={{ marginRight: "auto" }}>{status?.crm.mode === "demo" ? "Demo workspace: messages are recorded, not delivered." : ""}</span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!preview?.eligible || !message.trim() || (channel === "Email" && !subject.trim())} onClick={() => setConfirming(true)}>
            <Send /> Review & {when === "later" ? "schedule" : "send"}
          </button>
        </>
      }
    >
      <div className="grid-2" style={{ alignItems: "start", gap: 18 }}>
        <div className="stack">
          <Field label="Name (only you see this)"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. December openings" /></Field>
          <div className="btn-group">
            <button className={`btn ${channel === "SMS" ? "on" : ""}`} onClick={() => setChannel("SMS")}><MessageSquare /> Text (SMS)</button>
            <button className={`btn ${channel === "Email" ? "on" : ""}`} onClick={() => setChannel("Email")}><Mail /> Email</button>
          </div>
          <Field label="Send to" group>
            <select className="select" value={kind} onChange={(e) => setKind(e.target.value as Audience["kind"])}>
              <option value="customers">Customers (won a deal)</option>
              <option value="all">Everyone who can receive it</option>
              <option value="tag">Contacts with a tag</option>
              <option value="stage">Contacts in a pipeline stage</option>
              <option value="view">A saved view from Clients</option>
              {initialAudience.kind === "contacts" && <option value="contacts">The contacts I selected</option>}
            </select>
            {audience.kind === "tag" && (
              <select className="select" value={audience.tag} onChange={(e) => setAudience({ kind: "tag", tag: e.target.value })}>
                {tags.map((t) => <option key={t}>{t}</option>)}
              </select>
            )}
            {audience.kind === "stage" && (
              <select className="select" value={audience.stageId} onChange={(e) => setAudience({ kind: "stage", stageId: e.target.value })}>
                {pipelines.data?.map((p) => (
                  <optgroup key={p.id} label={p.name}>{p.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>
                ))}
              </select>
            )}
            {audience.kind === "view" && (
              views.data?.length ? (
                <select className="select" value={audience.viewId} onChange={(e) => setAudience({ kind: "view", viewId: e.target.value })}>
                  {views.data.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              ) : (
                <div className="faint small">No saved views yet. Save one from the Clients page filters.</div>
              )
            )}
          </Field>
          {channel === "Email" && <Field label="Subject"><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. We have openings next week" /></Field>}
          <Field label="Message" group>
            <div className="merge-chips">
              {MERGE.map((m) => <button key={m} type="button" onClick={() => setMessage((t) => `${t}{{${m}}}`)}>{`{{${m}}}`}</button>)}
            </div>
            <textarea className="textarea" rows={channel === "Email" ? 8 : 5} value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Message" />
            {channel === "SMS" && (
              <span className="faint small">
                {smsLength} characters · {segments} text{segments > 1 ? "s" : ""} per person{segments > 1 ? " (longer texts cost more)" : ""}
              </span>
            )}
          </Field>
          {channel === "SMS" && (
            <label className="row small">
              <input type="checkbox" checked={optOut} onChange={(e) => setOptOut(e.target.checked)} /> Add “Reply STOP to opt out.” (recommended; carriers expect it)
            </label>
          )}
          <div className="grid-2">
            <Field label="When" group>
              <div className="btn-group">
                <button className={`btn sm ${when === "now" ? "on" : ""}`} onClick={() => setWhen("now")}>Send now</button>
                <button className={`btn sm ${when === "later" ? "on" : ""}`} onClick={() => setWhen("later")}>Schedule</button>
              </div>
              {when === "later" && <input className="input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />}
            </Field>
            <Field label="Speed" hint="Sending gradually protects your number.">
              <select className="select" value={perMinute} onChange={(e) => setPerMinute(Number(e.target.value))}>
                <option value={10}>10 per minute</option>
                <option value={30}>30 per minute</option>
                <option value={60}>60 per minute</option>
              </select>
            </Field>
          </div>
        </div>

        <div className="stack">
          <div className="card" style={{ padding: 16, background: "var(--accent-soft)", borderColor: "transparent" }}>
            <div className="row">
              <span className="ichip grad"><Users /></span>
              <div>
                <div className="num" style={{ fontSize: 26, lineHeight: 1 }}>{preview ? preview.eligible : "…"}</div>
                <div className="small muted">{preview ? `of ${preview.total} in ${preview.label} will get this` : "Counting…"}</div>
              </div>
            </div>
            {excludedTotal > 0 && preview && (
              <div className="small" style={{ marginTop: 10 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Left out automatically ({excludedTotal})</div>
                {Object.entries(preview.excluded).map(([why, n]) => (
                  <div key={why} className="row" style={{ justifyContent: "space-between" }}><span className="muted">{why}</span><span className="num">{n}</span></div>
                ))}
              </div>
            )}
            {preview?.sample.length ? <div className="faint small" style={{ marginTop: 8 }}>Including {preview.sample.join(", ")}{preview.eligible > preview.sample.length ? "…" : ""}</div> : null}
          </div>
          {preview?.sampleText && (
            <div>
              <div className="small muted" style={{ marginBottom: 6 }}>What {preview.sampleName} will see</div>
              <div className={channel === "SMS" ? "bubble out" : "card"} style={channel === "SMS" ? { maxWidth: "100%" } : { padding: 12, whiteSpace: "pre-wrap", fontSize: 13.5 }}>
                {channel === "Email" && subject && <div style={{ fontWeight: 650, marginBottom: 6 }}>{subject}</div>}
                {preview.sampleText}
              </div>
            </div>
          )}
          <div className="card" style={{ padding: 12 }}>
            <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Send yourself a test first</div>
            <ContactPicker autoFocus={false} value={testTo} onChange={setTestTo} />
            <button className="btn sm" style={{ marginTop: 8 }} disabled={!testTo || !message.trim()} onClick={sendTest}><Send /> Send test</button>
          </div>
        </div>
      </div>

      {confirming && preview && (
        <ConfirmModal
          title={when === "later" ? `Schedule for ${preview.eligible} people?` : `Send to ${preview.eligible} people now?`}
          confirmLabel={busy ? "Working…" : when === "later" ? "Schedule broadcast" : "Send broadcast"}
          onClose={() => setConfirming(false)}
          onConfirm={create}
        >
          {channel === "SMS" ? "Texts" : "Emails"} go to {preview.label.toLowerCase()} at about {perMinute} per minute
          {when === "later" ? `, starting ${new Date(at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}, within your sending hours. You can pause or cancel while it's sending.
        </ConfirmModal>
      )}
    </Modal>
  );
}

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const b = useAsync(() => api.get<BroadcastRow & { recipients: Recipient[]; subject: string }>(`/api/broadcasts/${id}`), [id]);
  useEffect(() => {
    const t = setInterval(() => void b.reload(), 4000);
    return () => clearInterval(t);
  }, [b.reload]);
  const d = b.data;
  return (
    <Modal wide title={d ? d.name : "Broadcast"} onClose={onClose}>
      {!d ? (
        <LoadingRows n={5} />
      ) : (
        <>
          <div className="row wrap small">
            <ChannelBadge channel={d.channel} />
            <span className={`badge ${STATUS[d.status].cls}`}>{STATUS[d.status].label}</span>
            <span className="muted">{d.audienceLabel} · {d.perMinute}/min</span>
          </div>
          <div className="card" style={{ padding: 12, whiteSpace: "pre-wrap", fontSize: 13.5 }}>
            {d.subject && <div style={{ fontWeight: 650, marginBottom: 6 }}>{d.subject}</div>}
            {d.message}
          </div>
          {Object.keys(d.excluded).length > 0 && (
            <div className="small muted">Left out when created: {Object.entries(d.excluded).map(([k, n]) => `${k} (${n})`).join(", ")}</div>
          )}
          <div className="table-wrap" style={{ maxHeight: 380, border: "1px solid var(--border)", borderRadius: 8 }}>
            <table className="table">
              <thead><tr><th>Contact</th><th>Status</th><th>Note</th><th>When</th></tr></thead>
              <tbody>
                {d.recipients.map((r) => (
                  <tr key={r.contactId}>
                    <td><Link to={`/inbox/${r.contactId}`} onClick={onClose}>{r.name}</Link></td>
                    <td><span className={`badge ${R_STATUS[r.status].cls}`}>{R_STATUS[r.status].label}</span></td>
                    <td className="small muted">{r.reason ?? ""}</td>
                    <td className="small muted">{r.at ? relTime(r.at) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

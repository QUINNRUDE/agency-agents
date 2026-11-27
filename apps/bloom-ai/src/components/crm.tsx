// Shared CRM editors: deals, tasks, owners and confirmations.
import { useEffect, useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { api, type Contact, type Meta, type Opportunity, type Pipeline, type Task, type User } from "../lib/api.ts";
import { Field, Modal, useAsync, useToast } from "./ui.tsx";
import { celebrate } from "./brand.tsx";

let metaCache: Promise<Meta> | null = null;
/** Owners + custom field definitions, fetched once per page load. */
export function useMeta() {
  return useAsync(() => {
    metaCache ??= api.get<Meta>("/api/meta").catch((e) => {
      metaCache = null;
      throw e;
    });
    return metaCache;
  });
}

export const ownerName = (users: User[], id: string) => users.find((u) => u.id === id)?.name ?? "";

export function OwnerSelect({ users, value, onChange, allowAll, style }: { users: User[]; value: string; onChange: (v: string) => void; allowAll?: boolean; style?: React.CSSProperties }) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)} style={style} aria-label="Owner">
      {allowAll && <option value="*">All owners</option>}
      <option value="">{allowAll ? "Unassigned" : "No owner"}</option>
      {users.map((u) => (
        <option key={u.id} value={u.id}>{u.name}</option>
      ))}
    </select>
  );
}

export function ConfirmModal({ title, children, confirmLabel = "Delete", onConfirm, onClose, tone = "danger" }: { title: string; children: ReactNode; confirmLabel?: string; onConfirm: () => Promise<void> | void; onClose: () => void; tone?: "danger" | "primary" }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className={`btn ${tone === "primary" ? "primary" : ""}`}
            style={tone === "danger" ? { background: "var(--bad)", borderColor: "var(--bad)", color: "#fff" } : undefined}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      <div className="small">{children}</div>
    </Modal>
  );
}

/** Pick a contact by typing. */
export function ContactPicker({ value, onChange, autoFocus = true }: { value: Contact | null; onChange: (c: Contact | null) => void; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Contact[]>([]);
  useEffect(() => {
    if (value) return;
    const t = setTimeout(() => api.get<Contact[]>(`/api/contacts?limit=8&q=${encodeURIComponent(q)}`).then(setHits, () => setHits([])), 150);
    return () => clearTimeout(t);
  }, [q, value]);
  if (value)
    return (
      <div className="row">
        <span className="badge accent">{value.name}{value.companyName && value.companyName !== value.name ? ` · ${value.companyName}` : ""}</span>
        <button className="btn sm ghost" onClick={() => onChange(null)}>Change</button>
      </div>
    );
  return (
    <div className="stack" style={{ gap: 4 }}>
      <input className="input" placeholder="Search contacts…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus={autoFocus} />
      <div className="card" style={{ maxHeight: 180, overflowY: "auto" }}>
        {hits.map((c) => (
          <div key={c.id} className="list-item clickable" onClick={() => onChange(c)}>
            <span className="t">{c.name}</span>
            <span className="s">{c.companyName}</span>
          </div>
        ))}
        {!hits.length && <div className="faint small" style={{ padding: 10 }}>No matches</div>}
      </div>
    </div>
  );
}

const toDateInput = (iso: string) => (iso ? new Date(iso).toLocaleDateString("en-CA") : "");

export function TaskModal({ task, contact, users, onClose, onSaved }: { task?: Task; contact?: Contact | null; users: User[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [who, setWho] = useState<Contact | null>(contact ?? null);
  const [title, setTitle] = useState(task?.title ?? "");
  const [body, setBody] = useState(task?.body ?? "");
  const [due, setDue] = useState(task ? toDateInput(task.dueDate) : new Date(Date.now() + 86_400_000).toLocaleDateString("en-CA"));
  const [owner, setOwner] = useState(task?.assignedTo ?? contact?.assignedTo ?? "");
  const [busy, setBusy] = useState(false);
  const contactId = task?.contactId ?? who?.id;

  const save = async () => {
    if (!contactId) return;
    setBusy(true);
    const payload = { title, body, dueDate: new Date(`${due}T09:00:00`).toISOString(), assignedTo: owner };
    try {
      if (task) await api.put(`/api/contacts/${contactId}/tasks/${task.id}`, payload);
      else await api.post(`/api/contacts/${contactId}/tasks`, payload);
      toast(task ? "Task updated" : "Task created");
      onSaved();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save task", "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={task ? "Edit task" : "New task"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy || !title.trim() || !contactId || !due}>{busy ? "Saving…" : task ? "Save task" : "Create task"}</button>
        </>
      }
    >
      {!task && !contact && (
        <Field label="Contact" group>
          <ContactPicker value={who} onChange={setWho} />
        </Field>
      )}
      {task && <div className="small muted">For {task.contactName || "contact"}</div>}
      <Field label="Task"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus={Boolean(task || contact)} /></Field>
      <div className="grid-2">
        <Field label="Due"><input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        <Field label="Assigned to"><OwnerSelect users={users} value={owner} onChange={setOwner} /></Field>
      </div>
      <Field label="Details"><textarea className="textarea" rows={3} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
    </Modal>
  );
}

export function DealModal({
  deal,
  contact,
  pipelines,
  pipelineId,
  stageId,
  onClose,
  onSaved,
}: {
  deal?: Opportunity;
  contact?: Contact | null;
  pipelines: Pipeline[];
  pipelineId?: string;
  stageId?: string;
  onClose: () => void;
  onSaved: (o: Opportunity | null) => void;
}) {
  const toast = useToast();
  const [who, setWho] = useState<Contact | null>(contact ?? null);
  const [pid, setPid] = useState(deal?.pipelineId ?? pipelineId ?? pipelines[0]?.id ?? "");
  const pl = pipelines.find((p) => p.id === pid);
  const [sid, setSid] = useState(deal?.stageId ?? stageId ?? pl?.stages[0]?.id ?? "");
  const [name, setName] = useState(deal?.name ?? (contact ? `${contact.companyName || contact.name} — New opportunity` : ""));
  const [value, setValue] = useState(deal ? String(deal.value) : "");
  const [status, setStatus] = useState<Opportunity["status"]>(deal?.status ?? "open");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (!deal && who && !name) setName(`${who.companyName || who.name} — New opportunity`);
  }, [who, deal, name]);

  const save = async () => {
    setBusy(true);
    try {
      const payload = { name, value: Number(value.replace(/[^\d.]/g, "")) || 0, pipelineId: pid, stageId: sid, status };
      const o = deal ? await api.put<Opportunity>(`/api/opportunities/${deal.id}`, payload) : await api.post<Opportunity>("/api/opportunities", { ...payload, contactId: who?.id });
      toast(deal ? "Deal updated" : "Deal created");
      const wonStage = /won|closed|signed/i.test(pipelines.find((p) => p.id === pid)?.stages.find((x) => x.id === sid)?.name ?? "");
      if ((status === "won" && deal?.status !== "won") || (wonStage && deal?.stageId !== sid)) celebrate();
      onSaved({ ...o, ...payload, stageId: sid });
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save deal", "bad");
    } finally {
      setBusy(false);
    }
  };

  if (confirm && deal)
    return (
      <ConfirmModal
        title="Delete deal?"
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          await api.del(`/api/opportunities/${deal.id}`);
          toast("Deal deleted");
          onSaved(null);
          onClose();
        }}
      >
        “{deal.name}” will be permanently deleted from GoHighLevel. The contact stays.
      </ConfirmModal>
    );

  return (
    <Modal
      title={deal ? "Edit deal" : "New deal"}
      onClose={onClose}
      footer={
        <>
          {deal && (
            <button className="btn ghost danger" style={{ marginRight: "auto" }} onClick={() => setConfirm(true)}>
              <Trash2 /> Delete
            </button>
          )}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy || !name.trim() || !pid || (!deal && !who)}>{busy ? "Saving…" : deal ? "Save deal" : "Create deal"}</button>
        </>
      }
    >
      {!deal && !contact && (
        <Field label="Contact" group>
          <ContactPicker value={who} onChange={setWho} />
        </Field>
      )}
      {deal?.contactName && <div className="small muted">Contact: {deal.contactName}</div>}
      <Field label="Deal name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="grid-2">
        <Field label="Value ($)"><input className="input mono" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0" /></Field>
        <Field label="Status">
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value as Opportunity["status"])}>
            <option value="open">Open</option>
            <option value="won">Won</option>
            <option value="lost">Lost</option>
            <option value="abandoned">Abandoned</option>
          </select>
        </Field>
      </div>
      <div className="grid-2">
        <Field label="Pipeline">
          <select className="select" value={pid} onChange={(e) => (setPid(e.target.value), setSid(pipelines.find((p) => p.id === e.target.value)?.stages[0]?.id ?? ""))}>
            {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Stage">
          <select className="select" value={sid} onChange={(e) => setSid(e.target.value)}>
            {pl?.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

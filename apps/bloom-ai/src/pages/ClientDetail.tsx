import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, CheckSquare, Globe, ListPlus, Mail, MapPin, MessageSquare, NotebookPen, Pencil, Phone, PhoneCall, Plus, Sparkles, Tag, Trash2, X } from "lucide-react";
import { api, type Contact, type ContactBundle, type CustomField, type Note, type Opportunity, type Task } from "../lib/api.ts";
import { duration, longDate, money, outcomeLabel, outcomeTone, phoneDisplay, relTime, shortDate } from "../lib/format.ts";
import { AiPanel } from "../components/AiPanel.tsx";
import { ComposeModal } from "../components/Compose.tsx";
import { ConfirmModal, DealModal, OwnerSelect, TaskModal } from "../components/crm.tsx";
import { Avatar, Banner, Card, Empty, ErrorState, Field, LoadingRows, Modal, useAsync, useToast } from "../components/ui.tsx";

type TabId = "activity" | "notes" | "messages" | "calls";

function fieldDisplay(f: CustomField, v: string) {
  if (!v) return "";
  if (f.dataType === "MONETORY" && !Number.isNaN(Number(v))) return money(Number(v));
  if (f.dataType === "DATE" && !Number.isNaN(Date.parse(v))) return longDate(new Date(v).toISOString());
  return v;
}

export function ClientDetail() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data, error, loading, reload, setData } = useAsync(() => api.get<ContactBundle>(`/api/contacts/${id}`), [id]);
  const [tab, setTab] = useState<TabId>("activity");
  const [note, setNote] = useState("");
  const [compose, setCompose] = useState<null | { channel?: "SMS" | "Email"; subject?: string; body?: string }>(null);
  const [editing, setEditing] = useState(false);
  const [editingFields, setEditingFields] = useState(false);
  const [task, setTask] = useState<Task | "new" | null>(null);
  const [tagOpen, setTagOpen] = useState(false);
  const [deal, setDeal] = useState<Opportunity | "new" | null>(null);
  const [editNote, setEditNote] = useState<Note | null>(null);
  const [confirm, setConfirm] = useState<null | { kind: "contact" } | { kind: "note"; note: Note } | { kind: "task"; task: Task }>(null);

  const timeline = useMemo(() => {
    if (!data) return [];
    const items = [
      ...data.notes.map((n) => ({ kind: "note" as const, at: n.dateAdded, id: n.id, title: /^Call — /.test(n.body) ? "Call note" : "Note", body: n.body, note: n })),
      ...data.calls.map((c) => ({ kind: "call" as const, at: c.startedAt, id: c.id, title: `Call · ${outcomeLabel(c.outcome)} · ${duration(c.durationSec)}`, body: [c.notes, c.nextStep && `Next step: ${c.nextStep}`].filter(Boolean).join("\n"), note: null })),
      ...data.messages.map((m) => ({ kind: "message" as const, at: m.dateAdded, id: m.id, title: `${m.channel} ${m.direction === "inbound" ? "received" : "sent"}`, body: m.body, note: null })),
    ];
    return items.sort((a, b) => b.at.localeCompare(a.at));
  }, [data]);

  if (error) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  if (loading && !data) return <div className="page"><Card><LoadingRows n={8} /></Card></div>;
  if (!data) return null;
  const c = data.contact;
  const users = data.users;

  // Activity hides call notes (the call entry already shows them); the Notes tab shows every note.
  const visible =
    tab === "activity"
      ? timeline.filter((t) => !(t.kind === "note" && t.title === "Call note" && data.calls.length))
      : tab === "notes"
        ? timeline.filter((t) => t.kind === "note")
        : tab === "calls"
          ? timeline.filter((t) => t.kind === "call")
          : timeline.filter((t) => t.kind === "message");

  const addNote = async () => {
    if (!note.trim()) return;
    try {
      const n = await api.post<Note>(`/api/contacts/${c.id}/notes`, { body: note.trim() });
      setData({ ...data, notes: [n, ...data.notes] });
      setNote("");
      toast("Note saved");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save note", "bad");
    }
  };

  const updateContact = async (patch: Partial<Contact>, msg: string) => {
    try {
      const u = await api.put<Contact>(`/api/contacts/${c.id}`, patch);
      setData({ ...data, contact: { ...c, ...u, ...patch } });
      toast(msg);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Update failed", "bad");
    }
  };

  const removeTag = async (t: string) => {
    setData({ ...data, contact: { ...c, tags: c.tags.filter((x) => x !== t) } });
    try {
      await api.del(`/api/contacts/${c.id}/tags`, { tags: [t] });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not remove tag", "bad");
      reload();
    }
  };

  const moveStage = async (o: Opportunity, stageId: string) => {
    try {
      await api.put<Opportunity>(`/api/opportunities/${o.id}`, { stageId });
      setData({ ...data, opportunities: data.opportunities.map((x) => (x.id === o.id ? { ...x, stageId } : x)) });
      toast(`Moved to ${data.pipelines.flatMap((p) => p.stages).find((s) => s.id === stageId)?.name}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not move deal", "bad");
    }
  };

  const toggleTask = async (taskId: string, completed: boolean) => {
    setData({ ...data, tasks: data.tasks.map((t) => (t.id === taskId ? { ...t, completed } : t)) });
    try {
      await api.put(`/api/contacts/${c.id}/tasks/${taskId}`, { completed });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Update failed", "bad");
      reload();
    }
  };

  const tasks = [...data.tasks].sort((a, b) => Number(a.completed) - Number(b.completed) || a.dueDate.localeCompare(b.dueDate));
  const now = Date.now();
  const fieldValue = (fid: string) => c.customFields.find((x) => x.id === fid)?.value ?? "";
  const filledFields = data.customFields.filter((f) => fieldValue(f.id));

  return (
    <div className="page">
      <div className="row">
        <button className="btn ghost sm" onClick={() => nav(-1)}><ArrowLeft /> Back</button>
      </div>
      {data.warnings.length > 0 && <Banner tone="warn">Some data couldn't load from GoHighLevel: {data.warnings.join(" · ")}</Banner>}

      <div className="card" style={{ padding: 18 }}>
        <div className="row wrap" style={{ gap: 14 }}>
          <Avatar name={c.name} size="lg" />
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 20, letterSpacing: "-0.02em" }}>{c.name}</h2>
            <div className="muted">{[c.companyName !== c.name && c.companyName, [c.city, c.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || "No company on file"}</div>
            <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>
              {c.tags.map((t) => (
                <span className="tag" key={t} style={{ gap: 4 }}>
                  {t}
                  <button style={{ all: "unset", cursor: "pointer", display: "inline-flex", color: "var(--text-3)" }} onClick={() => removeTag(t)} aria-label={`Remove tag ${t}`}><X size={11} /></button>
                </span>
              ))}
              <button className="btn sm ghost" onClick={() => setTagOpen(true)}><Tag /> Tag</button>
            </div>
          </div>
          <div className="spacer" />
          <div className="row wrap">
            {users.length > 0 && (
              <label className="row small muted" style={{ gap: 6 }}>
                Owner
                <OwnerSelect users={users} value={c.assignedTo} onChange={(v) => updateContact({ assignedTo: v }, v ? `Assigned to ${users.find((u) => u.id === v)?.name}` : "Owner removed")} style={{ width: 160, height: 32 }} />
              </label>
            )}
            <button className="btn" onClick={() => setEditing(true)}><Pencil /> Edit</button>
            <button className="btn" onClick={() => setCompose({ channel: "Email" })} disabled={!c.email}><Mail /> Email</button>
            <button className="btn" onClick={() => setCompose({ channel: "SMS" })} disabled={!c.phone}><MessageSquare /> Text</button>
            <Link className="btn primary" to={`/calls/${c.id}`}><PhoneCall /> Call</Link>
            <button className="btn ghost icon" title="Delete contact" aria-label="Delete contact" onClick={() => setConfirm({ kind: "contact" })}><Trash2 /></button>
          </div>
        </div>
      </div>

      <div className="split-r">
        <div className="stack" style={{ gap: 16 }}>
          <div className="grid-halves">
            <Card title="Contact">
              <div className="stack small" style={{ gap: 8 }}>
                <div className="row"><Phone size={14} className="faint" /> {c.phone ? <a href={`tel:${c.phone}`} className="num">{phoneDisplay(c.phone)}</a> : <span className="faint">No phone</span>}</div>
                <div className="row"><Mail size={14} className="faint" /> {c.email ? <a href={`mailto:${c.email}`} className="ellipsis">{c.email}</a> : <span className="faint">No email</span>}</div>
                <div className="row"><Globe size={14} className="faint" /> {c.website ? <a href={c.website.startsWith("http") ? c.website : `https://${c.website}`} target="_blank" rel="noreferrer" className="ellipsis">{c.website.replace(/^https?:\/\/(www\.)?/, "")}</a> : <span className="faint">No website</span>}</div>
                <div className="row"><MapPin size={14} className="faint" /> {[c.city, c.state].filter(Boolean).join(", ") || <span className="faint">—</span>}</div>
                <div className="faint" style={{ marginTop: 4 }}>Source: {c.source || "—"} · Added {longDate(c.dateAdded)}</div>
              </div>
            </Card>
            <Card title="Details" right={data.customFields.length > 0 && <button className="btn sm ghost" onClick={() => setEditingFields(true)}><Pencil /> Edit</button>}>
              {data.customFields.length === 0 ? (
                <div className="faint small">No custom fields in this account. Create them in GoHighLevel → Settings → Custom Fields and they'll appear here.</div>
              ) : filledFields.length ? (
                <dl className="stack small" style={{ gap: 8, margin: 0 }}>
                  {filledFields.map((f) => (
                    <div key={f.id} style={{ display: "grid", gridTemplateColumns: "minmax(110px, 45%) 1fr", gap: 8 }}>
                      <dt className="faint">{f.name}</dt>
                      <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{fieldDisplay(f, fieldValue(f.id))}</dd>
                    </div>
                  ))}
                  {filledFields.length < data.customFields.length && <button className="btn sm ghost" style={{ justifySelf: "start" }} onClick={() => setEditingFields(true)}>+ {data.customFields.length - filledFields.length} empty field{data.customFields.length - filledFields.length === 1 ? "" : "s"}</button>}
                </dl>
              ) : (
                <button className="btn sm" onClick={() => setEditingFields(true)}><ListPlus /> Fill in {data.customFields.length} fields</button>
              )}
            </Card>
          </div>

          <Card title="Opportunities" right={<button className="btn sm ghost" onClick={() => setDeal("new")}><Plus /> New deal</button>} flush>
            {data.opportunities.length ? (
              <table className="table">
                <thead><tr><th>Deal</th><th>Stage</th><th>Status</th><th className="right">Value</th><th>In stage</th><th /></tr></thead>
                <tbody>
                  {data.opportunities.map((o) => {
                    const pl = data.pipelines.find((p) => p.id === o.pipelineId);
                    return (
                      <tr key={o.id}>
                        <td style={{ fontWeight: 550 }}>{o.name}<div className="faint small">{pl?.name}</div></td>
                        <td>
                          <select className="select" style={{ height: 28, width: 160 }} value={o.stageId} onChange={(e) => moveStage(o, e.target.value)} aria-label="Stage">
                            {pl?.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </select>
                        </td>
                        <td><span className={`badge ${o.status === "won" ? "good" : o.status === "lost" ? "bad" : ""}`}>{o.status}</span></td>
                        <td className="right num">{money(o.value)}</td>
                        <td className="small muted">{relTime(o.lastStageChangeAt ?? o.updatedAt)}</td>
                        <td><button className="btn sm ghost icon" aria-label="Edit deal" onClick={() => setDeal(o)}><Pencil /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <Empty title="No deals for this contact"><button className="btn sm" onClick={() => setDeal("new")}><Plus /> Create a deal</button></Empty>
            )}
          </Card>

          <Card title="Tasks" sub={`${tasks.filter((t) => !t.completed).length} open`} right={<button className="btn sm ghost" onClick={() => setTask("new")}><Plus /> Add task</button>} flush>
            {tasks.length ? (
              <div className="checklist" style={{ padding: "0 12px 10px" }}>
                {tasks.map((t) => {
                  const overdue = !t.completed && new Date(t.dueDate).getTime() < now;
                  return (
                    <div key={t.id} className={`check ${t.completed ? "done" : ""}`} style={{ alignItems: "center" }}>
                      <input type="checkbox" checked={t.completed} onChange={(e) => toggleTask(t.id, e.target.checked)} aria-label={`Complete ${t.title}`} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        {t.title}
                        {t.assignedTo && users.length > 0 && <span className="faint small"> · {users.find((u) => u.id === t.assignedTo)?.name}</span>}
                      </span>
                      <span className="small" style={{ color: overdue ? "var(--bad)" : "var(--text-3)", whiteSpace: "nowrap" }}>{shortDate(t.dueDate)}</span>
                      <button className="btn sm ghost icon" aria-label="Edit task" onClick={() => setTask(t)}><Pencil /></button>
                      <button className="btn sm ghost icon" aria-label="Delete task" onClick={() => setConfirm({ kind: "task", task: t })}><Trash2 /></button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Empty icon={<CheckSquare />} title="No tasks" />
            )}
          </Card>

          <section className="card">
            <div className="tabs">
              {([
                ["activity", "Activity", timeline.length],
                ["notes", "Notes", data.notes.length],
                ["calls", "Calls", data.calls.length],
                ["messages", "Messages", data.messages.length],
              ] as const).map(([k, label, n]) => (
                <button key={k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>
                  {label} <span className="c">{n}</span>
                </button>
              ))}
            </div>
            {(tab === "activity" || tab === "notes") && (
              <div style={{ padding: 14, borderBottom: "1px solid var(--border)", display: "grid", gap: 8 }}>
                <textarea className="textarea" rows={2} placeholder="Add a note — saved to GoHighLevel" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && addNote()} />
                <div className="row"><span className="faint small">⌘↵ to save</span><span className="spacer" /><button className="btn sm primary" onClick={addNote} disabled={!note.trim()}>Save note</button></div>
              </div>
            )}
            {tab === "messages" && (
              <div style={{ padding: 14, borderBottom: "1px solid var(--border)" }} className="row">
                <button className="btn sm" onClick={() => setCompose({ channel: "SMS" })} disabled={!c.phone}><MessageSquare /> New text</button>
                <button className="btn sm" onClick={() => setCompose({ channel: "Email" })} disabled={!c.email}><Mail /> New email</button>
              </div>
            )}
            <div className="timeline">
              {visible.map((t) => (
                <div className="tl-item" key={`${t.kind}-${t.id}`}>
                  <span className="tl-icon">{t.kind === "call" ? <Phone /> : t.kind === "message" ? <MessageSquare /> : <NotebookPen />}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="tl-head">
                      <b>{t.title}</b>
                      <span>{relTime(t.at)}</span>
                      {t.note && (
                        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 2 }}>
                          <button className="btn sm ghost icon" aria-label="Edit note" onClick={() => setEditNote(t.note)}><Pencil /></button>
                          <button className="btn sm ghost icon" aria-label="Delete note" onClick={() => setConfirm({ kind: "note", note: t.note! })}><Trash2 /></button>
                        </span>
                      )}
                    </div>
                    {t.body && <div className="tl-body">{t.body}</div>}
                  </div>
                </div>
              ))}
              {!visible.length && <Empty title="Nothing here yet" />}
            </div>
          </section>
        </div>

        <div className="stack" style={{ gap: 16, position: "sticky", top: 0 }}>
          <Card title={<span className="row" style={{ gap: 6 }}><Sparkles size={14} /> Agent playbooks</span>}>
            <AiPanel
              contactId={c.id}
              playbookIds={["call-prep", "follow-up", "deal-review", "proposal", "account-plan", "cold-call-script"]}
              onSaved={reload}
              onSendFollowUp={(d) => setCompose(d.email ? { channel: c.email ? "Email" : "SMS", subject: d.subject, body: c.email ? d.email : d.sms } : { channel: "SMS", body: d.sms })}
            />
          </Card>
          {data.calls[0] && (
            <Card title="Last call">
              <div className="row"><span className={`badge ${outcomeTone(data.calls[0].outcome)}`}>{outcomeLabel(data.calls[0].outcome)}</span><span className="faint small">{relTime(data.calls[0].startedAt)} · {duration(data.calls[0].durationSec)}</span></div>
              {data.calls[0].nextStep && <div className="small" style={{ marginTop: 8 }}>Next step: {data.calls[0].nextStep}</div>}
            </Card>
          )}
        </div>
      </div>

      {compose && <ComposeModal contact={c} initial={compose} onClose={() => setCompose(null)} onSent={reload} />}
      {editing && <EditContact contact={c} onClose={() => setEditing(false)} onSaved={(u) => setData({ ...data, contact: { ...c, ...u } })} />}
      {editingFields && <EditFields contact={c} fields={data.customFields} onClose={() => setEditingFields(false)} onSaved={(customFields) => setData({ ...data, contact: { ...c, customFields } })} />}
      {task && <TaskModal task={task === "new" ? undefined : task} contact={c} users={users} onClose={() => setTask(null)} onSaved={reload} />}
      {tagOpen && <AddTag contactId={c.id} onClose={() => setTagOpen(false)} onSaved={reload} />}
      {deal && (
        <DealModal
          deal={deal === "new" ? undefined : deal}
          contact={c}
          pipelines={data.pipelines}
          onClose={() => setDeal(null)}
          onSaved={() => reload()}
        />
      )}
      {editNote && <EditNote contactId={c.id} note={editNote} onClose={() => setEditNote(null)} onSaved={(n) => setData({ ...data, notes: data.notes.map((x) => (x.id === n.id ? { ...x, body: n.body } : x)) })} />}
      {confirm?.kind === "contact" && (
        <ConfirmModal
          title={`Delete ${c.name}?`}
          confirmLabel="Delete permanently"
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await api.del(`/api/contacts/${c.id}`);
            toast(`${c.name} deleted`);
            nav("/clients");
          }}
        >
          This permanently deletes the contact from GoHighLevel, along with their notes, tasks, deals and conversations. This can't be undone.
        </ConfirmModal>
      )}
      {confirm?.kind === "note" && (
        <ConfirmModal
          title="Delete note?"
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await api.del(`/api/contacts/${c.id}/notes/${confirm.note.id}`);
            setData({ ...data, notes: data.notes.filter((n) => n.id !== confirm.note.id) });
            toast("Note deleted");
          }}
        >
          “{confirm.note.body.slice(0, 140)}{confirm.note.body.length > 140 ? "…" : ""}”
        </ConfirmModal>
      )}
      {confirm?.kind === "task" && (
        <ConfirmModal
          title="Delete task?"
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await api.del(`/api/contacts/${c.id}/tasks/${confirm.task.id}`);
            setData({ ...data, tasks: data.tasks.filter((t) => t.id !== confirm.task.id) });
            toast("Task deleted");
          }}
        >
          “{confirm.task.title}”
        </ConfirmModal>
      )}
    </div>
  );
}

function EditContact({ contact, onClose, onSaved }: { contact: Contact; onClose: () => void; onSaved: (c: Contact) => void }) {
  const toast = useToast();
  const [f, setF] = useState({ firstName: contact.firstName, lastName: contact.lastName, companyName: contact.companyName, email: contact.email, phone: contact.phone, website: contact.website, city: contact.city, state: contact.state, source: contact.source });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try {
      const u = await api.put<Contact>(`/api/contacts/${contact.id}`, f);
      onSaved({ ...u, ...f, name: [f.firstName, f.lastName].filter(Boolean).join(" ") || u.name });
      toast("Contact updated");
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Update failed", "bad");
    }
  };
  return (
    <Modal title="Edit contact" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}>
      <div className="grid-2">
        <Field label="First name"><input className="input" value={f.firstName} onChange={set("firstName")} /></Field>
        <Field label="Last name"><input className="input" value={f.lastName} onChange={set("lastName")} /></Field>
      </div>
      <Field label="Company"><input className="input" value={f.companyName} onChange={set("companyName")} /></Field>
      <div className="grid-2">
        <Field label="Email"><input className="input" value={f.email} onChange={set("email")} /></Field>
        <Field label="Phone"><input className="input" value={f.phone} onChange={set("phone")} /></Field>
      </div>
      <div className="grid-3">
        <Field label="Website"><input className="input" value={f.website} onChange={set("website")} /></Field>
        <Field label="City"><input className="input" value={f.city} onChange={set("city")} /></Field>
        <Field label="State"><input className="input" value={f.state} onChange={set("state")} /></Field>
      </div>
      <Field label="Source"><input className="input" value={f.source} onChange={set("source")} /></Field>
    </Modal>
  );
}

function EditFields({ contact, fields, onClose, onSaved }: { contact: Contact; fields: CustomField[]; onClose: () => void; onSaved: (v: Contact["customFields"]) => void }) {
  const toast = useToast();
  const initial = Object.fromEntries(fields.map((f) => [f.id, contact.customFields.find((x) => x.id === f.id)?.value ?? ""]));
  const [vals, setVals] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const changed = fields.filter((f) => vals[f.id] !== initial[f.id]).map((f) => ({ id: f.id, value: vals[f.id] }));
    try {
      if (changed.length) await api.put(`/api/contacts/${contact.id}`, { customFields: changed });
      onSaved(fields.map((f) => ({ id: f.id, value: vals[f.id] })).filter((x) => x.value));
      toast(changed.length ? "Details saved" : "No changes");
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save", "bad");
    } finally {
      setBusy(false);
    }
  };
  const input = (f: CustomField) => {
    const v = vals[f.id] ?? "";
    const set = (x: string) => setVals({ ...vals, [f.id]: x });
    if (f.options.length && /OPTIONS|RADIO|DROPDOWN/i.test(f.dataType))
      return (
        <select className="select" value={v} onChange={(e) => set(e.target.value)}>
          <option value="">—</option>
          {f.options.map((o) => <option key={o}>{o}</option>)}
          {v && !f.options.includes(v) && <option>{v}</option>}
        </select>
      );
    if (f.dataType === "LARGE_TEXT") return <textarea className="textarea" rows={2} value={v} onChange={(e) => set(e.target.value)} />;
    if (f.dataType === "DATE") return <input className="input" type="date" value={v ? new Date(v).toLocaleDateString("en-CA") : ""} onChange={(e) => set(e.target.value)} />;
    if (f.dataType === "NUMERICAL" || f.dataType === "MONETORY") return <input className="input mono" inputMode="decimal" value={v} onChange={(e) => set(e.target.value)} />;
    return <input className="input" value={v} onChange={(e) => set(e.target.value)} />;
  };
  return (
    <Modal title="Edit details" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button></>}>
      {fields.map((f) => (
        <Field key={f.id} label={f.name}>{input(f)}</Field>
      ))}
    </Modal>
  );
}

function EditNote({ contactId, note, onClose, onSaved }: { contactId: string; note: Note; onClose: () => void; onSaved: (n: Note) => void }) {
  const toast = useToast();
  const [body, setBody] = useState(note.body);
  const save = async () => {
    try {
      await api.put(`/api/contacts/${contactId}/notes/${note.id}`, { body });
      onSaved({ ...note, body });
      toast("Note updated");
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not update note", "bad");
    }
  };
  return (
    <Modal title="Edit note" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={!body.trim()}>Save</button></>}>
      <textarea className="textarea" rows={8} value={body} onChange={(e) => setBody(e.target.value)} autoFocus />
    </Modal>
  );
}

function AddTag({ contactId, onClose, onSaved }: { contactId: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [tag, setTag] = useState("");
  const save = async () => {
    try {
      await api.post(`/api/contacts/${contactId}/tags`, { tags: tag.split(",").map((t) => t.trim()).filter(Boolean) });
      toast("Tag added");
      onSaved();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not tag", "bad");
    }
  };
  return (
    <Modal title="Add tags" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={!tag.trim()}>Add</button></>}>
      <Field label="Tags" hint="Comma separated. Tags sync to GoHighLevel and can trigger workflows."><input className="input" value={tag} onChange={(e) => setTag(e.target.value)} autoFocus onKeyDown={(e) => e.key === "Enter" && save()} /></Field>
    </Modal>
  );
}

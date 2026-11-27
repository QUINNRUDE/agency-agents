import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, CheckSquare, Globe, Mail, MapPin, MessageSquare, NotebookPen, Pencil, Phone, PhoneCall, Plus, Sparkles, Tag } from "lucide-react";
import { api, type Contact, type ContactBundle, type Opportunity } from "../lib/api.ts";
import { duration, longDate, money, outcomeLabel, outcomeTone, phoneDisplay, relTime, shortDate } from "../lib/format.ts";
import { AiPanel } from "../components/AiPanel.tsx";
import { ComposeModal } from "../components/Compose.tsx";
import { Avatar, Banner, Card, Empty, ErrorState, Field, LoadingRows, Modal, useAsync, useToast } from "../components/ui.tsx";

type TabId = "activity" | "notes" | "messages" | "calls";

export function ClientDetail() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data, error, loading, reload, setData } = useAsync(() => api.get<ContactBundle>(`/api/contacts/${id}`), [id]);
  const [tab, setTab] = useState<TabId>("activity");
  const [note, setNote] = useState("");
  const [compose, setCompose] = useState<null | { channel?: "SMS" | "Email"; subject?: string; body?: string }>(null);
  const [editing, setEditing] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [dealOpen, setDealOpen] = useState(false);

  const timeline = useMemo(() => {
    if (!data) return [];
    const items = [
      ...data.notes.filter((n) => !/^Call — /.test(n.body)).map((n) => ({ kind: "note" as const, at: n.dateAdded, id: n.id, title: "Note", body: n.body })),
      ...data.calls.map((c) => ({ kind: "call" as const, at: c.startedAt, id: c.id, title: `Call · ${outcomeLabel(c.outcome)} · ${duration(c.durationSec)}`, body: [c.notes, c.nextStep && `Next step: ${c.nextStep}`].filter(Boolean).join("\n") })),
      ...data.messages.map((m) => ({ kind: "message" as const, at: m.dateAdded, id: m.id, title: `${m.channel} ${m.direction === "inbound" ? "received" : "sent"}`, body: m.body })),
    ];
    return items.sort((a, b) => b.at.localeCompare(a.at));
  }, [data]);

  if (error) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  if (loading && !data) return <div className="page"><Card><LoadingRows n={8} /></Card></div>;
  if (!data) return null;
  const c = data.contact;
  const stageName = (o: Opportunity) => data.pipelines.find((p) => p.id === o.pipelineId)?.stages.find((s) => s.id === o.stageId)?.name ?? "—";

  const addNote = async () => {
    if (!note.trim()) return;
    try {
      const n = await api.post<ContactBundle["notes"][number]>(`/api/contacts/${c.id}/notes`, { body: note.trim() });
      setData({ ...data, notes: [n, ...data.notes] });
      setNote("");
      toast("Note saved");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save note", "bad");
    }
  };

  const moveStage = async (o: Opportunity, stageId: string) => {
    try {
      const u = await api.put<Opportunity>(`/api/opportunities/${o.id}`, { stageId });
      setData({ ...data, opportunities: data.opportunities.map((x) => (x.id === o.id ? { ...x, ...u, stageId } : x)) });
      toast(`Moved to ${data.pipelines.flatMap((p) => p.stages).find((s) => s.id === stageId)?.name}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not move deal", "bad");
    }
  };

  const setStatus = async (o: Opportunity, status: Opportunity["status"]) => {
    try {
      await api.put(`/api/opportunities/${o.id}`, { status });
      setData({ ...data, opportunities: data.opportunities.map((x) => (x.id === o.id ? { ...x, status } : x)) });
      toast(`Marked ${status}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Update failed", "bad");
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
            <div className="muted">{[c.companyName, [c.city, c.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || "No company on file"}</div>
            <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>
              {c.tags.map((t) => <span className="tag" key={t}>{t}</span>)}
              <button className="btn sm ghost" onClick={() => setTagOpen(true)}><Tag /> Tag</button>
            </div>
          </div>
          <div className="spacer" />
          <div className="row wrap">
            <button className="btn" onClick={() => setEditing(true)}><Pencil /> Edit</button>
            <button className="btn" onClick={() => setCompose({ channel: "Email" })} disabled={!c.email}><Mail /> Email</button>
            <button className="btn" onClick={() => setCompose({ channel: "SMS" })} disabled={!c.phone}><MessageSquare /> Text</button>
            <Link className="btn primary" to={`/calls/${c.id}`} aria-disabled={!c.phone}><PhoneCall /> Call</Link>
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
                <div className="row"><Globe size={14} className="faint" /> {c.website ? <a href={c.website} target="_blank" rel="noreferrer" className="ellipsis">{c.website.replace(/^https?:\/\/(www\.)?/, "")}</a> : <span className="faint">No website</span>}</div>
                <div className="row"><MapPin size={14} className="faint" /> {[c.city, c.state].filter(Boolean).join(", ") || <span className="faint">—</span>}</div>
                <div className="faint" style={{ marginTop: 4 }}>Source: {c.source || "—"} · Added {longDate(c.dateAdded)}</div>
              </div>
            </Card>
            <Card title="Tasks" right={<button className="btn sm ghost" onClick={() => setTaskOpen(true)}><Plus /> Add</button>} flush>
              {tasks.length ? (
                <div className="checklist" style={{ padding: "0 12px 10px" }}>
                  {tasks.slice(0, 6).map((t) => (
                    <label key={t.id} className={`check ${t.completed ? "done" : ""}`}>
                      <input type="checkbox" checked={t.completed} onChange={(e) => toggleTask(t.id, e.target.checked)} />
                      <span style={{ flex: 1 }}>{t.title}</span>
                      <span className={`small ${!t.completed && new Date(t.dueDate).getTime() < now ? "" : "faint"}`} style={{ color: !t.completed && new Date(t.dueDate).getTime() < now ? "var(--bad)" : undefined }}>{shortDate(t.dueDate)}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <Empty icon={<CheckSquare />} title="No tasks" />
              )}
            </Card>
          </div>

          <Card title="Opportunities" right={<button className="btn sm ghost" onClick={() => setDealOpen(true)}><Plus /> New deal</button>} flush>
            {data.opportunities.length ? (
              <table className="table">
                <thead><tr><th>Deal</th><th>Stage</th><th>Status</th><th className="right">Value</th><th>In stage since</th><th /></tr></thead>
                <tbody>
                  {data.opportunities.map((o) => {
                    const pl = data.pipelines.find((p) => p.id === o.pipelineId);
                    return (
                      <tr key={o.id}>
                        <td style={{ fontWeight: 550 }}>{o.name}<div className="faint small">{pl?.name}</div></td>
                        <td>
                          <select className="select" style={{ height: 28, width: 170 }} value={o.stageId} onChange={(e) => moveStage(o, e.target.value)} aria-label="Stage">
                            {pl?.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>) ?? <option>{stageName(o)}</option>}
                          </select>
                        </td>
                        <td><span className={`badge ${o.status === "won" ? "good" : o.status === "lost" ? "bad" : ""}`}>{o.status}</span></td>
                        <td className="right num">{money(o.value)}</td>
                        <td className="small muted">{relTime(o.lastStageChangeAt ?? o.updatedAt)}</td>
                        <td>
                          {o.status === "open" && (
                            <div className="row" style={{ gap: 4 }}>
                              <button className="btn sm ghost" onClick={() => setStatus(o, "won")}>Won</button>
                              <button className="btn sm ghost" onClick={() => setStatus(o, "lost")}>Lost</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <Empty title="No deals for this contact" />
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
              {(tab === "activity" ? timeline : tab === "notes" ? timeline.filter((t) => t.kind === "note").concat(data.notes.filter((n) => /^Call — /.test(n.body)).map((n) => ({ kind: "note" as const, at: n.dateAdded, id: n.id, title: "Call note", body: n.body }))).sort((a, b) => b.at.localeCompare(a.at)) : tab === "calls" ? timeline.filter((t) => t.kind === "call") : timeline.filter((t) => t.kind === "message")).map((t) => (
                <div className="tl-item" key={`${t.kind}-${t.id}`}>
                  <span className="tl-icon">{t.kind === "call" ? <Phone /> : t.kind === "message" ? <MessageSquare /> : <NotebookPen />}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="tl-head"><b>{t.title}</b><span>{relTime(t.at)}</span></div>
                    {t.body && <div className="tl-body">{t.body}</div>}
                  </div>
                </div>
              ))}
              {!timeline.length && <Empty title="No activity yet" />}
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
      {editing && <EditContact contact={c} onClose={() => setEditing(false)} onSaved={(u) => setData({ ...data, contact: u })} />}
      {taskOpen && <NewTask contactId={c.id} onClose={() => setTaskOpen(false)} onSaved={reload} />}
      {tagOpen && <AddTag contactId={c.id} onClose={() => setTagOpen(false)} onSaved={reload} />}
      {dealOpen && <NewDeal contact={c} pipelines={data.pipelines} onClose={() => setDealOpen(false)} onSaved={reload} />}
    </div>
  );
}

function EditContact({ contact, onClose, onSaved }: { contact: Contact; onClose: () => void; onSaved: (c: Contact) => void }) {
  const toast = useToast();
  const [f, setF] = useState({ firstName: contact.firstName, lastName: contact.lastName, companyName: contact.companyName, email: contact.email, phone: contact.phone, website: contact.website, city: contact.city, state: contact.state });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try {
      const u = await api.put<Contact>(`/api/contacts/${contact.id}`, f);
      onSaved(u);
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
    </Modal>
  );
}

export function NewTask({ contactId, onClose, onSaved, initialTitle = "" }: { contactId: string; onClose: () => void; onSaved: () => void; initialTitle?: string }) {
  const toast = useToast();
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const [title, setTitle] = useState(initialTitle);
  const [due, setDue] = useState(tomorrow);
  const [body, setBody] = useState("");
  const save = async () => {
    try {
      await api.post(`/api/contacts/${contactId}/tasks`, { title, body, dueDate: new Date(`${due}T09:00:00`).toISOString() });
      toast("Task created");
      onSaved();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not create task", "bad");
    }
  };
  return (
    <Modal title="New task" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={!title.trim()}>Create task</button></>}>
      <Field label="Task"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></Field>
      <Field label="Due"><input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      <Field label="Details"><textarea className="textarea" rows={3} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
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

function NewDeal({ contact, pipelines, onClose, onSaved }: { contact: Contact; pipelines: ContactBundle["pipelines"]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [pipelineId, setPipelineId] = useState(pipelines[0]?.id ?? "");
  const pl = pipelines.find((p) => p.id === pipelineId);
  const [stageId, setStageId] = useState(pl?.stages[0]?.id ?? "");
  const [name, setName] = useState(`${contact.companyName || contact.name} — New opportunity`);
  const [value, setValue] = useState("");
  const save = async () => {
    try {
      await api.post("/api/opportunities", { pipelineId, stageId: stageId || pl?.stages[0]?.id, contactId: contact.id, name, value: Number(value) || 0 });
      toast("Deal created");
      onSaved();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not create deal", "bad");
    }
  };
  return (
    <Modal title="New deal" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={!pipelineId}>Create deal</button></>}>
      <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="grid-3">
        <Field label="Pipeline">
          <select className="select" value={pipelineId} onChange={(e) => (setPipelineId(e.target.value), setStageId(pipelines.find((p) => p.id === e.target.value)?.stages[0]?.id ?? ""))}>
            {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Stage">
          <select className="select" value={stageId} onChange={(e) => setStageId(e.target.value)}>
            {pl?.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Value ($)"><input className="input" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

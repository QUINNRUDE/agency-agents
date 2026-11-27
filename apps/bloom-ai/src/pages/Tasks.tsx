import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CheckSquare, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { api, type Task } from "../lib/api.ts";
import { longDate, relTime } from "../lib/format.ts";
import { Card, Empty, ErrorState, LoadingRows, useAsync, useToast } from "../components/ui.tsx";
import { ConfirmModal, OwnerSelect, ownerName, TaskModal, useMeta } from "../components/crm.tsx";

type Bucket = "overdue" | "today" | "week" | "later" | "completed";

const BUCKETS: { id: Bucket; label: string }[] = [
  { id: "overdue", label: "Overdue" },
  { id: "today", label: "Today" },
  { id: "week", label: "Next 7 days" },
  { id: "later", label: "Later" },
  { id: "completed", label: "Completed" },
];

function bucketOf(t: Task): Bucket {
  if (t.completed) return "completed";
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const due = t.dueDate ? new Date(t.dueDate).getTime() : Infinity;
  if (due < start.getTime()) return "overdue";
  if (due < start.getTime() + 86_400_000) return "today";
  if (due < start.getTime() + 8 * 86_400_000) return "week";
  return "later";
}

export function Tasks() {
  const toast = useToast();
  const meta = useMeta();
  const users = meta.data?.users ?? [];
  const open = useAsync(() => api.get<Task[]>("/api/tasks?status=open"));
  const [bucket, setBucket] = useState<Bucket>("today");
  const done = useAsync(() => (bucket === "completed" ? api.get<Task[]>("/api/tasks?status=completed") : Promise.resolve(null)), [bucket]);
  const [owner, setOwner] = useState("*");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Task | "new" | null>(null);
  const [deleting, setDeleting] = useState<Task | null>(null);

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { overdue: 0, today: 0, week: 0, later: 0, completed: 0 };
    for (const t of open.data ?? []) if (owner === "*" || t.assignedTo === owner) c[bucketOf(t)]++;
    return c;
  }, [open.data, owner]);

  // Land on the most urgent non-empty bucket the first time data arrives.
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || !open.data) return;
    landed.current = true;
    if (counts.overdue) setBucket("overdue");
    else if (!counts.today && counts.week) setBucket("week");
  }, [open.data, counts]);

  const rows = useMemo(() => {
    const src = bucket === "completed" ? (done.data ?? []) : (open.data ?? []).filter((t) => bucketOf(t) === bucket);
    const term = q.toLowerCase();
    return src.filter((t) => (owner === "*" || t.assignedTo === owner) && (!term || `${t.title} ${t.body} ${t.contactName}`.toLowerCase().includes(term)));
  }, [bucket, open.data, done.data, owner, q]);

  const toggle = async (t: Task) => {
    const next = !t.completed;
    open.setData((d) => (d ? (next ? d.filter((x) => x.id !== t.id) : [...d, { ...t, completed: false }]) : d));
    done.setData((d) => (d ? d.filter((x) => x.id !== t.id) : d));
    try {
      await api.put(`/api/contacts/${t.contactId}/tasks/${t.id}`, { completed: next });
      toast(next ? `Completed “${t.title}”` : "Reopened task");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Update failed", "bad");
      open.reload();
    }
  };

  const reschedule = async (t: Task, days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(9, 0, 0, 0);
    try {
      await api.put(`/api/contacts/${t.contactId}/tasks/${t.id}`, { dueDate: d.toISOString() });
      open.setData((list) => list?.map((x) => (x.id === t.id ? { ...x, dueDate: d.toISOString() } : x)) ?? list);
      toast(`Moved to ${longDate(d.toISOString())}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Update failed", "bad");
    }
  };

  const loading = bucket === "completed" ? done.loading && !done.data : open.loading && !open.data;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Tasks</h2>
          <p>
            {open.data ? (
              <>
                <span style={{ color: counts.overdue ? "var(--bad)" : undefined }}>{counts.overdue} overdue</span> · {counts.today} due today · {counts.week} this week
              </>
            ) : (
              "Every task across your clients, synced with GoHighLevel"
            )}
          </p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => setEditing("new")}><Plus /> New task</button>
        </div>
      </div>

      <div className="row wrap">
        <div className="btn-group">
          {BUCKETS.map((b) => (
            <button key={b.id} className={`btn ${bucket === b.id ? "on" : ""}`} onClick={() => setBucket(b.id)}>
              {b.label}
              {b.id !== "completed" && <span className="num" style={{ marginLeft: 6, color: b.id === "overdue" && counts.overdue ? "var(--bad)" : "var(--text-3)" }}>{counts[b.id]}</span>}
            </button>
          ))}
        </div>
        <div className="input-icon" style={{ width: 240 }}>
          <Search />
          <input className="input" placeholder="Search tasks" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {users.length > 0 && <OwnerSelect users={users} value={owner} onChange={setOwner} allowAll style={{ width: 180 }} />}
      </div>

      {open.error && <ErrorState error={open.error} onRetry={open.reload} />}

      <Card flush>
        {loading ? (
          <LoadingRows n={6} />
        ) : rows.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 36 }} />
                  <th>Task</th>
                  <th>Contact</th>
                  {users.length > 0 && <th>Owner</th>}
                  <th>Due</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const overdue = bucketOf(t) === "overdue";
                  return (
                    <tr key={t.id}>
                      <td>
                        <input type="checkbox" checked={t.completed} onChange={() => toggle(t)} aria-label={`Complete ${t.title}`} style={{ accentColor: "var(--accent)" }} />
                      </td>
                      <td style={{ maxWidth: 420 }}>
                        <div style={{ fontWeight: 550, textDecoration: t.completed ? "line-through" : undefined, color: t.completed ? "var(--text-3)" : undefined }}>{t.title}</div>
                        {t.body && <div className="faint small ellipsis">{t.body}</div>}
                      </td>
                      <td>{t.contactId ? <Link to={`/clients/${t.contactId}`}>{t.contactName || "Open contact"}</Link> : "—"}</td>
                      {users.length > 0 && <td className="small">{ownerName(users, t.assignedTo) || <span className="faint">Unassigned</span>}</td>}
                      <td className="small" style={{ whiteSpace: "nowrap", color: overdue ? "var(--bad)" : undefined }}>
                        {t.dueDate ? (
                          <>
                            {longDate(t.dueDate)} <span className={overdue ? "" : "faint"}>· {relTime(t.dueDate)}</span>
                          </>
                        ) : (
                          <span className="faint">No date</span>
                        )}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <div className="row" style={{ gap: 2, justifyContent: "flex-end" }}>
                          {!t.completed && (
                            <>
                              <button className="btn sm ghost" onClick={() => reschedule(t, 1)} title="Push to tomorrow">+1d</button>
                              <button className="btn sm ghost" onClick={() => reschedule(t, 7)} title="Push a week">+1w</button>
                            </>
                          )}
                          <button className="btn sm ghost icon" onClick={() => setEditing(t)} aria-label="Edit"><Pencil /></button>
                          <button className="btn sm ghost icon" onClick={() => setDeleting(t)} aria-label="Delete"><Trash2 /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={<CheckSquare />} title={bucket === "overdue" ? "Nothing overdue" : bucket === "today" ? "Nothing due today" : bucket === "completed" ? "No completed tasks" : "No tasks here"}>
            Tasks you create here, on a client, or by logging a call with a follow-up date show up in this list.
          </Empty>
        )}
      </Card>

      {editing && <TaskModal task={editing === "new" ? undefined : editing} users={users} onClose={() => setEditing(null)} onSaved={() => (open.reload(), done.reload())} />}
      {deleting && (
        <ConfirmModal
          title="Delete task?"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.del(`/api/contacts/${deleting.contactId}/tasks/${deleting.id}`);
            open.setData((d) => d?.filter((x) => x.id !== deleting.id) ?? d);
            done.setData((d) => d?.filter((x) => x.id !== deleting.id) ?? d);
            toast("Task deleted");
          }}
        >
          “{deleting.title}” will be removed from {deleting.contactName || "this contact"} in GoHighLevel.
        </ConfirmModal>
      )}
    </div>
  );
}

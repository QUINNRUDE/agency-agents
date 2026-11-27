import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowDown, ArrowUp, Bookmark, Building2, Columns3, Copy, Download, Phone, Plus, Search, Tag, Trash2, Upload, UserRound, Users, X } from "lucide-react";
import { api, type Contact, type Opportunity, type Pipeline, type SavedView, type User } from "../lib/api.ts";
import { money, phoneDisplay, relTime, shortDate } from "../lib/format.ts";
import { guessMapping, IMPORT_FIELDS, parseCsv, type ImportKey } from "../lib/csv.ts";
import { Avatar, Banner, Card, Empty, ErrorState, Field, LoadingRows, Modal, useAsync, useToast } from "../components/ui.tsx";
import { ConfirmModal, OwnerSelect, ownerName, useMeta } from "../components/crm.tsx";

type SortKey = "name" | "company" | "value" | "added" | "activity" | "owner";

interface Filters {
  q: string;
  stage: string;
  source: string;
  tag: string;
  owner: string; // "*" all, "" unassigned, else user id
  idle: string; // "", "7", "30", "90" — no activity in N days
  added: string; // "", "7", "30" — added in last N days
  deal: string; // "", "open", "won", "none"
}
const EMPTY: Filters = { q: "", stage: "", source: "", tag: "", owner: "*", idle: "", added: "", deal: "" };

const SMART_VIEWS: { id: string; name: string; filters: Partial<Filters> }[] = [
  { id: "all", name: "All contacts", filters: {} },
  { id: "new", name: "New this week", filters: { added: "7" } },
  { id: "hot", name: "Hot leads", filters: { tag: "hot" } },
  { id: "open", name: "Open deals", filters: { deal: "open" } },
  { id: "customers", name: "Customers", filters: { deal: "won" } },
  { id: "idle", name: "Going cold (30d+)", filters: { idle: "30", deal: "open" } },
  { id: "unassigned", name: "Unassigned", filters: { owner: "" } },
];

export function NewContactModal({ onClose, onCreated, initial }: { onClose: () => void; onCreated: (c: Contact) => void; initial?: Partial<Contact> }) {
  const toast = useToast();
  const meta = useMeta();
  const pipelines = useAsync(() => api.get<Pipeline[]>("/api/pipelines"));
  const [f, setF] = useState({
    firstName: initial?.firstName ?? "",
    lastName: initial?.lastName ?? "",
    companyName: initial?.companyName ?? "",
    email: initial?.email ?? "",
    phone: initial?.phone ?? "",
    website: initial?.website ?? "",
    city: initial?.city ?? "",
    state: initial?.state ?? "",
    source: initial?.source ?? "Manual",
    tags: "",
    assignedTo: "",
    pipelineId: "",
    stageId: "",
    value: "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const pl = pipelines.data?.find((p) => p.id === f.pipelineId);
  const valid = f.firstName || f.lastName || f.companyName || f.email || f.phone;

  const submit = async () => {
    setBusy(true);
    try {
      const c = await api.post<Contact>("/api/contacts", {
        firstName: f.firstName,
        lastName: f.lastName,
        companyName: f.companyName,
        email: f.email,
        phone: f.phone,
        website: f.website,
        city: f.city,
        state: f.state,
        source: f.source,
        assignedTo: f.assignedTo || undefined,
        tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean),
        opportunity: f.pipelineId ? { pipelineId: f.pipelineId, stageId: f.stageId || pl?.stages[0]?.id, value: Number(f.value) || 0 } : undefined,
      });
      toast(`${c.name} added`);
      onCreated(c);
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not create contact", "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New contact"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!valid || busy} onClick={submit}>{busy ? "Saving…" : "Create contact"}</button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="First name"><input className="input" value={f.firstName} onChange={set("firstName")} autoFocus /></Field>
        <Field label="Last name"><input className="input" value={f.lastName} onChange={set("lastName")} /></Field>
      </div>
      <Field label="Company"><input className="input" value={f.companyName} onChange={set("companyName")} /></Field>
      <div className="grid-2">
        <Field label="Email"><input className="input" type="email" value={f.email} onChange={set("email")} /></Field>
        <Field label="Phone"><input className="input" type="tel" value={f.phone} onChange={set("phone")} placeholder="+1 555 123 4567" /></Field>
      </div>
      <div className="grid-3">
        <Field label="Website"><input className="input" value={f.website} onChange={set("website")} /></Field>
        <Field label="City"><input className="input" value={f.city} onChange={set("city")} /></Field>
        <Field label="State"><input className="input" value={f.state} onChange={set("state")} /></Field>
      </div>
      <div className="grid-3">
        <Field label="Source"><input className="input" value={f.source} onChange={set("source")} /></Field>
        <Field label="Tags" hint="Comma separated"><input className="input" value={f.tags} onChange={set("tags")} /></Field>
        <Field label="Owner">
          <OwnerSelect users={meta.data?.users ?? []} value={f.assignedTo} onChange={(v) => setF({ ...f, assignedTo: v })} />
        </Field>
      </div>
      <div className="grid-3">
        <Field label="Add to pipeline">
          <select className="select" value={f.pipelineId} onChange={(e) => setF({ ...f, pipelineId: e.target.value, stageId: pipelines.data?.find((p) => p.id === e.target.value)?.stages[0]?.id ?? "" })}>
            <option value="">Don't create a deal</option>
            {pipelines.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Stage">
          <select className="select" value={f.stageId} onChange={set("stageId")} disabled={!pl}>
            {pl?.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Deal value ($)"><input className="input" inputMode="numeric" value={f.value} onChange={set("value")} disabled={!pl} /></Field>
      </div>
    </Modal>
  );
}

function csv(rows: (string | number)[][]) {
  return rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
}

function download(name: string, data: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: "text/csv" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function Clients() {
  const nav = useNavigate();
  const toast = useToast();
  const meta = useMeta();
  const users: User[] = meta.data?.users ?? [];
  const [f, setF] = useState<Filters>(EMPTY);
  const [viewId, setViewId] = useState("all");
  const [mode, setMode] = useState<"people" | "companies">("people");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "added", dir: -1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<null | "new" | "import" | "dupes" | "save" | "tag" | "untag" | "assign" | "pipeline" | "delete">(null);

  const contacts = useAsync(() => api.get<Contact[]>("/api/contacts?limit=2000"));
  const opps = useAsync(() => api.get<Opportunity[]>("/api/opportunities"));
  const pipelines = useAsync(() => api.get<Pipeline[]>("/api/pipelines"));
  const views = useAsync(() => api.get<SavedView[]>("/api/views"));

  const stageById = useMemo(() => new Map((pipelines.data ?? []).flatMap((p) => p.stages.map((s) => [s.id, s.name] as const))), [pipelines.data]);
  const dealsByContact = useMemo(() => {
    const m = new Map<string, Opportunity[]>();
    for (const o of opps.data ?? []) m.set(o.contactId, [...(m.get(o.contactId) ?? []), o]);
    return m;
  }, [opps.data]);
  const mainDeal = (id: string) => (dealsByContact.get(id) ?? []).filter((o) => o.status === "open" || o.status === "won").sort((a, b) => Number(b.status === "open") - Number(a.status === "open") || b.value - a.value)[0];

  const allTags = useMemo(() => [...new Set((contacts.data ?? []).flatMap((c) => c.tags))].sort(), [contacts.data]);
  const allSources = useMemo(() => [...new Set((contacts.data ?? []).map((c) => c.source).filter(Boolean))].sort(), [contacts.data]);
  const allStages = useMemo(() => [...new Set((opps.data ?? []).filter((o) => o.status === "open").map((o) => stageById.get(o.stageId) ?? ""))].filter(Boolean), [opps.data, stageById]);

  const DAY = 86_400_000;
  const filtered = useMemo(() => {
    const term = f.q.toLowerCase().trim();
    const now = Date.now();
    return (contacts.data ?? []).filter((c) => {
      if (term && ![c.name, c.companyName, c.email, c.phone, c.city, ...c.tags].join(" ").toLowerCase().includes(term)) return false;
      if (f.tag && !c.tags.includes(f.tag)) return false;
      if (f.source && c.source !== f.source) return false;
      if (f.owner !== "*" && c.assignedTo !== f.owner) return false;
      if (f.added && now - new Date(c.dateAdded).getTime() > Number(f.added) * DAY) return false;
      if (f.idle && c.lastActivity && now - new Date(c.lastActivity).getTime() < Number(f.idle) * DAY) return false;
      const deals = dealsByContact.get(c.id) ?? [];
      if (f.deal === "open" && !deals.some((o) => o.status === "open")) return false;
      if (f.deal === "won" && !deals.some((o) => o.status === "won")) return false;
      if (f.deal === "none" && deals.length) return false;
      if (f.stage && !deals.some((o) => o.status === "open" && stageById.get(o.stageId) === f.stage)) return false;
      return true;
    });
  }, [contacts.data, f, dealsByContact, stageById, DAY]);

  const rows = useMemo(() => {
    const val = (c: Contact): string | number => {
      switch (sort.key) {
        case "name": return c.name.toLowerCase();
        case "company": return c.companyName.toLowerCase();
        case "value": return mainDeal(c.id)?.value ?? -1;
        case "added": return c.dateAdded;
        case "activity": return c.lastActivity ?? "";
        case "owner": return ownerName(users, c.assignedTo).toLowerCase() || "~";
      }
    };
    return [...filtered].sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * sort.dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sort, users, dealsByContact]);

  const companies = useMemo(() => {
    const m = new Map<string, Contact[]>();
    for (const c of filtered) {
      const key = (c.companyName || "").trim();
      if (!key) continue;
      m.set(key.toLowerCase(), [...(m.get(key.toLowerCase()) ?? []), c]);
    }
    return [...m.values()]
      .map((list) => {
        const deals = list.flatMap((c) => dealsByContact.get(c.id) ?? []);
        const open = deals.filter((o) => o.status === "open");
        const last = list.map((c) => c.lastActivity ?? "").sort().at(-1) ?? "";
        return {
          name: list[0].companyName,
          contacts: list,
          openValue: open.reduce((s, o) => s + o.value, 0),
          wonValue: deals.filter((o) => o.status === "won").reduce((s, o) => s + o.value, 0),
          stage: open.sort((a, b) => b.value - a.value)[0],
          location: [list[0].city, list[0].state].filter(Boolean).join(", "),
          website: list.find((c) => c.website)?.website ?? "",
          last,
        };
      })
      .sort((a, b) => b.openValue + b.wonValue - (a.openValue + a.wonValue) || a.name.localeCompare(b.name));
  }, [filtered, dealsByContact]);

  const applyView = (id: string, filters: Partial<Filters>) => {
    setViewId(id);
    setF({ ...EMPTY, ...filters });
    setSelected(new Set());
  };
  const setFilter = (k: keyof Filters) => (v: string) => {
    setF({ ...f, [k]: v });
    setViewId("");
  };
  const dirty = JSON.stringify(f) !== JSON.stringify(EMPTY);

  const th = (key: SortKey, label: string, right = false) => (
    <th className={`sortable ${right ? "right" : ""}`} onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : key === "name" || key === "company" || key === "owner" ? 1 : -1 }))}>
      {label} {sort.key === key && (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
    </th>
  );

  const exportCsv = (list: Contact[]) => {
    download(
      `clients-${new Date().toISOString().slice(0, 10)}.csv`,
      csv([
        ["First name", "Last name", "Company", "Email", "Phone", "Website", "City", "State", "Source", "Tags", "Owner", "Stage", "Deal value", "Added", "Last activity"],
        ...list.map((c) => {
          const o = mainDeal(c.id);
          return [c.firstName, c.lastName, c.companyName, c.email, c.phone, c.website, c.city, c.state, c.source, c.tags.join(", "), ownerName(users, c.assignedTo), o ? (stageById.get(o.stageId) ?? "") : "", o?.value ?? "", c.dateAdded.slice(0, 10), c.lastActivity?.slice(0, 10) ?? ""];
        }),
      ]),
    );
  };

  const bulk = async (action: string, extra: Record<string, unknown> = {}) => {
    const ids = [...selected];
    try {
      const r = await api.post<{ done: number; failed: number; errors: string[] }>("/api/contacts/bulk", { ids, action, ...extra });
      toast(`${r.done} contact${r.done === 1 ? "" : "s"} updated${r.failed ? ` · ${r.failed} failed: ${r.errors[0]}` : ""}`, r.failed ? "bad" : "ok");
      setSelected(new Set());
      setModal(null);
      contacts.reload();
      if (action === "addToPipeline" || action === "delete") opps.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Bulk update failed", "bad");
    }
  };

  const allChecked = rows.length > 0 && rows.slice(0, 500).every((r) => selected.has(r.id));
  const savedViews = views.data ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Clients</h2>
          <p>
            {contacts.data
              ? mode === "people"
                ? `${rows.length.toLocaleString()} of ${contacts.data.length.toLocaleString()} contacts`
                : `${companies.length.toLocaleString()} companies`
              : "Loading contacts…"}
          </p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setModal("dupes")}><Copy /> Find duplicates</button>
          <button className="btn" onClick={() => setModal("import")}><Upload /> Import CSV</button>
          <button className="btn" onClick={() => exportCsv(rows)} disabled={!rows.length}><Download /> Export</button>
          <button className="btn primary" onClick={() => setModal("new")}><Plus /> New contact</button>
        </div>
      </div>

      <div className="chips">
        {SMART_VIEWS.map((v) => (
          <button key={v.id} className={`chip ${viewId === v.id ? "on" : ""}`} onClick={() => applyView(v.id, v.filters)}>{v.name}</button>
        ))}
        {savedViews.map((v) => (
          <span key={v.id} className={`chip ${viewId === v.id ? "on" : ""}`} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <button style={{ all: "unset", cursor: "pointer" }} onClick={() => applyView(v.id, v.filters as Partial<Filters>)}>
              <Bookmark size={11} style={{ verticalAlign: -1 }} /> {v.name}
            </button>
            <button
              style={{ all: "unset", cursor: "pointer", color: "var(--text-3)", display: "inline-flex" }}
              aria-label={`Delete view ${v.name}`}
              onClick={async () => {
                await api.del(`/api/views/${v.id}`);
                views.reload();
                if (viewId === v.id) applyView("all", {});
              }}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        {dirty && !viewId && (
          <button className="chip" onClick={() => setModal("save")}>+ Save this view</button>
        )}
      </div>

      <div className="row wrap">
        <div className="input-icon" style={{ width: 260 }}>
          <Search />
          <input className="input" placeholder="Search name, company, email, phone" value={f.q} onChange={(e) => setFilter("q")(e.target.value)} />
        </div>
        <select className="select" style={{ width: 150 }} value={f.stage} onChange={(e) => setFilter("stage")(e.target.value)} aria-label="Stage">
          <option value="">Any stage</option>
          {allStages.map((s) => <option key={s}>{s}</option>)}
        </select>
        {users.length > 0 && <OwnerSelect users={users} value={f.owner} onChange={setFilter("owner")} allowAll style={{ width: 150 }} />}
        <select className="select" style={{ width: 150 }} value={f.source} onChange={(e) => setFilter("source")(e.target.value)} aria-label="Source">
          <option value="">Any source</option>
          {allSources.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className="select" style={{ width: 140 }} value={f.tag} onChange={(e) => setFilter("tag")(e.target.value)} aria-label="Tag">
          <option value="">Any tag</option>
          {allTags.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className="select" style={{ width: 170 }} value={f.idle} onChange={(e) => setFilter("idle")(e.target.value)} aria-label="Activity">
          <option value="">Any activity</option>
          <option value="7">No activity in 7 days</option>
          <option value="30">No activity in 30 days</option>
          <option value="90">No activity in 90 days</option>
        </select>
        {dirty && <button className="btn ghost" onClick={() => applyView("all", {})}>Clear</button>}
        <span className="spacer" />
        <div className="btn-group">
          <button className={`btn ${mode === "people" ? "on" : ""}`} onClick={() => setMode("people")}><Users /> People</button>
          <button className={`btn ${mode === "companies" ? "on" : ""}`} onClick={() => setMode("companies")}><Building2 /> Companies</button>
        </div>
      </div>

      {selected.size > 0 && mode === "people" && (
        <div className="card row wrap" style={{ padding: "8px 12px", position: "sticky", top: -24, zIndex: 3, boxShadow: "var(--shadow-pop)" }}>
          <strong className="small">{selected.size} selected</strong>
          <button className="btn sm ghost" onClick={() => setSelected(new Set())}>Clear</button>
          <span className="spacer" />
          <button className="btn sm" onClick={() => setModal("tag")}><Tag /> Add tag</button>
          <button className="btn sm" onClick={() => setModal("untag")}><Tag /> Remove tag</button>
          {users.length > 0 && <button className="btn sm" onClick={() => setModal("assign")}><UserRound /> Assign owner</button>}
          <button className="btn sm" onClick={() => setModal("pipeline")}><Columns3 /> Add to pipeline</button>
          <button className="btn sm" onClick={() => exportCsv(rows.filter((r) => selected.has(r.id)))}><Download /> Export</button>
          <button className="btn sm danger" onClick={() => setModal("delete")}><Trash2 /> Delete</button>
        </div>
      )}

      {contacts.error && <ErrorState error={contacts.error} onRetry={contacts.reload} />}

      <Card flush>
        {contacts.loading && !contacts.data ? (
          <LoadingRows n={8} />
        ) : mode === "companies" ? (
          companies.length ? (
            <div className="table-wrap" style={{ maxHeight: "calc(100vh - 300px)" }}>
              <table className="table">
                <thead>
                  <tr><th>Company</th><th>Contacts</th><th>Open deal</th><th className="right">Open value</th><th className="right">Won</th><th>Location</th><th>Last activity</th></tr>
                </thead>
                <tbody>
                  {companies.map((co) => (
                    <tr key={co.name} className="clickable" onClick={() => nav(`/clients/${co.contacts[0].id}`)}>
                      <td>
                        <div className="cell-main">
                          <span className="avatar" style={{ borderRadius: 7 }}><Building2 size={14} /></span>
                          <div style={{ minWidth: 0 }}>
                            <div className="t ellipsis">{co.name}</div>
                            <div className="s ellipsis">{co.website.replace(/^https?:\/\/(www\.)?/, "") || "No website"}</div>
                          </div>
                        </div>
                      </td>
                      <td className="small">
                        {co.contacts.slice(0, 2).map((c, i) => (
                          <span key={c.id}>
                            {i > 0 && ", "}
                            <Link to={`/clients/${c.id}`} onClick={(e) => e.stopPropagation()}>{c.name}</Link>
                          </span>
                        ))}
                        {co.contacts.length > 2 && <span className="faint"> +{co.contacts.length - 2}</span>}
                      </td>
                      <td>{co.stage ? <span className="badge">{stageById.get(co.stage.stageId) ?? "—"}</span> : <span className="faint">—</span>}</td>
                      <td className="right num">{co.openValue ? money(co.openValue) : <span className="faint">—</span>}</td>
                      <td className="right num">{co.wonValue ? money(co.wonValue) : <span className="faint">—</span>}</td>
                      <td className="small muted">{co.location || "—"}</td>
                      <td className="small muted">{relTime(co.last)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon={<Building2 />} title="No companies match">Contacts without a company name aren't grouped here.</Empty>
          )
        ) : rows.length ? (
          <div className="table-wrap" style={{ maxHeight: "calc(100vh - 300px)" }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <input type="checkbox" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(rows.slice(0, 500).map((r) => r.id)))} aria-label="Select all" />
                  </th>
                  {th("name", "Name")}
                  {th("company", "Company")}
                  <th>Phone</th>
                  <th>Stage</th>
                  {th("value", "Deal", true)}
                  {users.length > 0 && th("owner", "Owner")}
                  <th>Tags</th>
                  {th("added", "Added")}
                  {th("activity", "Last activity")}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 500).map((c) => {
                  const o = mainDeal(c.id);
                  return (
                    <tr key={c.id} className="clickable" onClick={() => nav(`/clients/${c.id}`)} style={{ background: selected.has(c.id) ? "var(--accent-soft)" : undefined }}>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.has(c.id)}
                          onChange={() => {
                            const n = new Set(selected);
                            if (n.has(c.id)) n.delete(c.id);
                            else n.add(c.id);
                            setSelected(n);
                          }}
                          aria-label={`Select ${c.name}`}
                        />
                      </td>
                      <td>
                        <div className="cell-main">
                          <Avatar name={c.name} />
                          <div style={{ minWidth: 0 }}>
                            <div className="t ellipsis">{c.name}</div>
                            <div className="s ellipsis">{c.email || "No email"}</div>
                          </div>
                        </div>
                      </td>
                      <td className="ellipsis" style={{ maxWidth: 190 }}>{c.companyName || <span className="faint">—</span>}</td>
                      <td className="num small" style={{ whiteSpace: "nowrap" }}>{c.phone ? phoneDisplay(c.phone) : <span className="faint">—</span>}</td>
                      <td>{o ? <span className={`badge ${o.status === "won" ? "good" : ""}`}>{o.status === "won" ? "Customer" : (stageById.get(o.stageId) ?? "—")}</span> : <span className="faint">—</span>}</td>
                      <td className="right num">{o ? money(o.value) : <span className="faint">—</span>}</td>
                      {users.length > 0 && <td className="small ellipsis" style={{ maxWidth: 130 }}>{ownerName(users, c.assignedTo) || <span className="faint">—</span>}</td>}
                      <td>
                        <div className="row" style={{ gap: 4, maxWidth: 170, overflow: "hidden" }} title={c.tags.join(", ")}>
                          {c.tags.slice(0, 1).map((t) => <span className="tag ellipsis" style={{ maxWidth: 130, display: "inline-block", lineHeight: "18px" }} key={t}>{t}</span>)}
                          {c.tags.length > 1 && <span className="faint small">+{c.tags.length - 1}</span>}
                        </div>
                      </td>
                      <td className="small muted" style={{ whiteSpace: "nowrap" }}>{shortDate(c.dateAdded)}</td>
                      <td className="small muted" style={{ whiteSpace: "nowrap" }}>{relTime(c.lastActivity)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {c.phone && (
                          <button className="btn sm ghost icon" title={`Call ${c.name}`} onClick={() => nav(`/calls/${c.id}`)}>
                            <Phone />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length > 500 && <div className="faint small" style={{ padding: 12 }}>Showing the first 500 — narrow with search, filters or a view.</div>}
          </div>
        ) : (
          <Empty icon={<Users />} title={contacts.data?.length ? "No contacts match" : "No contacts yet"}>
            {contacts.data?.length ? "Try a different view or clear the filters." : "Add one, import a CSV, or find new clients from the prospecting page."}
          </Empty>
        )}
      </Card>

      {modal === "new" && <NewContactModal onClose={() => setModal(null)} onCreated={(c) => nav(`/clients/${c.id}`)} />}
      {modal === "import" && <ImportModal users={users} onClose={() => setModal(null)} onDone={() => contacts.reload()} />}
      {modal === "dupes" && <DuplicatesModal onClose={() => setModal(null)} onChanged={() => (contacts.reload(), opps.reload())} />}
      {modal === "save" && (
        <SaveViewModal
          onClose={() => setModal(null)}
          onSave={async (name) => {
            const v = await api.post<SavedView>("/api/views", { name, filters: f });
            views.reload();
            setViewId(v.id);
            toast(`Saved view “${v.name}”`);
          }}
        />
      )}
      {(modal === "tag" || modal === "untag") && (
        <TagModal remove={modal === "untag"} count={selected.size} tags={allTags} onClose={() => setModal(null)} onApply={(tag) => bulk(modal === "tag" ? "addTag" : "removeTag", { tag })} />
      )}
      {modal === "assign" && <AssignModal users={users} count={selected.size} onClose={() => setModal(null)} onApply={(assignedTo) => bulk("assign", { assignedTo })} />}
      {modal === "pipeline" && <BulkPipelineModal pipelines={pipelines.data ?? []} count={selected.size} onClose={() => setModal(null)} onApply={(p) => bulk("addToPipeline", p)} />}
      {modal === "delete" && (
        <ConfirmModal title={`Delete ${selected.size} contact${selected.size === 1 ? "" : "s"}?`} confirmLabel="Delete permanently" onClose={() => setModal(null)} onConfirm={() => bulk("delete")}>
          This permanently deletes the selected contacts from GoHighLevel, along with their notes, tasks and conversations. This can't be undone.
        </ConfirmModal>
      )}
    </div>
  );
}

function SaveViewModal({ onClose, onSave }: { onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  return (
    <Modal title="Save view" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!name.trim()} onClick={() => onSave(name.trim()).then(onClose)}>Save view</button></>}>
      <Field label="Name" hint="Saves the current search and filters as a one-click view."><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Dentists in proposal" onKeyDown={(e) => e.key === "Enter" && name.trim() && onSave(name.trim()).then(onClose)} /></Field>
    </Modal>
  );
}

function TagModal({ remove, count, tags, onClose, onApply }: { remove: boolean; count: number; tags: string[]; onClose: () => void; onApply: (t: string) => void }) {
  const [tag, setTag] = useState("");
  return (
    <Modal
      title={`${remove ? "Remove a tag from" : "Tag"} ${count} contact${count === 1 ? "" : "s"}`}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => onApply(tag.trim())} disabled={!tag.trim()}>{remove ? "Remove tag" : "Add tag"}</button></>}
    >
      <Field label="Tag" hint="Tags sync to GoHighLevel and can trigger workflows there.">
        <input className="input" list="taglist" value={tag} onChange={(e) => setTag(e.target.value)} autoFocus onKeyDown={(e) => e.key === "Enter" && tag.trim() && onApply(tag.trim())} />
        <datalist id="taglist">{tags.map((t) => <option key={t} value={t} />)}</datalist>
      </Field>
    </Modal>
  );
}

function AssignModal({ users, count, onClose, onApply }: { users: User[]; count: number; onClose: () => void; onApply: (id: string) => void }) {
  const [owner, setOwner] = useState(users[0]?.id ?? "");
  return (
    <Modal title={`Assign ${count} contact${count === 1 ? "" : "s"}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => onApply(owner)}>Assign</button></>}>
      <Field label="Owner"><OwnerSelect users={users} value={owner} onChange={setOwner} /></Field>
    </Modal>
  );
}

function BulkPipelineModal({ pipelines, count, onClose, onApply }: { pipelines: Pipeline[]; count: number; onClose: () => void; onApply: (p: { pipelineId: string; stageId: string; value: number }) => void }) {
  const [pid, setPid] = useState(pipelines[0]?.id ?? "");
  const pl = pipelines.find((p) => p.id === pid);
  const [sid, setSid] = useState(pl?.stages[0]?.id ?? "");
  const [value, setValue] = useState("");
  return (
    <Modal title={`Create deals for ${count} contact${count === 1 ? "" : "s"}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => onApply({ pipelineId: pid, stageId: sid, value: Number(value) || 0 })} disabled={!pid}>Create deals</button></>}>
      <div className="grid-3">
        <Field label="Pipeline">
          <select className="select" value={pid} onChange={(e) => (setPid(e.target.value), setSid(pipelines.find((p) => p.id === e.target.value)?.stages[0]?.id ?? ""))}>
            {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Stage">
          <select className="select" value={sid} onChange={(e) => setSid(e.target.value)}>{pl?.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        </Field>
        <Field label="Value each ($)"><input className="input" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function ImportModal({ users, onClose, onDone }: { users: User[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [table, setTable] = useState<string[][] | null>(null);
  const [map, setMap] = useState<Record<number, ImportKey | "">>({});
  const [tags, setTags] = useState("imported");
  const [owner, setOwner] = useState("");
  const [skipDupes, setSkipDupes] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; skipped: number; failed: { row: number; error: string }[] } | null>(null);

  const load = async (file: File) => {
    const rows = parseCsv(await file.text());
    if (rows.length < 2) {
      toast("That file has no data rows", "bad");
      return;
    }
    setFileName(file.name);
    setTable(rows);
    setMap(guessMapping(rows[0]));
  };

  const headers = table?.[0] ?? [];
  const body = table?.slice(1) ?? [];
  const toContact = (r: string[]) => {
    const c: Record<string, unknown> = {};
    headers.forEach((_, i) => {
      const key = map[i];
      const v = (r[i] ?? "").trim();
      if (!key || !v) return;
      if (key === "fullName") {
        const parts = v.split(/\s+/);
        c.firstName ??= parts[0];
        c.lastName ??= parts.slice(1).join(" ");
      } else if (key === "tags") c.tags = v.split(/[,;|]/).map((t) => t.trim()).filter(Boolean);
      else c[key] = v;
    });
    return c;
  };
  const mapped = Object.values(map).filter(Boolean).length;

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<typeof result>("/api/contacts/import", {
        rows: body.map(toContact),
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        assignedTo: owner,
        skipDuplicates: skipDupes,
      });
      setResult(r);
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Import failed", "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title="Import contacts"
      onClose={onClose}
      footer={
        result ? (
          <button className="btn primary" onClick={onClose}>Done</button>
        ) : (
          <>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!table || !mapped || busy} onClick={run}>{busy ? `Importing ${body.length}…` : `Import ${body.length.toLocaleString()} contact${body.length === 1 ? "" : "s"}`}</button>
          </>
        )
      }
    >
      {result ? (
        <div className="stack">
          <div className="grid-3">
            <div><div className="faint small">Created</div><div className="kpi-value">{result.created}</div></div>
            <div><div className="faint small">Skipped (duplicates / empty)</div><div className="kpi-value">{result.skipped}</div></div>
            <div><div className="faint small">Failed</div><div className="kpi-value" style={{ color: result.failed.length ? "var(--bad)" : undefined }}>{result.failed.length}</div></div>
          </div>
          {result.failed.length > 0 && (
            <Banner tone="bad">
              {result.failed.slice(0, 5).map((f) => <div key={f.row}>Row {f.row}: {f.error}</div>)}
              {result.failed.length > 5 && <div>…and {result.failed.length - 5} more</div>}
            </Banner>
          )}
        </div>
      ) : !table ? (
        <div
          className="empty"
          style={{ border: "1.5px dashed var(--border-strong)", borderRadius: 8, cursor: "pointer" }}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file) void load(file);
          }}
        >
          <Upload />
          <strong>Drop a CSV here, or click to choose</strong>
          <div className="small">Exports from spreadsheets, other CRMs or lead lists work. Up to 2,000 rows per import.</div>
          <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
        </div>
      ) : (
        <>
          <div className="small muted">{fileName} · {body.length.toLocaleString()} rows · match each column to a CRM field</div>
          <div className="table-wrap" style={{ maxHeight: 280, border: "1px solid var(--border)", borderRadius: 6 }}>
            <table className="table">
              <thead>
                <tr><th>Column in file</th><th>Sample</th><th style={{ width: 220 }}>Import as</th></tr>
              </thead>
              <tbody>
                {headers.map((h, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 550 }}>{h || `Column ${i + 1}`}</td>
                    <td className="small muted ellipsis" style={{ maxWidth: 260 }}>{body.slice(0, 2).map((r) => r[i]).filter(Boolean).join(" · ") || "—"}</td>
                    <td>
                      <select className="select" style={{ height: 30 }} value={map[i] ?? ""} onChange={(e) => setMap({ ...map, [i]: e.target.value as ImportKey | "" })}>
                        <option value="">Don't import</option>
                        {IMPORT_FIELDS.map((fld) => <option key={fld.key} value={fld.key}>{fld.label}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid-3">
            <Field label="Tag every contact" hint="Comma separated"><input className="input" value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
            <Field label="Owner"><OwnerSelect users={users} value={owner} onChange={setOwner} /></Field>
            <label className="row small" style={{ alignSelf: "end", height: 34 }}>
              <input type="checkbox" checked={skipDupes} onChange={(e) => setSkipDupes(e.target.checked)} /> Skip existing emails & phones
            </label>
          </div>
          {!mapped && <Banner tone="warn">Map at least one column (name, email or phone) to import.</Banner>}
        </>
      )}
    </Modal>
  );
}

function DuplicatesModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const groups = useAsync(() => api.get<{ reason: string; contacts: Contact[] }[]>("/api/contacts-duplicates"));
  const [deleting, setDeleting] = useState<Contact | null>(null);
  return (
    <Modal title="Possible duplicates" onClose={onClose} wide>
      {groups.loading && !groups.data ? (
        <LoadingRows n={4} />
      ) : groups.data?.length ? (
        <div className="stack">
          <div className="small muted">Contacts that share an email, a phone number, or a name at the same company. Open each to compare, then delete the one you don't need. Move any notes you want to keep first.</div>
          {groups.data.map((g, i) => (
            <div key={i} className="card">
              <div className="card-head"><h3 className="small">{g.reason}</h3></div>
              <div className="list" style={{ paddingTop: 6 }}>
                {g.contacts.map((c) => (
                  <div className="list-item" key={c.id}>
                    <Avatar name={c.name} />
                    <div style={{ minWidth: 0 }}>
                      <Link to={`/clients/${c.id}`} className="t" onClick={onClose}>{c.name}</Link>
                      <div className="s ellipsis">{[c.companyName, c.email, c.phone].filter(Boolean).join(" · ")}</div>
                    </div>
                    <span className="faint small" style={{ marginLeft: "auto" }}>Added {shortDate(c.dateAdded)}</span>
                    <button className="btn sm ghost danger" onClick={() => setDeleting(c)}><Trash2 /> Delete</button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Empty icon={<Copy />} title="No duplicates found">Every contact has a unique email and phone number.</Empty>
      )}
      {deleting && (
        <ConfirmModal
          title={`Delete ${deleting.name}?`}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.del(`/api/contacts/${deleting.id}`);
            toast(`${deleting.name} deleted`);
            groups.reload();
            onChanged();
          }}
        >
          Permanently deletes this contact and its notes, tasks and conversations from GoHighLevel.
        </ConfirmModal>
      )}
    </Modal>
  );
}

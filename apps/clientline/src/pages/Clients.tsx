import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowDown, ArrowUp, Download, Phone, Plus, Search, Tag, Users } from "lucide-react";
import { api, type Contact, type Opportunity, type Pipeline } from "../lib/api.ts";
import { money, phoneDisplay, relTime, shortDate } from "../lib/format.ts";
import { Avatar, Card, Empty, ErrorState, Field, LoadingRows, Modal, useAsync, useToast } from "../components/ui.tsx";

type SortKey = "name" | "company" | "value" | "added" | "activity";

export function NewContactModal({ onClose, onCreated, initial }: { onClose: () => void; onCreated: (c: Contact) => void; initial?: Partial<Contact> }) {
  const toast = useToast();
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
      <div className="grid-2">
        <Field label="Source"><input className="input" value={f.source} onChange={set("source")} /></Field>
        <Field label="Tags" hint="Comma separated"><input className="input" value={f.tags} onChange={set("tags")} /></Field>
      </div>
      <div className="grid-3">
        <Field label="Add to pipeline">
          <select className="select" value={f.pipelineId} onChange={set("pipelineId")}>
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

export function Clients() {
  const nav = useNavigate();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [source, setSource] = useState("");
  const [stage, setStage] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "added", dir: -1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [tagging, setTagging] = useState(false);
  const [newTag, setNewTag] = useState("");

  const contacts = useAsync(() => api.get<Contact[]>("/api/contacts?limit=2000"));
  const opps = useAsync(() => api.get<Opportunity[]>("/api/opportunities"));
  const pipelines = useAsync(() => api.get<Pipeline[]>("/api/pipelines"));

  const stageById = useMemo(() => new Map((pipelines.data ?? []).flatMap((p) => p.stages.map((s) => [s.id, s.name] as const))), [pipelines.data]);
  const oppByContact = useMemo(() => {
    const m = new Map<string, Opportunity>();
    for (const o of opps.data ?? []) {
      if (o.status === "lost" || o.status === "abandoned") continue;
      const prev = m.get(o.contactId);
      if (!prev || o.value > prev.value) m.set(o.contactId, o);
    }
    return m;
  }, [opps.data]);

  const allTags = useMemo(() => [...new Set((contacts.data ?? []).flatMap((c) => c.tags))].sort(), [contacts.data]);
  const allSources = useMemo(() => [...new Set((contacts.data ?? []).map((c) => c.source).filter(Boolean))].sort(), [contacts.data]);
  const allStages = useMemo(() => [...new Set([...oppByContact.values()].map((o) => stageById.get(o.stageId) ?? ""))].filter(Boolean), [oppByContact, stageById]);

  const rows = useMemo(() => {
    const term = q.toLowerCase().trim();
    const list = (contacts.data ?? []).filter((c) => {
      if (term && ![c.name, c.companyName, c.email, c.phone, c.city, ...c.tags].join(" ").toLowerCase().includes(term)) return false;
      if (tag && !c.tags.includes(tag)) return false;
      if (source && c.source !== source) return false;
      if (stage) {
        const o = oppByContact.get(c.id);
        if (!o || stageById.get(o.stageId) !== stage) return false;
      }
      return true;
    });
    const val = (c: Contact): string | number => {
      switch (sort.key) {
        case "name": return c.name.toLowerCase();
        case "company": return c.companyName.toLowerCase();
        case "value": return oppByContact.get(c.id)?.value ?? -1;
        case "added": return c.dateAdded;
        case "activity": return c.lastActivity ?? "";
      }
    };
    return [...list].sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * sort.dir);
  }, [contacts.data, q, tag, source, stage, sort, oppByContact, stageById]);

  const th = (key: SortKey, label: string, right = false) => (
    <th className={`sortable ${right ? "right" : ""}`} onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : key === "name" || key === "company" ? 1 : -1 }))}>
      {label} {sort.key === key && (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
    </th>
  );

  const exportCsv = () => {
    const data = csv([
      ["Name", "Company", "Email", "Phone", "City", "State", "Source", "Tags", "Stage", "Deal value", "Added"],
      ...rows.map((c) => {
        const o = oppByContact.get(c.id);
        return [c.name, c.companyName, c.email, c.phone, c.city, c.state, c.source, c.tags.join("; "), o ? (stageById.get(o.stageId) ?? "") : "", o?.value ?? "", c.dateAdded.slice(0, 10)];
      }),
    ]);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data], { type: "text/csv" }));
    a.download = `clients-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const applyTag = async () => {
    const t = newTag.trim();
    if (!t) return;
    try {
      await Promise.all([...selected].map((id) => api.post(`/api/contacts/${id}/tags`, { tags: [t] })));
      toast(`Tagged ${selected.size} contact${selected.size === 1 ? "" : "s"} “${t}”`);
      setSelected(new Set());
      setTagging(false);
      setNewTag("");
      contacts.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Tagging failed", "bad");
    }
  };

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Clients</h2>
          <p>{contacts.data ? `${rows.length.toLocaleString()} of ${contacts.data.length.toLocaleString()} contacts` : "Loading contacts…"}</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={exportCsv} disabled={!rows.length}><Download /> Export CSV</button>
          <button className="btn primary" onClick={() => setAdding(true)}><Plus /> New contact</button>
        </div>
      </div>

      <div className="row wrap">
        <div className="input-icon" style={{ width: 300 }}>
          <Search />
          <input className="input" placeholder="Search name, company, email, phone, tag" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="select" style={{ width: 170 }} value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Stage">
          <option value="">All stages</option>
          {allStages.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className="select" style={{ width: 170 }} value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
          <option value="">All sources</option>
          {allSources.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className="select" style={{ width: 170 }} value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag">
          <option value="">All tags</option>
          {allTags.map((s) => <option key={s}>{s}</option>)}
        </select>
        {(q || tag || source || stage) && <button className="btn ghost" onClick={() => (setQ(""), setTag(""), setSource(""), setStage(""))}>Clear</button>}
        <span className="spacer" />
        {selected.size > 0 && (
          <>
            <span className="small muted">{selected.size} selected</span>
            <button className="btn sm" onClick={() => setTagging(true)}><Tag /> Add tag</button>
          </>
        )}
      </div>

      {contacts.error && <ErrorState error={contacts.error} onRetry={contacts.reload} />}

      <Card flush>
        {contacts.loading && !contacts.data ? (
          <LoadingRows n={8} />
        ) : rows.length ? (
          <div className="table-wrap" style={{ maxHeight: "calc(100vh - 260px)" }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <input type="checkbox" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.id)))} aria-label="Select all" />
                  </th>
                  {th("name", "Name")}
                  {th("company", "Company")}
                  <th>Phone</th>
                  <th>Stage</th>
                  {th("value", "Deal", true)}
                  <th>Tags</th>
                  <th>Source</th>
                  {th("added", "Added")}
                  {th("activity", "Last activity")}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 500).map((c) => {
                  const o = oppByContact.get(c.id);
                  return (
                    <tr key={c.id} className="clickable" onClick={() => nav(`/clients/${c.id}`)}>
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
                      <td className="ellipsis" style={{ maxWidth: 200 }}>{c.companyName || <span className="faint">—</span>}</td>
                      <td className="num small" style={{ whiteSpace: "nowrap" }}>{c.phone ? phoneDisplay(c.phone) : <span className="faint">—</span>}</td>
                      <td>{o ? <span className={`badge ${o.status === "won" ? "good" : ""}`}>{stageById.get(o.stageId) ?? "—"}</span> : <span className="faint">—</span>}</td>
                      <td className="right num">{o ? money(o.value) : <span className="faint">—</span>}</td>
                      <td>
                        <div className="row" style={{ gap: 4, maxWidth: 200, overflow: "hidden" }}>
                          {c.tags.slice(0, 2).map((t) => <span className="tag" key={t}>{t}</span>)}
                          {c.tags.length > 2 && <span className="faint small">+{c.tags.length - 2}</span>}
                        </div>
                      </td>
                      <td className="small muted ellipsis" style={{ maxWidth: 140 }}>{c.source || "—"}</td>
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
            {rows.length > 500 && <div className="faint small" style={{ padding: 12 }}>Showing the first 500 — narrow with search or filters.</div>}
          </div>
        ) : (
          <Empty icon={<Users />} title={contacts.data?.length ? "No contacts match" : "No contacts yet"}>
            {contacts.data?.length ? "Try a different search or clear the filters." : "Add one, or find new clients from the prospecting page."}
          </Empty>
        )}
      </Card>

      {adding && <NewContactModal onClose={() => setAdding(false)} onCreated={(c) => nav(`/clients/${c.id}`)} />}
      {tagging && (
        <Modal
          title={`Tag ${selected.size} contact${selected.size === 1 ? "" : "s"}`}
          onClose={() => setTagging(false)}
          footer={
            <>
              <button className="btn" onClick={() => setTagging(false)}>Cancel</button>
              <button className="btn primary" onClick={applyTag} disabled={!newTag.trim()}>Apply tag</button>
            </>
          }
        >
          <Field label="Tag" hint="Synced to GoHighLevel — use it to trigger workflows there.">
            <input className="input" list="taglist" value={newTag} onChange={(e) => setNewTag(e.target.value)} autoFocus onKeyDown={(e) => e.key === "Enter" && applyTag()} />
            <datalist id="taglist">{allTags.map((t) => <option key={t} value={t} />)}</datalist>
          </Field>
        </Modal>
      )}
    </div>
  );
}

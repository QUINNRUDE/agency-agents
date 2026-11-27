import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CheckCircle2, Coins, ExternalLink, Globe, Loader2, Mail, MapPin, Phone, Plus, ScanSearch, Search, Share2, Sparkles, Star, Telescope, X, XCircle, AlertTriangle } from "lucide-react";
import { api, type LeadJob, type Pipeline, type Prospect } from "../lib/api.ts";
import { phoneDisplay, relTime } from "../lib/format.ts";
import { AiPanel } from "../components/AiPanel.tsx";
import { Banner, Card, Empty, Field, LoadingRows, Modal, ScoreBadge, useAsync, useToast } from "../components/ui.tsx";
import { useApp } from "../App.tsx";

const NICHES = ["Dentists", "Roofers", "Med spas", "HVAC", "Plumbers", "Chiropractors", "Law firms", "Landscapers", "Auto repair", "Real estate agents"];
type Source = "free" | "apify" | "google";
const SIZES: Record<Source, number[]> = { free: [50, 100, 200], apify: [25, 50, 100, 150, 250], google: [20, 40, 60] };
const DEFAULT_SIZE: Record<Source, number> = { free: 100, apify: 50, google: 40 };

interface Usage {
  connected: boolean;
  pricePerLead: number;
  plan?: string;
  free?: boolean;
  creditUsd?: number;
  usedUsd?: number;
  leftUsd?: number;
  resetsAt?: string;
  leadsLeft?: number;
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const isRunning = (j: LeadJob | null) => j?.status === "scraping" || j?.status === "finding-contacts";

export function Prospecting() {
  const { status } = useApp();
  const toast = useToast();
  const apifyConnected = Boolean(status?.has.apify);
  const placesConnected = Boolean(status?.has.places);
  const [source, setSource] = useState<Source>("free");
  useEffect(() => {
    if (apifyConnected) setSource((s) => (s === "free" ? "apify" : s));
  }, [apifyConnected]);
  const apify = source === "apify";
  const usage = useAsync(() => (apifyConnected ? api.get<Usage>("/api/lead-finder/usage") : Promise.resolve<Usage>({ connected: false, pricePerLead: 0.004 })), [apifyConnected]);
  const [job, setJob] = useState<LeadJob | null>(null);
  const [niche, setNiche] = useState("");
  const [location, setLocation] = useState("");
  const [max, setMax] = useState(100);
  const [minRating, setMinRating] = useState(0);
  const [noSite, setNoSite] = useState(false);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<Prospect[] | null>(null);
  const [sample, setSample] = useState(false);
  const [view, setView] = useState<"results" | "saved">("results");
  const [open, setOpen] = useState<Prospect | null>(null);
  const [auditing, setAuditing] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAdding, setBulkAdding] = useState(false);
  const saved = useAsync(() => api.get<Prospect[]>("/api/prospects"));
  const pipelines = useAsync(() => api.get<Pipeline[]>("/api/pipelines"));

  useEffect(() => {
    if (!SIZES[source].includes(max)) setMax(DEFAULT_SIZE[source]);
  }, [source]);

  // A search keeps running on the server if you leave the page: pick it back up.
  useEffect(() => {
    api
      .get<LeadJob[]>("/api/lead-jobs")
      .then((list) => {
        const live = list.find((j) => isRunning(j));
        if (live) setJob(live);
      })
      .catch(() => undefined);
  }, []);

  const running = isRunning(job);
  useEffect(() => {
    if (!job || !running) return;
    let stopped = false;
    const poll = async () => {
      try {
        const r = await api.get<{ job: LeadJob; prospects: Prospect[] }>(`/api/lead-jobs/${job.id}`);
        if (stopped) return;
        setJob(r.job);
        if (r.prospects.length) {
          setResults(r.prospects);
          setSample(false);
        }
        if (r.job.status === "done") {
          toast(`Found ${r.job.found} businesses, ${r.job.emailsFound} with an email`);
          saved.reload();
          usage.reload();
        } else if (r.job.status === "failed") {
          toast(r.job.error || "The search didn't finish. Try again.", "bad");
          usage.reload();
        }
      } catch {
        /* a slow poll is retried on the next tick */
      }
    };
    const t = setInterval(() => void poll(), 4000);
    void poll();
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [job?.id, running]);

  const search = async () => {
    if (!niche.trim() || !location.trim()) return;
    setSearching(true);
    setView("results");
    setSelected(new Set());
    try {
      const r = await api.post<{ prospects: Prospect[]; sample: boolean; job?: LeadJob }>("/api/prospects/search", { source, niche, location, maxResults: max, minRating: minRating || undefined, onlyNoWebsite: noSite });
      setResults(r.prospects);
      setSample(r.sample);
      if (r.job) setJob(r.job);
      if (r.prospects.length) saved.reload();
      if (source === "free" && !r.prospects.length) toast("OpenStreetMap has no listings for that here. Try a nearby city, different wording, or Google Maps via Apify.", "bad");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Search failed", "bad");
    } finally {
      setSearching(false);
    }
  };

  const replace = (p: Prospect) => {
    setResults((r) => r?.map((x) => (x.id === p.id ? p : x)) ?? r);
    saved.setData((s) => s?.map((x) => (x.id === p.id ? p : x)) ?? s);
    setOpen((o) => (o?.id === p.id ? p : o));
  };

  const audit = async (p: Prospect) => {
    setAuditing((s) => new Set(s).add(p.id));
    try {
      replace(await api.post<Prospect>(`/api/prospects/${p.id}/audit`));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Audit failed", "bad");
    } finally {
      setAuditing((s) => {
        const n = new Set(s);
        n.delete(p.id);
        return n;
      });
    }
  };

  const auditSelected = async () => {
    const list = rows.filter((r) => selected.has(r.id) && r.website && !r.audit);
    for (let i = 0; i < list.length; i += 4) await Promise.all(list.slice(i, i + 4).map(audit));
    toast(`Audited ${list.length} website${list.length === 1 ? "" : "s"}`);
  };

  const dismiss = async (p: Prospect) => {
    replace(await api.patch<Prospect>(`/api/prospects/${p.id}`, { status: p.status === "dismissed" ? "new" : "dismissed" }));
  };

  const rows = useMemo(() => {
    // Rating and "no website" filters apply to the latest search here (Apify searches return everything).
    const list = view === "results" ? (results ?? []).filter((p) => (!minRating || p.rating === null || p.rating >= minRating) && (!noSite || !p.website)) : (saved.data ?? []);
    return [...list].sort((a, b) => Number(a.status === "dismissed") - Number(b.status === "dismissed") || b.score - a.score);
  }, [view, results, saved.data, minRating, noSite]);
  const u = usage.data;
  const estimate = max * (u?.pricePerLead ?? 0.004);

  const counts = { results: results?.length ?? 0, saved: saved.data?.length ?? 0 };
  const allChecked = rows.length > 0 && rows.filter((r) => r.status === "new").every((r) => selected.has(r.id));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Find clients</h2>
          <p>Find local businesses with the free scraper or Google Maps, get their phone and email, and add the best fits to your CRM.</p>
        </div>
      </div>

      <Card>
        <div className="stack">
          <div className="source-pick" role="radiogroup" aria-label="Where to search">
            <button role="radio" aria-checked={source === "free"} className={`source-opt ${source === "free" ? "on" : ""}`} onClick={() => setSource("free")}>
              <b>Free scraper</b>
              <span>OpenStreetMap · no key, no limit</span>
            </button>
            <button role="radio" aria-checked={source === "apify"} className={`source-opt ${source === "apify" ? "on" : ""}`} onClick={() => (apifyConnected ? setSource("apify") : undefined)} disabled={!apifyConnected}>
              <b>Google Maps</b>
              <span>{apifyConnected ? "Apify · free monthly credit" : "Connect free Apify first"}</span>
            </button>
            {placesConnected && (
              <button role="radio" aria-checked={source === "google"} className={`source-opt ${source === "google" ? "on" : ""}`} onClick={() => setSource("google")}>
                <b>Google Places</b>
                <span>Your Places API key</span>
              </button>
            )}
          </div>
          {source === "free" && (
            <div className="faint small">
              Free and unlimited. OpenStreetMap lists fewer businesses than Google and has no ratings, so search a few nearby cities for more. Bloom AI checks each website for an email.{" "}
              {!apifyConnected && <>For Google Maps data, <Link to="/settings#leads">connect a free Apify account</Link>.</>} Business data ©{" "}
              <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>.
            </div>
          )}
          <div className="row wrap" style={{ alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 220px" }}>
              <Field label="Business type">
                <input className="input" placeholder="e.g. dentists, roofers, med spas" value={niche} onChange={(e) => setNiche(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} />
              </Field>
            </div>
            <div style={{ flex: "1 1 220px" }}>
              <Field label="Location">
                <input className="input" placeholder="City, state or ZIP" value={location} onChange={(e) => setLocation(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} />
              </Field>
            </div>
            <div style={{ width: 110 }}>
              <Field label="Max results">
                <select className="select" value={max} onChange={(e) => setMax(Number(e.target.value))}>
                  {SIZES[source].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </Field>
            </div>
            <div style={{ width: 120 }}>
              <Field label="Min rating">
                <select className="select" value={minRating} onChange={(e) => setMinRating(Number(e.target.value))}>
                  <option value={0}>Any</option>
                  {[3, 3.5, 4, 4.5].map((n) => <option key={n} value={n}>{n}+</option>)}
                </select>
              </Field>
            </div>
            <label className="row small" style={{ height: 34 }}>
              <input type="checkbox" checked={noSite} onChange={(e) => setNoSite(e.target.checked)} /> No website only
            </label>
            <button className="btn primary lg" onClick={search} disabled={searching || running || !niche.trim() || !location.trim()}>
              {searching ? <Loader2 className="spin" style={{ animation: "spin 0.8s linear infinite" }} /> : <Search />} Search
            </button>
          </div>
          <div className="chips">
            {NICHES.map((n) => (
              <button key={n} className={`chip ${niche === n ? "on" : ""}`} onClick={() => setNiche(n)}>{n}</button>
            ))}
          </div>
        </div>
      </Card>

      {apify && u?.connected && u.leftUsd !== undefined && u.creditUsd !== undefined && (
        <div className="card credit-meter">
          <span className="ichip grad"><Coins /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
              <b className="small">Free Apify credit this month</b>
              <span className="small num">{usd(u.leftUsd)} of {usd(u.creditUsd)} left</span>
            </div>
            <div className="meter" aria-hidden><span style={{ width: `${Math.max(0, Math.min(100, (u.leftUsd / Math.max(0.01, u.creditUsd)) * 100))}%` }} /></div>
            <div className="faint small">
              About {(u.leadsLeft ?? 0).toLocaleString("en-US")} more leads{u.resetsAt ? `, resets ${new Date(u.resetsAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}. This search: up to {max} leads, about {usd(estimate)}. Emails are found on each website for free.
            </div>
          </div>
        </div>
      )}
      {apify && usage.error && <Banner tone="bad">Apify: {usage.error} <Link to="/settings#leads">Check the token</Link></Banner>}
      {job && running && (
        <div className="card job-progress" role="status">
          <Loader2 className="spin" style={{ animation: "spin 0.8s linear infinite" }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <b className="small">
              {job.status === "scraping" ? `Searching Google Maps for “${job.niche}” in ${job.location}…` : `Found ${job.found} businesses. Checking their websites for emails…`}
            </b>
            <div className="faint small">
              {job.status === "scraping"
                ? "This usually takes 1 to 3 minutes. You can leave this page: the results are saved."
                : `${job.contactsChecked} of ${job.contactsToCheck} websites checked, ${job.emailsFound} emails found so far.`}
            </div>
            {job.status === "finding-contacts" && <div className="meter"><span style={{ width: `${job.contactsToCheck ? Math.round((job.contactsChecked / job.contactsToCheck) * 100) : 100}%` }} /></div>}
          </div>
        </div>
      )}
      {sample && results && <Banner tone="warn">These are sample results, not real businesses.</Banner>}

      <div className="row wrap">
        <div className="btn-group">
          <button className={`btn ${view === "results" ? "on" : ""}`} onClick={() => setView("results")}>Latest search <span className="faint num" style={{ marginLeft: 4 }}>{counts.results}</span></button>
          <button className={`btn ${view === "saved" ? "on" : ""}`} onClick={() => setView("saved")}>All prospects <span className="faint num" style={{ marginLeft: 4 }}>{counts.saved}</span></button>
        </div>
        <span className="spacer" />
        {selected.size > 0 && (
          <>
            <span className="small muted">{selected.size} selected</span>
            <button className="btn sm" onClick={auditSelected}><ScanSearch /> Audit websites</button>
            <button className="btn sm primary" onClick={() => setBulkAdding(true)}><Plus /> Add to CRM</button>
          </>
        )}
      </div>

      <Card flush>
        {searching || (job?.status === "scraping" && view === "results" && !results?.length) ? (
          <LoadingRows n={8} />
        ) : rows.length ? (
          <div className="table-wrap" style={{ maxHeight: "calc(100vh - 300px)" }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <input type="checkbox" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(rows.filter((r) => r.status === "new").map((r) => r.id)))} aria-label="Select all" />
                  </th>
                  <th title="Opportunity score: how much this business likely needs help">Score</th>
                  <th>Business</th>
                  <th>Rating</th>
                  <th>Website</th>
                  <th>Phone · email</th>
                  <th>Signals</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="clickable" style={{ opacity: p.status === "dismissed" ? 0.45 : 1 }} onClick={() => setOpen(p)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      {p.status === "new" && (
                        <input type="checkbox" checked={selected.has(p.id)} onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })} aria-label={`Select ${p.name}`} />
                      )}
                    </td>
                    <td><ScoreBadge score={p.score} /></td>
                    <td style={{ maxWidth: 280 }}>
                      <div style={{ fontWeight: 550 }} className="ellipsis">{p.name}</div>
                      <div className="faint small ellipsis">{p.category} · {p.address}</div>
                    </td>
                    <td className="num small" style={{ whiteSpace: "nowrap" }}>
                      {p.rating !== null ? <><Star size={11} style={{ verticalAlign: -1 }} /> {p.rating.toFixed(1)} <span className="faint">({p.reviews})</span></> : <span className="faint">{p.source === "osm" ? "Not listed" : "No reviews"}</span>}
                    </td>
                    <td>{p.website ? <span className="badge">{p.audit ? (p.audit.ok ? "Audited" : "Down") : "Has site"}</span> : <span className="badge bad">None</span>}</td>
                    <td className="small" style={{ whiteSpace: "nowrap" }}>
                      {p.phone ? <div className="num">{phoneDisplay(p.phone)}</div> : <span className="faint">—</span>}
                      {p.email && <div className="faint ellipsis" style={{ maxWidth: 220 }} title={p.email}><Mail size={11} style={{ verticalAlign: -1 }} /> {p.email}</div>}
                    </td>
                    <td style={{ maxWidth: 280 }}>
                      <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                        {p.signals.slice(0, 3).map((s) => <span key={s} className="tag">{s}</span>)}
                        {p.signals.length > 3 && <span className="faint small">+{p.signals.length - 3}</span>}
                      </div>
                    </td>
                    <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
                      {p.status === "added" ? (
                        <Link className="badge good" to={`/clients/${p.contactId}`}><CheckCircle2 /> In CRM</Link>
                      ) : (
                        <div className="row" style={{ gap: 2 }}>
                          {p.website && !p.audit && (
                            <button className="btn sm ghost" onClick={() => audit(p)} disabled={auditing.has(p.id)} title="Audit website">
                              {auditing.has(p.id) ? <span className="spinner" /> : <ScanSearch />}
                            </button>
                          )}
                          <button className="btn sm ghost" title={p.status === "dismissed" ? "Restore" : "Dismiss"} onClick={() => dismiss(p)}><X /></button>
                          <button className="btn sm" onClick={() => setOpen(p)}>Review</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={<Telescope />} title={view === "results" ? "Search for businesses to prospect" : "No saved prospects yet"}>
            Pick a business type and a location. Each result gets an opportunity score from its reviews, rating and web presence.
          </Empty>
        )}
      </Card>

      {open && <ProspectModal p={open} pipelines={pipelines.data ?? []} onClose={() => setOpen(null)} onAudit={() => audit(open)} auditing={auditing.has(open.id)} onUpdated={replace} />}
      {bulkAdding && (
        <BulkAdd
          prospects={rows.filter((r) => selected.has(r.id) && r.status === "new")}
          pipelines={pipelines.data ?? []}
          onClose={() => setBulkAdding(false)}
          onDone={(updated) => {
            updated.forEach(replace);
            setSelected(new Set());
          }}
        />
      )}
    </div>
  );
}

function AddFields({ pipelines, value, onChange }: { pipelines: Pipeline[]; value: { pipelineId: string; stageId: string; dealValue: string }; onChange: (v: typeof value) => void }) {
  const pl = pipelines.find((p) => p.id === value.pipelineId);
  return (
    <div className="grid-3">
      <Field label="Create deal in">
        <select className="select" value={value.pipelineId} onChange={(e) => onChange({ ...value, pipelineId: e.target.value, stageId: pipelines.find((p) => p.id === e.target.value)?.stages[0]?.id ?? "" })}>
          <option value="">Contact only</option>
          {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      <Field label="Stage">
        <select className="select" disabled={!pl} value={value.stageId} onChange={(e) => onChange({ ...value, stageId: e.target.value })}>
          {pl?.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      <Field label="Est. value ($)">
        <input className="input" disabled={!pl} inputMode="numeric" value={value.dealValue} onChange={(e) => onChange({ ...value, dealValue: e.target.value })} />
      </Field>
    </div>
  );
}

function ProspectModal({ p, pipelines, onClose, onAudit, auditing, onUpdated }: { p: Prospect; pipelines: Pipeline[]; onClose: () => void; onAudit: () => void; auditing: boolean; onUpdated: (p: Prospect) => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [deal, setDeal] = useState({ pipelineId: pipelines[0]?.id ?? "", stageId: pipelines[0]?.stages[0]?.id ?? "", dealValue: "" });
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ contactId: string }>(`/api/prospects/${p.id}/add`, { firstName: first, lastName: last, pipelineId: deal.pipelineId, stageId: deal.stageId, value: Number(deal.dealValue) || 0 });
      onUpdated({ ...p, status: "added", contactId: r.contactId });
      toast(`${p.name} added to your CRM`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not add", "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={p.name} onClose={onClose} wide>
      <div className="row wrap" style={{ gap: 14 }}>
        <ScoreBadge score={p.score} />
        <span className="small muted">{p.category}</span>
        {p.rating !== null && <span className="small"><Star size={12} style={{ verticalAlign: -1 }} /> {p.rating.toFixed(1)} · {p.reviews} reviews</span>}
        {p.sample && <span className="badge warn">Sample</span>}
      </div>
      <div className="grid-2 small">
        <div className="stack" style={{ gap: 6 }}>
          <div className="row"><MapPin size={14} className="faint" /> {p.address || "—"}</div>
          <div className="row"><Phone size={14} className="faint" /> {p.phone ? <a href={`tel:${p.phone}`}>{phoneDisplay(p.phone)}</a> : "No phone"}</div>
          <div className="row"><Mail size={14} className="faint" /> {p.email ? <a href={`mailto:${p.email}`} className="ellipsis">{p.email}</a> : <span className="faint">{p.website && !p.audit ? "Run the website audit to look for an email" : "No email found"}</span>}</div>
          {p.socials?.length ? (
            <div className="row wrap" style={{ gap: 6 }}>
              <Share2 size={14} className="faint" />
              {p.socials.map((s) => <a key={s} href={s} target="_blank" rel="noreferrer" className="tag">{s.replace(/^https?:\/\/(www\.)?/, "").split("/")[0].replace(".com", "")}</a>)}
            </div>
          ) : null}
          <div className="row"><Globe size={14} className="faint" /> {p.website ? <a href={p.website} target="_blank" rel="noreferrer" className="ellipsis">{p.website.replace(/^https?:\/\/(www\.)?/, "")}</a> : <span style={{ color: "var(--bad)" }}>No website</span>}</div>
          {p.mapsUrl && <a href={p.mapsUrl} target="_blank" rel="noreferrer" className="row"><ExternalLink size={14} /> {p.source === "osm" ? "OpenStreetMap listing" : "Google Maps listing"}</a>}
        </div>
        <div>
          <div className="faint" style={{ marginBottom: 6 }}>Why it scored {p.score}</div>
          <div className="chips">{p.signals.length ? p.signals.map((s) => <span key={s} className="tag">{s}</span>) : <span className="faint">No red flags — strong presence</span>}</div>
        </div>
      </div>

      <Card title="Website audit" right={p.website && <button className="btn sm" onClick={onAudit} disabled={auditing}>{auditing ? <span className="spinner" /> : <ScanSearch />} {p.audit ? "Re-run" : "Run audit"}</button>}>
        {p.audit ? (
          <div className="stack" style={{ gap: 6 }}>
            {p.audit.findings.map((f, i) => (
              <div key={i} className={`status-line ${f.level === "good" ? "good" : f.level === "bad" ? "bad" : ""}`} style={f.level === "warn" ? { color: "var(--warn)" } : undefined}>
                {f.level === "good" ? <CheckCircle2 /> : f.level === "bad" ? <XCircle /> : <AlertTriangle />}
                <span style={{ color: "var(--text)" }}>{f.text}</span>
              </div>
            ))}
            <div className="faint small">Checked {relTime(p.audit.checkedAt)}</div>
          </div>
        ) : p.website ? (
          <div className="muted small">Checks HTTPS, speed, mobile setup, lead forms, booking and chat widgets, tracking pixels and staleness — the talking points for your first call.</div>
        ) : (
          <div className="small">No website at all. That's the opener: every search for “{p.category.toLowerCase()} near me” is going to a competitor.</div>
        )}
      </Card>

      <Card title={<span className="row" style={{ gap: 6 }}><Sparkles size={14} /> Prospect angle</span>}>
        <AiPanel prospectId={p.id} playbookIds={["prospect-pitch"]} />
      </Card>

      {p.status === "added" ? (
        <Banner tone="info">
          Already in your CRM. <a onClick={() => nav(`/clients/${p.contactId}`)} style={{ cursor: "pointer" }}>Open client →</a>
        </Banner>
      ) : (
        <Card title="Add to CRM">
          <div className="stack">
            <div className="grid-2">
              <Field label="Owner first name" hint="Optional"><input className="input" value={first} onChange={(e) => setFirst(e.target.value)} /></Field>
              <Field label="Last name"><input className="input" value={last} onChange={(e) => setLast(e.target.value)} /></Field>
            </div>
            <AddFields pipelines={pipelines} value={deal} onChange={setDeal} />
            <div className="row">
              <span className="faint small">Creates the contact (tagged <code>prospect</code>), saves the audit as a note{deal.pipelineId ? ", and opens a deal" : ""}.</span>
              <span className="spacer" />
              <button className="btn primary" onClick={add} disabled={busy}><Plus /> {busy ? "Adding…" : "Add to CRM"}</button>
            </div>
          </div>
        </Card>
      )}
    </Modal>
  );
}

function BulkAdd({ prospects, pipelines, onClose, onDone }: { prospects: Prospect[]; pipelines: Pipeline[]; onClose: () => void; onDone: (p: Prospect[]) => void }) {
  const toast = useToast();
  const [deal, setDeal] = useState({ pipelineId: pipelines[0]?.id ?? "", stageId: pipelines[0]?.stages[0]?.id ?? "", dealValue: "" });
  const [progress, setProgress] = useState<number | null>(null);
  const run = async () => {
    const done: Prospect[] = [];
    setProgress(0);
    for (const p of prospects) {
      try {
        const r = await api.post<{ contactId: string }>(`/api/prospects/${p.id}/add`, { pipelineId: deal.pipelineId, stageId: deal.stageId, value: Number(deal.dealValue) || 0 });
        done.push({ ...p, status: "added", contactId: r.contactId });
      } catch (e) {
        toast(`${p.name}: ${e instanceof Error ? e.message : "failed"}`, "bad");
      }
      setProgress((n) => (n ?? 0) + 1);
    }
    onDone(done);
    toast(`Added ${done.length} of ${prospects.length} to your CRM`);
    onClose();
  };
  return (
    <Modal
      title={`Add ${prospects.length} prospects to CRM`}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose} disabled={progress !== null}>Cancel</button><button className="btn primary" onClick={run} disabled={progress !== null}>{progress !== null ? `Adding ${progress}/${prospects.length}…` : "Add all"}</button></>}
    >
      <AddFields pipelines={pipelines} value={deal} onChange={setDeal} />
      <div className="small muted">Each business becomes a contact tagged <code>prospect</code> with its score and audit saved as a note.</div>
    </Modal>
  );
}

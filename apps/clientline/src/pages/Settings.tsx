import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { CheckCircle2, Lock, XCircle } from "lucide-react";
import { api, type Pipeline } from "../lib/api.ts";
import { useApp } from "../App.tsx";
import { Card, Field, LoadingRows, useAsync, useToast } from "../components/ui.tsx";

interface SettingsData {
  ghlApiKey: string;
  ghlLocationId: string;
  anthropicApiKey: string;
  claudeModel: string;
  googlePlacesApiKey: string;
  defaultPipelineId: string;
  profile: Record<string, string>;
  has: { ghl: boolean; claude: boolean; places: boolean };
  envLocked: string[];
}

const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 — best quality (default)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 — faster, lower cost" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 — fastest, cheapest" },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2 — most capable, premium" },
];

const PROFILE_FIELDS: [string, string, string][] = [
  ["agencyName", "Business name", "Northpeak Digital"],
  ["yourName", "Your name", "Alex"],
  ["offer", "What you sell", "Lead generation for home-service businesses: Google & Meta ads, a GoHighLevel funnel, missed-call text-back and review automation"],
  ["idealClient", "Ideal client", "Owner-operated HVAC, roofing and plumbing companies in the US doing $1–5M a year"],
  ["priceRange", "Pricing", "$1,500–$3,500/mo retainer + ad spend, month-to-month"],
  ["differentiators", "Why you", "Pay-per-booked-appointment guarantee in month one; reporting in plain English"],
  ["bookingLink", "Booking link", "https://link.yourdomain.com/widget/booking/…"],
];

type TestResult = { ok: boolean; message: string } | null;

function Result({ r }: { r: TestResult }) {
  return r ? (
    <div className={`status-line ${r.ok ? "good" : "bad"}`}>
      {r.ok ? <CheckCircle2 /> : <XCircle />} <span>{r.message}</span>
    </div>
  ) : null;
}

function Lockable({ locked, children }: { locked: boolean; children: React.ReactNode }) {
  return (
    <div style={{ position: "relative" }}>
      {children}
      {locked && <span className="badge" style={{ position: "absolute", right: 6, top: 6 }}><Lock /> .env</span>}
    </div>
  );
}

export function Settings() {
  const { refreshStatus } = useApp();
  const toast = useToast();
  const loc = useLocation();
  const s = useAsync(() => api.get<SettingsData>("/api/settings"));
  const pipelines = useAsync(() => api.get<Pipeline[]>("/api/pipelines"), [s.data?.has.ghl]);
  const [form, setForm] = useState<SettingsData | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (s.data) setForm(s.data);
  }, [s.data]);
  useEffect(() => {
    if (!form || !loc.hash) return;
    document.getElementById(loc.hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [loc.hash, form === null]);

  if (!form) return <div className="page"><Card><LoadingRows n={8} /></Card></div>;
  const locked = (k: string) => form.envLocked.includes(k);
  const set = (k: keyof SettingsData) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  const setP = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, profile: { ...form.profile, [k]: e.target.value } });

  const save = async (silent = false) => {
    setSaving(true);
    try {
      const next = await api.put<SettingsData>("/api/settings", {
        ghlApiKey: form.ghlApiKey,
        ghlLocationId: form.ghlLocationId,
        anthropicApiKey: form.anthropicApiKey,
        claudeModel: form.claudeModel,
        googlePlacesApiKey: form.googlePlacesApiKey,
        defaultPipelineId: form.defaultPipelineId,
        profile: form.profile,
      });
      s.setData(next);
      refreshStatus();
      pipelines.reload();
      if (!silent) toast("Settings saved");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "bad");
    } finally {
      setSaving(false);
    }
  };

  const test = async (service: "ghl" | "claude" | "places") => {
    setTesting(service);
    try {
      const r = await api.post<{ ok: boolean; message: string }>(`/api/settings/test/${service}`, form);
      setTests((t) => ({ ...t, [service]: r }));
      if (r.ok) await save(true);
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      <div className="page-head">
        <div>
          <h2>Settings</h2>
          <p>Keys are stored on this machine in <code>apps/clientline/data/settings.json</code> and only sent to the service they belong to.</p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => save()} disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
        </div>
      </div>

      <div className="split" style={{ gridTemplateColumns: "180px minmax(0, 1fr)" }}>
        <nav className="settings-nav">
          <a href="#ghl">GoHighLevel</a>
          <a href="#claude">Claude</a>
          <a href="#places">Google Places</a>
          <a href="#profile">Business profile</a>
        </nav>
        <div className="stack" style={{ gap: 16 }}>
          <div id="ghl" />
          <Card title="GoHighLevel" right={<span className={`badge ${form.has.ghl ? "good" : "warn"}`}>{form.has.ghl ? "Connected" : "Using demo data"}</span>}>
            <div className="stack">
              <ol className="steps">
                <li>In GoHighLevel, open the sub-account → <b>Settings → Private Integrations</b> → <b>Create new integration</b>.</li>
                <li>Enable scopes: contacts (read/write), opportunities (read/write), calendars & calendar events (read), conversations & conversation messages (read/write), locations (read).</li>
                <li>Copy the token, and copy the <b>Location ID</b> from Settings → Business Profile (or the URL: <code>/location/&lt;id&gt;/</code>).</li>
              </ol>
              <div className="grid-2">
                <Field label="Private Integration token">
                  <Lockable locked={locked("ghlApiKey")}><input className="input mono" type="password" autoComplete="off" value={form.ghlApiKey} onChange={set("ghlApiKey")} placeholder="pit-…" disabled={locked("ghlApiKey")} /></Lockable>
                </Field>
                <Field label="Location ID">
                  <Lockable locked={locked("ghlLocationId")}><input className="input mono" value={form.ghlLocationId} onChange={set("ghlLocationId")} placeholder="e.g. ve9EPM428h8vShlRW1KT" disabled={locked("ghlLocationId")} /></Lockable>
                </Field>
              </div>
              <div className="row wrap">
                <button className="btn" onClick={() => test("ghl")} disabled={testing === "ghl" || !form.ghlApiKey || !form.ghlLocationId}>{testing === "ghl" ? "Testing…" : "Test & save connection"}</button>
                <Result r={tests.ghl ?? null} />
              </div>
              <Field label="Primary pipeline" hint="Drives the overview KPIs, funnel and pipeline review.">
                <select className="select" value={form.defaultPipelineId} onChange={set("defaultPipelineId")} style={{ maxWidth: 360 }}>
                  <option value="">First pipeline</option>
                  {pipelines.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              <div className="faint small">Calls logged here write a note on the contact, create a follow-up task, and move the deal stage in GoHighLevel. Tags you add can trigger your GHL workflows.</div>
            </div>
          </Card>

          <div id="claude" />
          <Card title="Claude" right={<span className={`badge ${form.has.claude ? "good" : ""}`}>{form.has.claude ? "Connected" : "Not connected"}</span>}>
            <div className="stack">
              <div className="small muted">Powers every agent from the Agency roster: call prep, scripts, live objection help, call summaries, follow-ups, proposals and pipeline reviews. Get a key at console.anthropic.com → API keys.</div>
              <div className="grid-2">
                <Field label="Anthropic API key">
                  <Lockable locked={locked("anthropicApiKey")}><input className="input mono" type="password" autoComplete="off" value={form.anthropicApiKey} onChange={set("anthropicApiKey")} placeholder="sk-ant-…" disabled={locked("anthropicApiKey")} /></Lockable>
                </Field>
                <Field label="Model">
                  <select className="select" value={form.claudeModel} onChange={set("claudeModel")} disabled={locked("claudeModel")}>
                    {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    {!MODELS.some((m) => m.id === form.claudeModel) && <option value={form.claudeModel}>{form.claudeModel}</option>}
                  </select>
                </Field>
              </div>
              <div className="row wrap">
                <button className="btn" onClick={() => test("claude")} disabled={testing === "claude" || !form.anthropicApiKey}>{testing === "claude" ? "Testing…" : "Test & save"}</button>
                <Result r={tests.claude ?? null} />
              </div>
            </div>
          </Card>

          <div id="places" />
          <Card title="Google Places" right={<span className={`badge ${form.has.places ? "good" : ""}`}>{form.has.places ? "Connected" : "Sample mode"}</span>}>
            <div className="stack">
              <div className="small muted">Powers <b>Find clients</b>: real local businesses with phone, website, rating and review count. In Google Cloud, enable <b>Places API (New)</b> and create an API key (restrict it to that API).</div>
              <Field label="API key">
                <Lockable locked={locked("googlePlacesApiKey")}><input className="input mono" type="password" autoComplete="off" value={form.googlePlacesApiKey} onChange={set("googlePlacesApiKey")} placeholder="AIza…" disabled={locked("googlePlacesApiKey")} /></Lockable>
              </Field>
              <div className="row wrap">
                <button className="btn" onClick={() => test("places")} disabled={testing === "places" || !form.googlePlacesApiKey}>{testing === "places" ? "Testing…" : "Test & save"}</button>
                <Result r={tests.places ?? null} />
              </div>
            </div>
          </Card>

          <div id="profile" />
          <Card title="Business profile" sub="Every agent reads this, so scripts and proposals sound like you">
            <div className="stack">
              {PROFILE_FIELDS.map(([k, label, ph]) => (
                <Field key={k} label={label}>
                  {["offer", "idealClient", "differentiators"].includes(k) ? (
                    <textarea className="textarea" rows={2} value={form.profile[k] ?? ""} onChange={setP(k)} placeholder={ph} />
                  ) : (
                    <input className="input" value={form.profile[k] ?? ""} onChange={setP(k)} placeholder={ph} />
                  )}
                </Field>
              ))}
              <div className="row"><span className="spacer" /><button className="btn primary" onClick={() => save()} disabled={saving}>Save profile</button></div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

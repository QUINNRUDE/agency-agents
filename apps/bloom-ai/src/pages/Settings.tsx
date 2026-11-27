import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { CheckCircle2, Lock, XCircle } from "lucide-react";
import { api, type Pipeline } from "../lib/api.ts";
import { useApp } from "../App.tsx";
import { Card, Field, LoadingRows, useAsync, useToast } from "../components/ui.tsx";
import { ACCENTS, Swatch, useAccent } from "../components/brand.tsx";

interface SettingsData {
  ghlApiKey: string;
  ghlLocationId: string;
  anthropicApiKey: string;
  claudeModel: string;
  googlePlacesApiKey: string;
  defaultPipelineId: string;
  metaAccessToken: string;
  metaAdAccountId: string;
  metaPageId: string;
  metaAutoSync: string;
  metaGraphVersion: string;
  callGoal: string;
  profile: Record<string, string>;
  has: { ghl: boolean; claude: boolean; places: boolean; meta: boolean };
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
type MetaAccount = { id: string; name: string; currency: string; active: boolean };

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
  const [metaAssets, setMetaAssets] = useState<{ adAccounts: MetaAccount[]; pages: { id: string; name: string }[] } | null>(null);
  const [accent, setAccent] = useAccent();
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
        metaAccessToken: form.metaAccessToken,
        metaAdAccountId: form.metaAdAccountId,
        metaPageId: form.metaPageId,
        metaAutoSync: form.metaAutoSync,
        metaGraphVersion: form.metaGraphVersion,
        callGoal: form.callGoal,
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

  const test = async (service: "ghl" | "claude" | "places" | "meta") => {
    setTesting(service);
    try {
      const r = await api.post<{ ok: boolean; message: string; adAccounts?: MetaAccount[]; pages?: { id: string; name: string }[] }>(`/api/settings/test/${service}`, form);
      setTests((t) => ({ ...t, [service]: r }));
      if (service === "meta" && r.ok) {
        setMetaAssets({ adAccounts: r.adAccounts ?? [], pages: r.pages ?? [] });
        const acct = form.metaAdAccountId || r.adAccounts?.find((a) => a.active)?.id || r.adAccounts?.[0]?.id || "";
        const page = form.metaPageId || r.pages?.[0]?.id || "";
        setForm((f) => (f ? { ...f, metaAdAccountId: acct, metaPageId: page } : f));
      }
      if (r.ok && service !== "meta") await save(true);
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      <div className="page-head">
        <div>
          <h2>Settings</h2>
          <p>Keys are stored on this machine in <code>apps/bloom-ai/data/settings.json</code> and only sent to the service they belong to.</p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => save()} disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
        </div>
      </div>

      <div className="split" style={{ gridTemplateColumns: "180px minmax(0, 1fr)" }}>
        <nav className="settings-nav">
          <a href="#ghl">GoHighLevel</a>
          <a href="#claude">Claude</a>
          <a href="#meta">Meta Ads</a>
          <a href="#places">Google Places</a>
          <a href="#appearance">Appearance</a>
          <a href="#profile">Business profile</a>
        </nav>
        <div className="stack" style={{ gap: 16 }}>
          <div id="ghl" />
          <Card title="GoHighLevel" right={<span className={`badge ${form.has.ghl ? "good" : "warn"}`}>{form.has.ghl ? "Connected" : "Using demo data"}</span>}>
            <div className="stack">
              <ol className="steps">
                <li>In GoHighLevel, open the sub-account → <b>Settings → Private Integrations</b> → <b>Create new integration</b>.</li>
                <li>Enable scopes: contacts (read/write), opportunities (read/write), calendars & calendar events (read), conversations & conversation messages (read/write), locations (read). Optional, for owners, custom fields and the all-tasks list: users, custom fields and location tasks (read).</li>
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

          <div id="meta" />
          <Card title="Meta Ads (Facebook & Instagram)" right={<span className={`badge ${form.has.meta ? "good" : ""}`}>{form.has.meta ? "Connected" : "Sample data"}</span>}>
            <div className="stack">
              <ol className="steps">
                <li>In <b>Meta Business Settings → Users → System users</b>, add a system user (Admin) and assign it your ad account and Facebook Page.</li>
                <li>Click <b>Generate new token</b> with permissions: <code>ads_read</code>, <code>ads_management</code> (to pause campaigns / change budgets), <code>leads_retrieval</code>, <code>pages_show_list</code>, <code>pages_read_engagement</code>, <code>pages_manage_metadata</code>, <code>business_management</code>.</li>
                <li>Paste the token, click <b>Test</b>, then pick the ad account and the Page that owns your lead forms.</li>
              </ol>
              <Field label="Access token" hint="A System User token doesn't expire. A personal token from Graph API Explorer works for testing but expires within hours or 60 days.">
                <Lockable locked={locked("metaAccessToken")}><input className="input mono" type="password" autoComplete="off" value={form.metaAccessToken} onChange={set("metaAccessToken")} placeholder="EAAG…" disabled={locked("metaAccessToken")} /></Lockable>
              </Field>
              <div className="row wrap">
                <button className="btn" onClick={() => test("meta")} disabled={testing === "meta" || !form.metaAccessToken}>{testing === "meta" ? "Testing…" : "Test token"}</button>
                <Result r={tests.meta ?? null} />
              </div>
              <div className="grid-2">
                <Field label="Ad account">
                  {metaAssets?.adAccounts.length ? (
                    <select className="select" value={form.metaAdAccountId} onChange={set("metaAdAccountId")}>
                      {metaAssets.adAccounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.id.replace("act_", "")}{a.active ? "" : " · inactive"})</option>)}
                    </select>
                  ) : (
                    <Lockable locked={locked("metaAdAccountId")}><input className="input mono" value={form.metaAdAccountId} onChange={set("metaAdAccountId")} placeholder="act_1234567890" disabled={locked("metaAdAccountId")} /></Lockable>
                  )}
                </Field>
                <Field label="Facebook Page (for lead forms)">
                  {metaAssets?.pages.length ? (
                    <select className="select" value={form.metaPageId} onChange={set("metaPageId")}>
                      <option value="">No lead forms</option>
                      {metaAssets.pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  ) : (
                    <Lockable locked={locked("metaPageId")}><input className="input mono" value={form.metaPageId} onChange={set("metaPageId")} placeholder="Page ID" disabled={locked("metaPageId")} /></Lockable>
                  )}
                </Field>
              </div>
              <label className="row small">
                <input type="checkbox" checked={form.metaAutoSync === "on"} onChange={(e) => setForm({ ...form, metaAutoSync: e.target.checked ? "on" : "off" })} />
                Pull new lead-form leads into the CRM automatically every 5 minutes (and fire “Meta lead” automations)
              </label>
              <div className="faint small">
                Instagram and Messenger <b>DMs</b> go through GoHighLevel: connect your Facebook Page and Instagram account in GoHighLevel → Settings → Integrations, and add the conversations scopes to your Private Integration. Graph API version: {form.metaGraphVersion || "v23.0"}.
              </div>
              <div className="row"><span className="spacer" /><button className="btn primary" onClick={() => save()} disabled={saving}>Save Meta settings</button></div>
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

          <div id="appearance" />
          <Card title="Appearance & goals">
            <div className="stack">
              <div>
                <div className="small" style={{ fontWeight: 600, marginBottom: 8 }}>Theme colour</div>
                <div className="swatches" style={{ gap: 16 }}>
                  {ACCENTS.map((a) => <Swatch key={a.id} id={a.id} on={accent === a.id} onClick={() => setAccent(a.id)} size="big" />)}
                </div>
                <div className="faint small" style={{ marginTop: 6 }}>Saved in this browser. Light / dark follows your system — or use the moon button in the top bar.</div>
              </div>
              <Field label="Daily call goal" hint="Shown as the ring on the overview.">
                <input className="input" type="number" min={1} max={500} style={{ maxWidth: 140 }} value={form.callGoal} onChange={set("callGoal")} />
              </Field>
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

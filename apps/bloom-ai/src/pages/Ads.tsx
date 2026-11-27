import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CircleDollarSign, Eye, MousePointerClick, Plus, RefreshCw, Sparkles, Target, TrendingUp, Trophy, UserPlus, Users } from "lucide-react";
import { api } from "../lib/api.ts";
import { money, relTime } from "../lib/format.ts";
import { useApp } from "../App.tsx";
import { AiPanel } from "../components/AiPanel.tsx";
import { ColumnChart } from "../components/charts.tsx";
import { Banner, Card, Empty, ErrorState, LoadingRows, Modal, Skeleton, useAsync, useToast } from "../components/ui.tsx";
import { Sparkline, Toggle } from "../components/brand.tsx";
import { ConfirmModal } from "../components/crm.tsx";

interface Campaign {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string;
  objective: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpm: number;
  leads: number;
  cpl: number | null;
}

interface Overview {
  sample: boolean;
  connected?: boolean;
  account: { id: string; name: string; currency: string; timezone: string };
  range: number;
  totals: { spend: number; impressions: number; clicks: number; reach: number; ctr: number; cpc: number; cpm: number; frequency: number; leads: number; cpl: number | null };
  daily: { date: string; spend: number; leads: number; clicks: number; impressions: number }[];
  campaigns: Campaign[];
  attribution: { crmLeads: number; customers: number; wonValue: number; openValue: number; roas: number | null; costPerCustomer: number | null; byCampaign: Record<string, { crmLeads: number; wonValue: number }> } | null;
  sync: { lastSyncAt: string; lastLeadTime: string; lastError: string };
  autoSync: boolean;
  hasPage: boolean;
  own: boolean;
}

interface AdAccount {
  id: string;
  name: string;
  currency: string;
  active: boolean;
}

const ACCOUNT_KEY = "bloom-ad-account";
const savedAccount = () => {
  try {
    return localStorage.getItem(ACCOUNT_KEY) ?? "";
  } catch {
    return "";
  }
};

interface MetaLead {
  leadId: string;
  formName: string;
  campaignName: string;
  platform: string;
  createdAt: string;
  contactId: string;
  name: string;
  email: string;
  phone: string;
}

const compact = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);

export function Ads() {
  const { status } = useApp();
  const toast = useToast();
  const [range, setRange] = useState(30);
  const [account, setAccount] = useState(savedAccount);
  const accounts = useAsync(() => (status?.has.meta ? api.get<{ adAccounts: AdAccount[] }>("/api/meta/assets").then((r) => r.adAccounts) : Promise.resolve([] as AdAccount[])), [status?.has.meta]);
  useEffect(() => {
    try {
      if (account) localStorage.setItem(ACCOUNT_KEY, account);
    } catch {
      /* private mode: the choice just isn't remembered */
    }
  }, [account]);
  const ov = useAsync(() => api.get<Overview>(`/api/meta/overview?range=${range}${account ? `&account=${encodeURIComponent(account)}` : ""}`), [range, account]);
  const leads = useAsync(() => api.get<MetaLead[]>("/api/meta/leads"));
  const [review, setReview] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [confirm, setConfirm] = useState<{ c: Campaign; next: "ACTIVE" | "PAUSED" } | null>(null);
  const [budgets, setBudgets] = useState<Record<string, string>>({});

  const d = ov.data;
  const cur = d?.account.currency ?? "USD";
  const m = (n: number, c = false) => (cur === "USD" ? money(n, c) : `${cur} ${c ? compact(n) : n.toFixed(2)}`);
  const at = d?.attribution;

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await api.post<{ imported: number; matched: number; skipped: number; forms: number }>("/api/meta/sync");
      toast(`Synced ${r.forms} form${r.forms === 1 ? "" : "s"}: ${r.imported} new contact${r.imported === 1 ? "" : "s"}, ${r.matched} matched existing`);
      void leads.reload();
      void ov.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Sync failed", "bad");
    } finally {
      setSyncing(false);
    }
  };

  const setStatus = async (c: Campaign, next: "ACTIVE" | "PAUSED") => {
    try {
      await api.put(`/api/meta/campaigns/${c.id}`, { status: next, currency: cur });
      toast(`${c.name} ${next === "PAUSED" ? "paused" : "resumed"}`);
      void ov.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Update failed", "bad");
    }
  };

  const saveBudget = async (c: Campaign) => {
    const v = Number((budgets[c.id] ?? "").replace(/[^\d.]/g, ""));
    if (!v || v === c.dailyBudget) return;
    try {
      await api.put(`/api/meta/campaigns/${c.id}`, { dailyBudget: v, currency: cur });
      toast(`Daily budget for ${c.name} set to ${m(v)}`);
      void ov.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Update failed", "bad");
      setBudgets((b) => ({ ...b, [c.id]: String(c.dailyBudget ?? "") }));
    }
  };

  const roasTone = (r: number | null) => (r === null ? "" : r >= 3 ? "good" : r >= 1.5 ? "mid" : "bad");
  const spark = (k: "spend" | "leads" | "clicks" | "impressions") => (d?.daily ?? []).slice(-21).map((x) => x[k]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Meta Ads</h2>
          <p>{d ? `${d.account.name} · Facebook & Instagram · last ${d.range} days` : "Facebook & Instagram performance, tied to real revenue in your CRM"}</p>
        </div>
        <div className="actions">
          <div className="btn-group">
            {[7, 14, 30, 90].map((r) => (
              <button key={r} className={`btn ${range === r ? "on" : ""}`} onClick={() => setRange(r)}>{r}d</button>
            ))}
          </div>
          {(accounts.data?.length ?? 0) > 1 && (
            <select className="select" style={{ width: "auto", maxWidth: 220 }} value={account || d?.account.id || ""} onChange={(e) => setAccount(e.target.value)} aria-label="Ad account">
              {accounts.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          )}
          <button className="btn" onClick={() => setReview(true)}><Sparkles /> AI ad review</button>
          <button className="btn" onClick={sync} disabled={syncing || !status?.has.meta || !d?.hasPage} title={!d?.hasPage ? "Pick your Facebook Page in Settings → Meta Ads" : "Pull new lead-form leads into the CRM"}>
            <RefreshCw className={syncing ? "spin" : ""} style={syncing ? { animation: "spin 0.8s linear infinite" } : undefined} /> Sync leads
          </button>
          <Link className="btn primary" to="/ads/new"><Plus /> New campaign</Link>
        </div>
      </div>

      {d?.sample && (
        <Banner tone="warn">
          Sample ad data. <Link to="/settings#meta">Connect your Meta ad account</Link> to see your real spend, pause campaigns, change budgets and pull lead-form leads into the CRM automatically.
        </Banner>
      )}
      {d && !d.sample && d.connected === false && (
        <Banner tone="info">
          Meta isn't connected yet. <Link to="/settings#meta">Connect your ad account</Link> to see spend, leads and return on ad spend here, and to launch campaigns.
        </Banner>
      )}
      {d?.sync.lastError && <Banner tone="bad">Last lead sync failed: {d.sync.lastError}</Banner>}
      {ov.error && <ErrorState error={ov.error} onRetry={ov.reload} />}

      <div className="kpis">
        {!d
          ? Array.from({ length: 5 }, (_, i) => (
              <div className="card kpi2" key={i}><Skeleton w="50%" /><Skeleton h={26} w="70%" /><Skeleton w="40%" /></div>
            ))
          : (
              [
                { icon: CircleDollarSign, tint: "rose", label: "Spend", value: m(d.totals.spend, true), foot: `${m(d.totals.spend / Math.max(1, d.range))}/day avg`, spark: spark("spend") },
                { icon: UserPlus, tint: "teal", label: "Leads (Meta)", value: String(d.totals.leads), foot: `${compact(d.totals.reach)} people reached`, spark: spark("leads") },
                { icon: Target, tint: "violet", label: "Cost per lead", value: d.totals.cpl === null ? "—" : m(d.totals.cpl), foot: "spend ÷ Meta leads", spark: [] },
                { icon: MousePointerClick, tint: "sky", label: "Click-through rate", value: `${d.totals.ctr.toFixed(2)}%`, foot: `${compact(d.totals.clicks)} clicks · ${m(d.totals.cpc)} CPC`, spark: spark("clicks") },
                { icon: Eye, tint: "amber", label: "CPM", value: m(d.totals.cpm), foot: `${compact(d.totals.impressions)} impressions · ${d.totals.frequency.toFixed(1)} freq`, spark: spark("impressions") },
              ] as const
            ).map((k) => (
              <div className="card kpi2 lift" key={k.label}>
                <div className="top"><span className={`ichip ${k.tint}`}><k.icon /></span><span className="label">{k.label}</span></div>
                <div className="value">{k.value}</div>
                <div className="foot">{k.foot}</div>
                {k.spark.length > 1 && <Sparkline data={[...k.spark]} width={72} height={26} />}
              </div>
            ))}
      </div>

      <Card title="What your ads actually made" sub="Leads from Facebook & Instagram followed through your CRM" right={at && <span className={`roas ${roasTone(at.roas)}`}>{at.roas === null ? "ROAS —" : `${at.roas.toFixed(1)}x ROAS`}</span>}>
        {!d ? (
          <Skeleton h={60} />
        ) : at ? (
          <div className="grid-3" style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}>
            {[
              { icon: Users, label: "Meta leads in CRM", value: String(at.crmLeads) },
              { icon: Trophy, label: "Customers won", value: String(at.customers) },
              { icon: TrendingUp, label: "Revenue won", value: m(at.wonValue, true) },
              { icon: Target, label: "Cost per customer", value: at.costPerCustomer === null ? "—" : m(at.costPerCustomer) },
              { icon: CircleDollarSign, label: "Open pipeline", value: m(at.openValue, true) },
            ].map((x) => (
              <div key={x.label} className="row" style={{ alignItems: "flex-start" }}>
                <span className="ichip grad"><x.icon /></span>
                <div>
                  <div className="faint small">{x.label}</div>
                  <div className="num" style={{ fontSize: 19 }}>{x.value}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="small muted">{d && !d.own ? "This is a client's ad account. Their leads go to their own CRM, so revenue is tracked there, not in Bloom AI." : "Connect Meta to compare real spend against the revenue in your CRM."}</div>
        )}
        <div className="faint small" style={{ marginTop: 12 }}>Counts contacts tagged <code>meta-lead</code>, synced from lead forms, or with a Facebook / Instagram / Meta lead source. ROAS = revenue from won deals ÷ ad spend in this period.</div>
      </Card>

      <div className="grid-halves">
        <Card title="Spend per day">{d ? <ColumnChart data={d.daily.map((x) => ({ label: x.date.slice(5).replace("-", "/"), value: Math.round(x.spend) }))} format={(v) => (cur === "USD" ? `$${compact(v)}` : compact(v))} /> : <Skeleton h={180} />}</Card>
        <Card title="Leads per day">{d ? <ColumnChart data={d.daily.map((x) => ({ label: x.date.slice(5).replace("-", "/"), value: x.leads }))} unit="leads" /> : <Skeleton h={180} />}</Card>
      </div>

      <Card title="Campaigns" sub={d ? `${d.campaigns.filter((c) => c.status === "ACTIVE").length} active` : undefined} flush>
        {!d ? (
          <LoadingRows n={5} />
        ) : d.campaigns.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 54 }}>On</th>
                  <th>Campaign</th>
                  <th className="right">Daily budget</th>
                  <th className="right">Spend</th>
                  <th className="right">CTR</th>
                  <th className="right">Leads</th>
                  <th className="right">CPL</th>
                  <th className="right" title="Leads synced into the CRM from this campaign's forms">CRM leads</th>
                  <th className="right" title="Won deal value from this campaign's leads">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {d.campaigns.map((c) => {
                  const a = at?.byCampaign[c.name];
                  return (
                    <tr key={c.id}>
                      <td>
                        <Toggle on={c.status === "ACTIVE"} onChange={(v) => setConfirm({ c, next: v ? "ACTIVE" : "PAUSED" })} label={`${c.status === "ACTIVE" ? "Pause" : "Turn on"} ${c.name}`} disabled={d.sample} />
                      </td>
                      <td style={{ maxWidth: 320 }}>
                        <div style={{ fontWeight: 600 }} className="ellipsis">{c.name}</div>
                        <div className="faint small">{c.objective || "—"}{c.effectiveStatus && c.effectiveStatus !== c.status ? ` · ${c.effectiveStatus.toLowerCase().replace(/_/g, " ")}` : ""}</div>
                      </td>
                      <td className="right">
                        {c.dailyBudget !== null ? (
                          <input
                            className="input mono budget-input"
                            inputMode="decimal"
                            disabled={d.sample}
                            value={budgets[c.id] ?? String(c.dailyBudget)}
                            onChange={(e) => setBudgets({ ...budgets, [c.id]: e.target.value })}
                            onBlur={() => void saveBudget(c)}
                            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
                            aria-label={`Daily budget for ${c.name}`}
                          />
                        ) : (
                          <span className="faint small">{c.lifetimeBudget ? `${m(c.lifetimeBudget)} lifetime` : "ad set level"}</span>
                        )}
                      </td>
                      <td className="right num">{m(c.spend)}</td>
                      <td className="right num">{c.ctr.toFixed(2)}%</td>
                      <td className="right num">{c.leads}</td>
                      <td className="right num">{c.cpl === null ? "—" : m(c.cpl)}</td>
                      <td className="right num">{a ? a.crmLeads : <span className="faint">—</span>}</td>
                      <td className="right num">{a ? m(a.wonValue) : <span className="faint">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={d.connected === false && !d.sample ? "No ad account connected yet" : "No campaigns in this ad account"}>
            <Link className="btn primary" to="/ads/new" style={{ marginTop: 8 }}><Plus /> Create your first campaign</Link>
          </Empty>
        )}
      </Card>

      <Card
        title="Lead Ads → CRM"
        sub={d ? (d.autoSync ? "Auto-sync on · every 5 minutes" : "Auto-sync off") : undefined}
        right={<span className="faint small">{d?.sync.lastSyncAt ? `Last sync ${relTime(d.sync.lastSyncAt)}` : "Never synced"}</span>}
        flush
      >
        {leads.data?.length ? (
          <div className="table-wrap" style={{ maxHeight: 360 }}>
            <table className="table">
              <thead><tr><th>Lead</th><th>Form</th><th>Campaign</th><th>Platform</th><th>Submitted</th></tr></thead>
              <tbody>
                {leads.data.slice(0, 50).map((l) => (
                  <tr key={l.leadId}>
                    <td><Link to={`/clients/${l.contactId}`} style={{ fontWeight: 600 }}>{l.name}</Link><div className="faint small">{[l.email, l.phone].filter(Boolean).join(" · ")}</div></td>
                    <td className="small">{l.formName}</td>
                    <td className="small ellipsis" style={{ maxWidth: 240 }}>{l.campaignName || "—"}</td>
                    <td><span className={`ch ${l.platform === "Instagram" ? "IG" : "FB"}`}>{l.platform}</span></td>
                    <td className="small muted">{relTime(l.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: "0 16px 16px" }} className="small muted">
            {status?.has.meta
              ? d?.hasPage
                ? "No lead-form submissions synced yet. Click “Sync leads”, or turn on auto-sync in Settings."
                : "Pick the Facebook Page that owns your lead forms in Settings → Meta Ads."
              : "Once Meta is connected, every Facebook & Instagram lead-form submission becomes a tagged contact with the answers saved as a note — and can trigger your “Meta lead” automations instantly."}
          </div>
        )}
      </Card>

      {review && (
        <Modal title="AI ad performance review" onClose={() => setReview(false)} wide>
          <AiPanel playbookIds={["ads-review"]} />
        </Modal>
      )}
      {confirm?.next === "PAUSED" && (
        <ConfirmModal
          title={`Pause “${confirm.c.name}”?`}
          confirmLabel="Pause campaign"
          onClose={() => setConfirm(null)}
          onConfirm={() => setStatus(confirm.c, "PAUSED")}
        >
          The campaign stops delivering on Facebook and Instagram right away. You can turn it back on here at any time.
        </ConfirmModal>
      )}
      {confirm?.next === "ACTIVE" && (
        <ConfirmModal
          title={`Turn on “${confirm.c.name}”?`}
          confirmLabel="Turn on"
          tone="primary"
          onClose={() => setConfirm(null)}
          onConfirm={() => setStatus(confirm.c, "ACTIVE")}
        >
          {confirm.c.dailyBudget !== null
            ? `It starts spending up to about ${m(confirm.c.dailyBudget)} a day (${m(confirm.c.dailyBudget * 30.4)} a month).`
            : "It starts spending its budget again."}{" "}
          New ads run once Meta has reviewed them, usually within 24 hours.
        </ConfirmModal>
      )}
    </div>
  );
}

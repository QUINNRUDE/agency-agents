// Meta (Facebook / Instagram) Marketing API: ad account insights, campaign
// controls, and Lead Ads → CRM sync. Uses the Graph API with a long-lived
// System User or user access token.
import { getSettings } from "./config.ts";
import { crm } from "./crm/index.ts";
import type { Contact } from "./crm/types.ts";
import { localDb, type MetaLead } from "./store.ts";

const BASE = process.env.META_API_BASE || "https://graph.facebook.com";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const num = (v: unknown) => Number(v ?? 0) || 0;

export class MetaError extends Error {
  constructor(
    message: string,
    public status = 502,
  ) {
    super(message);
  }
}

function explain(code: number, message: string): string {
  if (code === 190) return "Meta rejected the access token (expired or revoked). Generate a new System User token in Business Settings.";
  if (code === 10 || code === 200 || code === 294) return `Meta says this token is missing a permission: ${message}. It needs ads_read (and ads_management to pause or change budgets, leads_retrieval + pages_show_list + pages_read_engagement for lead forms).`;
  if (code === 4 || code === 17 || code === 613 || code === 80004) return "Meta's rate limit was hit. Wait a few minutes and try again.";
  if (code === 100) return `Meta rejected the request: ${message}`;
  return `Meta API error ${code}: ${message}`;
}

async function graph<T = Json>(path: string, params: Record<string, string> = {}, opts: { method?: "GET" | "POST"; token?: string } = {}): Promise<T> {
  const s = getSettings();
  const token = opts.token ?? s.metaAccessToken;
  if (!token) throw new MetaError("Meta isn't connected. Add an access token in Settings → Meta Ads.", 400);
  const version = s.metaGraphVersion || "v23.0";
  const url = new URL(`${BASE}/${version}/${path.replace(/^\//, "")}`);
  const method = opts.method ?? "GET";
  let body: URLSearchParams | undefined;
  if (method === "GET") {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("access_token", token);
  } else {
    body = new URLSearchParams({ ...params, access_token: token });
  }
  const res = await fetch(url, { method, body, signal: AbortSignal.timeout(25_000) });
  const data = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok || data.error) {
    const e = obj(data.error);
    throw new MetaError(explain(num(e.code), str(e.message) || res.statusText), num(e.code) === 190 ? 401 : 502);
  }
  return data as T;
}

/** Follows `paging.next` for list endpoints. */
async function graphAll(path: string, params: Record<string, string>, maxPages = 5): Promise<Json[]> {
  const out: Json[] = [];
  let after = "";
  for (let i = 0; i < maxPages; i++) {
    const data = await graph<Json>(path, { ...params, ...(after ? { after } : {}) });
    out.push(...arr(data.data).map(obj));
    after = str(obj(obj(data.paging).cursors).after);
    if (!obj(data.paging).next || !after) break;
  }
  return out;
}

export const actId = (id: string) => (id.startsWith("act_") ? id : `act_${id.replace(/\D/g, "")}`);

// Meta reports budgets in the currency's minor unit; these currencies have none.
const ZERO_DECIMAL = new Set(["JPY", "KRW", "CLP", "VND", "ISK", "PYG", "TWD", "HUF", "COP", "IDR"]);
const minorFactor = (currency: string) => (ZERO_DECIMAL.has(currency.toUpperCase()) ? 1 : 100);

const LEAD_ACTIONS = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead", "onsite_web_lead", "leadgen_grouped"];
function leadsFrom(actions: unknown): number {
  const list = arr(actions).map(obj);
  for (const type of LEAD_ACTIONS) {
    const hit = list.find((a) => str(a.action_type) === type);
    if (hit) return num(hit.value);
  }
  return 0;
}

export interface MetaCampaign {
  id: string;
  name: string;
  status: string; // ACTIVE | PAUSED | ...
  effectiveStatus: string;
  objective: string;
  dailyBudget: number | null; // major units
  lifetimeBudget: number | null;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpm: number;
  leads: number;
  cpl: number | null;
}

export interface MetaOverview {
  sample: boolean;
  account: { id: string; name: string; currency: string; timezone: string };
  range: number;
  totals: { spend: number; impressions: number; clicks: number; reach: number; ctr: number; cpc: number; cpm: number; frequency: number; leads: number; cpl: number | null };
  daily: { date: string; spend: number; leads: number; clicks: number; impressions: number }[];
  campaigns: MetaCampaign[];
}

const PRESET: Record<number, string> = { 7: "last_7d", 14: "last_14d", 30: "last_30d", 90: "last_90d" };

export async function testMeta(token: string) {
  const me = await graph<Json>("me", { fields: "id,name" }, { token });
  const accounts = await graph<Json>("me/adaccounts", { fields: "id,name,currency,account_status", limit: "100" }, { token }).catch(() => ({ data: [] }) as Json);
  const pages = await graph<Json>("me/accounts", { fields: "id,name", limit: "100" }, { token }).catch(() => ({ data: [] }) as Json);
  return {
    name: str(me.name),
    adAccounts: arr(accounts.data).map((a) => ({ id: str(obj(a).id), name: str(obj(a).name), currency: str(obj(a).currency), active: num(obj(a).account_status) === 1 })),
    pages: arr(pages.data).map((p) => ({ id: str(obj(p).id), name: str(obj(p).name) })),
  };
}

export async function metaOverview(rangeDays: number): Promise<MetaOverview> {
  const s = getSettings();
  const range = PRESET[rangeDays] ? rangeDays : 30;
  if (!s.metaAccessToken || !s.metaAdAccountId) return sampleOverview(range);
  const act = actId(s.metaAdAccountId);
  const preset = PRESET[range];
  const [account, totalsRes, dailyRows, campaignRows, campaignMeta] = await Promise.all([
    graph<Json>(act, { fields: "name,currency,timezone_name" }),
    graph<Json>(`${act}/insights`, { fields: "spend,impressions,clicks,reach,ctr,cpc,cpm,frequency,actions", date_preset: preset }),
    graphAll(`${act}/insights`, { fields: "spend,impressions,clicks,actions", date_preset: preset, time_increment: "1", limit: "100" }),
    graphAll(`${act}/insights`, { level: "campaign", fields: "campaign_id,campaign_name,spend,impressions,clicks,ctr,cpm,actions", date_preset: preset, limit: "200" }),
    graphAll(`${act}/campaigns`, { fields: "id,name,status,effective_status,objective,daily_budget,lifetime_budget", limit: "200" }),
  ]);
  const currency = str(account.currency) || "USD";
  const f = minorFactor(currency);
  const t = obj(arr(totalsRes.data)[0]);
  const leads = leadsFrom(t.actions);
  const spend = num(t.spend);
  const insightsById = new Map(campaignRows.map((r) => [str(r.campaign_id), r]));
  const campaigns: MetaCampaign[] = campaignMeta.map((c) => {
    const i = insightsById.get(str(c.id)) ?? {};
    const cl = leadsFrom(i.actions);
    const cs = num(i.spend);
    return {
      id: str(c.id),
      name: str(c.name),
      status: str(c.status),
      effectiveStatus: str(c.effective_status),
      objective: str(c.objective).replace(/^OUTCOME_/, "").replace(/_/g, " ").toLowerCase(),
      dailyBudget: c.daily_budget ? num(c.daily_budget) / f : null,
      lifetimeBudget: c.lifetime_budget ? num(c.lifetime_budget) / f : null,
      spend: cs,
      impressions: num(i.impressions),
      clicks: num(i.clicks),
      ctr: num(i.ctr),
      cpm: num(i.cpm),
      leads: cl,
      cpl: cl ? cs / cl : null,
    };
  });
  return {
    sample: false,
    account: { id: act, name: str(account.name), currency, timezone: str(account.timezone_name) },
    range,
    totals: {
      spend,
      impressions: num(t.impressions),
      clicks: num(t.clicks),
      reach: num(t.reach),
      ctr: num(t.ctr),
      cpc: num(t.cpc),
      cpm: num(t.cpm),
      frequency: num(t.frequency),
      leads,
      cpl: leads ? spend / leads : null,
    },
    daily: dailyRows.map((d) => ({ date: str(d.date_start), spend: num(d.spend), leads: leadsFrom(d.actions), clicks: num(d.clicks), impressions: num(d.impressions) })),
    campaigns: campaigns.sort((a, b) => b.spend - a.spend || Number(b.status === "ACTIVE") - Number(a.status === "ACTIVE")),
  };
}

export async function updateCampaign(id: string, patch: { status?: "ACTIVE" | "PAUSED"; dailyBudget?: number }, currency: string) {
  const params: Record<string, string> = {};
  if (patch.status) params.status = patch.status;
  if (patch.dailyBudget !== undefined) params.daily_budget = String(Math.round(patch.dailyBudget * minorFactor(currency)));
  if (!Object.keys(params).length) return { ok: true };
  await graph(id.replace(/[^\d]/g, ""), params, { method: "POST" });
  return { ok: true };
}

// ---- Lead Ads ---------------------------------------------------------------

async function pageToken(pageId: string): Promise<string> {
  const p = await graph<Json>(pageId, { fields: "access_token,name" });
  const t = str(p.access_token);
  if (!t) throw new MetaError("Couldn't get a Page token. Make sure the token's user/system user has access to this Page with pages_show_list and leads_retrieval.", 403);
  return t;
}

export interface LeadForm {
  id: string;
  name: string;
  status: string;
  leads: number;
}

export async function listForms(): Promise<LeadForm[]> {
  const s = getSettings();
  if (!s.metaPageId) return [];
  const token = await pageToken(s.metaPageId);
  const data = await graph<Json>(`${s.metaPageId}/leadgen_forms`, { fields: "id,name,status,leads_count", limit: "100" }, { token });
  return arr(data.data).map((f) => ({ id: str(obj(f).id), name: str(obj(f).name), status: str(obj(f).status), leads: num(obj(f).leads_count) }));
}

const FIELD_MAP: Record<string, keyof Contact | "fullName"> = {
  full_name: "fullName",
  first_name: "firstName",
  last_name: "lastName",
  email: "email",
  phone_number: "phone",
  phone: "phone",
  city: "city",
  state: "state",
  province: "state",
  company_name: "companyName",
  company: "companyName",
  website: "website",
};

export interface SyncResult {
  imported: number;
  matched: number;
  skipped: number;
  forms: number;
  newContactIds: { contactId: string; formName: string; campaignName: string }[];
}

let syncing: Promise<SyncResult> | null = null;

/** Pulls new Lead Ads submissions from every form on the connected Page into the CRM. */
export function syncLeads(): Promise<SyncResult> {
  syncing ??= doSync().finally(() => {
    syncing = null;
  });
  return syncing;
}

async function doSync(): Promise<SyncResult> {
  const s = getSettings();
  if (!s.metaAccessToken || !s.metaPageId) throw new MetaError("Pick the Facebook Page that owns your lead forms in Settings → Meta Ads first.", 400);
  const token = await pageToken(s.metaPageId);
  const forms = await graph<Json>(`${s.metaPageId}/leadgen_forms`, { fields: "id,name", limit: "100" }, { token });
  const state = localDb.read();
  const known = new Set(state.metaLeads.map((l) => l.leadId));
  const since = state.metaSync.lastLeadTime ? Math.floor(new Date(state.metaSync.lastLeadTime).getTime() / 1000) - 3600 : Math.floor(Date.now() / 1000) - 30 * 86400;
  const result: SyncResult = { imported: 0, matched: 0, skipped: 0, forms: arr(forms.data).length, newContactIds: [] };
  const c = crm();
  const existing = await c.listContacts({ limit: 2000 });
  const byEmail = new Map(existing.filter((x) => x.email).map((x) => [x.email.toLowerCase(), x]));
  const byPhone = new Map(existing.filter((x) => x.phone).map((x) => [x.phone.replace(/\D/g, "").slice(-10), x]));
  let newest = state.metaSync.lastLeadTime;

  for (const f of arr(forms.data).map(obj)) {
    const formId = str(f.id);
    const formName = str(f.name);
    const leads = await graph<Json>(`${formId}/leads`, {
      fields: "id,created_time,field_data,ad_name,adset_name,campaign_name,campaign_id,platform,is_organic",
      filtering: JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: since }]),
      limit: "200",
    }, { token });
    for (const l of arr(leads.data).map(obj)) {
      const leadId = str(l.id);
      if (known.has(leadId)) {
        result.skipped++;
        continue;
      }
      const fields: Record<string, string> = {};
      const extra: string[] = [];
      for (const fd of arr(l.field_data).map(obj)) {
        const name = str(fd.name);
        const value = arr(fd.values).map(str).join(", ");
        const key = FIELD_MAP[name.toLowerCase()];
        if (key) fields[key] = value;
        else if (value) extra.push(`${name.replace(/_/g, " ")}: ${value}`);
      }
      if (fields.fullName && !fields.firstName) {
        const parts = fields.fullName.trim().split(/\s+/);
        fields.firstName = parts[0] ?? "";
        fields.lastName = parts.slice(1).join(" ");
      }
      const createdAt = str(l.created_time) ? new Date(str(l.created_time)).toISOString() : new Date().toISOString();
      if (!newest || createdAt > newest) newest = createdAt;
      const campaignName = str(l.campaign_name);
      const platform = str(l.platform) === "ig" ? "Instagram" : "Facebook";
      const note = [
        `New ${platform} Lead Ad submission — form “${formName}”`,
        campaignName && `Campaign: ${campaignName}${str(l.ad_name) ? ` · Ad: ${str(l.ad_name)}` : ""}`,
        ...extra,
        `Submitted ${new Date(createdAt).toLocaleString("en-US")}`,
        "\n— Synced by Bloom AI",
      ]
        .filter(Boolean)
        .join("\n");

      const match = (fields.email && byEmail.get(fields.email.toLowerCase())) || (fields.phone && byPhone.get(fields.phone.replace(/\D/g, "").slice(-10)));
      let contactId: string;
      if (match) {
        contactId = match.id;
        await c.addTags(contactId, ["meta-lead"]).catch(() => undefined);
        result.matched++;
      } else {
        const created = await c.createContact({
          firstName: fields.firstName,
          lastName: fields.lastName,
          email: fields.email,
          phone: fields.phone,
          companyName: fields.companyName,
          city: fields.city,
          state: fields.state,
          website: fields.website,
          source: `Meta Lead Ad — ${formName}`.slice(0, 80),
          tags: ["meta-lead", platform.toLowerCase()],
        });
        contactId = created.id;
        if (created.email) byEmail.set(created.email.toLowerCase(), created);
        result.imported++;
        result.newContactIds.push({ contactId, formName, campaignName });
      }
      await c.addNote(contactId, note).catch(() => undefined);
      const record: MetaLead = {
        leadId,
        formId,
        formName,
        campaignName,
        adName: str(l.ad_name),
        platform,
        createdAt,
        contactId,
        name: [fields.firstName, fields.lastName].filter(Boolean).join(" ") || fields.email || fields.phone || "Lead",
        email: fields.email ?? "",
        phone: fields.phone ?? "",
      };
      known.add(leadId);
      localDb.update((d) => {
        d.metaLeads.unshift(record);
        d.metaLeads = d.metaLeads.slice(0, 5000);
      });
    }
  }
  localDb.update((d) => {
    d.metaSync = { lastSyncAt: new Date().toISOString(), lastLeadTime: newest, lastError: "" };
  });
  return result;
}

// ---- Sample data (no Meta connection yet) ------------------------------------

function sampleOverview(range: number): MetaOverview {
  let seed = 4242 + range;
  const r = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const defs = [
    { name: "Lead Gen — Free Strategy Call", objective: "leads", budget: 60, cpl: 28, status: "ACTIVE" },
    { name: "Lead Gen — Spring Tune-up Offer", objective: "leads", budget: 45, cpl: 34, status: "ACTIVE" },
    { name: "Retargeting — Website Visitors 30d", objective: "leads", budget: 20, cpl: 19, status: "ACTIVE" },
    { name: "Messenger — Instant Quote", objective: "engagement", budget: 25, cpl: 41, status: "ACTIVE" },
    { name: "Awareness — Local Radius 15mi", objective: "awareness", budget: 15, cpl: 0, status: "PAUSED" },
  ];
  const today = new Date();
  const daily = Array.from({ length: range }, (_, i) => {
    const d = new Date(today.getTime() - (range - i) * 86400000);
    const weekday = d.getDay();
    const mult = weekday === 0 || weekday === 6 ? 0.75 : 1;
    const spend = Math.round((130 + r() * 50) * mult * 100) / 100;
    const leads = Math.max(0, Math.round((spend / 30) * (0.7 + r() * 0.6)));
    const impressions = Math.round(spend * (55 + r() * 20));
    return { date: d.toISOString().slice(0, 10), spend, leads, clicks: Math.round(impressions * (0.012 + r() * 0.008)), impressions };
  });
  const totalSpend = daily.reduce((s, d) => s + d.spend, 0);
  const weights = defs.map((d) => (d.status === "ACTIVE" ? d.budget : 0));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const campaigns: MetaCampaign[] = defs.map((d, i) => {
    const spend = Math.round((totalSpend * weights[i]) / wsum * 100) / 100;
    const impressions = Math.round(spend * (50 + r() * 30));
    const clicks = Math.round(impressions * (0.01 + r() * 0.012));
    const leads = d.cpl ? Math.round(spend / (d.cpl * (0.85 + r() * 0.3))) : 0;
    return {
      id: `sample_${i}`,
      name: d.name,
      status: d.status,
      effectiveStatus: d.status,
      objective: d.objective,
      dailyBudget: d.budget,
      lifetimeBudget: null,
      spend,
      impressions,
      clicks,
      ctr: impressions ? (clicks / impressions) * 100 : 0,
      cpm: impressions ? (spend / impressions) * 1000 : 0,
      leads,
      cpl: leads ? spend / leads : null,
    };
  });
  const impressions = daily.reduce((s, d) => s + d.impressions, 0);
  const clicks = daily.reduce((s, d) => s + d.clicks, 0);
  const leads = daily.reduce((s, d) => s + d.leads, 0);
  return {
    sample: true,
    account: { id: "act_sample", name: "Sample ad account", currency: "USD", timezone: "America/Chicago" },
    range,
    totals: {
      spend: totalSpend,
      impressions,
      clicks,
      reach: Math.round(impressions / 2.6),
      ctr: impressions ? (clicks / impressions) * 100 : 0,
      cpc: clicks ? totalSpend / clicks : 0,
      cpm: impressions ? (totalSpend / impressions) * 1000 : 0,
      frequency: 2.6,
      leads,
      cpl: leads ? totalSpend / leads : null,
    },
    daily,
    campaigns,
  };
}

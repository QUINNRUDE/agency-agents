// Lead finder: scrapes Google Maps through Apify's official Google Maps Scraper
// (compass/crawler-google-places), then checks each lead's own website for an
// email, phone and social links, for free. Apify's Free plan includes $5 of
// usage every month; every search is checked against what's left and capped, so
// on the Free plan nothing is ever charged to a card.
import { getSettings } from "./config.ts";
import { CrmError } from "./crm/types.ts";
import { auditWebsite, scoreProspect } from "./prospect.ts";
import { localDb, uid, type LeadJob, type Prospect } from "./store.ts";

const API = () => (process.env.APIFY_API_BASE || "https://api.apify.com").replace(/\/$/, "");
const ACTOR = "compass~crawler-google-places";
/** Apify's Free-tier price per scraped place for this Actor. Paid tiers pay less, so this is conservative. */
export const PRICE_PER_PLACE = 0.004;
/** Apify refuses a per-run cap below this. You're only charged for places actually scraped. */
const MIN_RUN_CAP = 0.5;
const MAX_RESULTS = 500;
const CONTACT_CONCURRENCY = 4;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

async function apify<T = Json>(path: string, token: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API()}/v2/${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new CrmError("Couldn't reach Apify. Check the connection and try again.", 502);
  }
  const body = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) {
    const message = str(obj(body.error).message) || res.statusText;
    if (res.status === 401) throw new CrmError("Apify rejected the token. Create a new one in Apify Console → Settings → API & Integrations and paste it in Settings → Lead finder.", 401);
    if (res.status === 402 || /usage|limit|credit|exceed/i.test(message)) throw new CrmError(`Apify says: ${message}`, 402);
    throw new CrmError(`Apify error ${res.status}: ${message}`, 502);
  }
  return body as T;
}

export interface ApifyUsage {
  username: string;
  plan: string;
  free: boolean;
  creditUsd: number;
  usedUsd: number;
  leftUsd: number;
  resetsAt: string;
  /** How many more leads this month's credit covers at the Free-tier price. */
  leadsLeft: number;
}

/** The account's plan and how much of this month's included usage is left. */
export async function apifyUsage(token = getSettings().apifyToken): Promise<ApifyUsage> {
  if (!token) throw new CrmError("Connect Apify in Settings → Lead finder first. A free Apify account works.", 400);
  const [me, limits] = await Promise.all([apify<{ data?: Json }>("users/me", token), apify<{ data?: Json }>("users/me/limits", token)]);
  const plan = obj(obj(me.data).plan);
  const credit = num(plan.monthlyUsageCreditsUsd) ?? 5;
  const used = num(obj(obj(limits.data).current).monthlyUsageUsd) ?? 0;
  const left = Math.max(0, Math.round((credit - used) * 100) / 100);
  return {
    username: str(obj(me.data).username),
    plan: str(plan.id) || "FREE",
    free: (num(plan.monthlyBasePriceUsd) ?? 0) === 0,
    creditUsd: credit,
    usedUsd: Math.round(used * 100) / 100,
    leftUsd: left,
    resetsAt: str(obj(obj(limits.data).monthlyUsageCycle).endAt),
    leadsLeft: Math.floor(left / PRICE_PER_PLACE),
  };
}

export const estimateUsd = (n: number) => Math.round(n * PRICE_PER_PLACE * 100) / 100;

const jobs = {
  get: (id: string) => localDb.read().leadJobs.find((j) => j.id === id),
  save: (job: LeadJob) =>
    localDb.update((d) => {
      d.leadJobs = [job, ...d.leadJobs.filter((j) => j.id !== job.id)].slice(0, 25);
    }),
};

/** Starts a Google Maps search on Apify. Refuses anything this month's included credit can't cover. */
export async function startLeadSearch(input: { niche?: unknown; location?: unknown; max?: unknown }): Promise<LeadJob> {
  const token = getSettings().apifyToken;
  if (!token) throw new CrmError("Connect Apify in Settings → Lead finder first. A free Apify account works.", 400);
  const niche = str(input.niche).trim().slice(0, 80);
  const location = str(input.location).trim().slice(0, 120);
  if (!niche || !location) throw new CrmError("Enter a type of business and a city or area.", 400);
  const max = Math.min(MAX_RESULTS, Math.max(5, Math.round(Number(input.max) || 50)));
  const usage = await apifyUsage(token);
  const estimate = estimateUsd(max);
  if (estimate > usage.leftUsd) {
    throw new CrmError(
      usage.leadsLeft >= 5
        ? `That search could use about $${estimate.toFixed(2)}, and $${usage.leftUsd.toFixed(2)} of this month's free Apify credit is left. Search for ${usage.leadsLeft} or fewer.`
        : `This month's free Apify credit is used up${usage.resetsAt ? `. It resets on ${new Date(usage.resetsAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}.`,
      402,
    );
  }
  // The cap is a ceiling (Apify's minimum is $0.50); only scraped places are charged. On the Free
  // plan, Apify also stops when the included credit runs out, so nothing reaches a card.
  const cap = Math.max(MIN_RUN_CAP, Math.ceil(estimate * 1.25 * 100) / 100);
  const run = await apify<{ data?: Json }>(`acts/${ACTOR}/runs?maxTotalChargeUsd=${cap}&timeout=1200`, token, {
    method: "POST",
    body: { searchStringsArray: [niche], locationQuery: location, maxCrawledPlacesPerSearch: max, language: "en", scrapeContacts: false },
  });
  const data = obj(run.data);
  const job: LeadJob = {
    id: uid("job"),
    niche,
    location,
    max,
    runId: str(data.id),
    datasetId: str(data.defaultDatasetId),
    status: "scraping",
    startedAt: new Date().toISOString(),
    error: "",
    found: 0,
    contactsToCheck: 0,
    contactsChecked: 0,
    emailsFound: 0,
    prospectIds: [],
    estimateUsd: estimate,
    costUsd: null,
  };
  if (!job.runId) throw new CrmError("Apify didn't start the search. Try again.", 502);
  jobs.save(job);
  return job;
}

/** Removes tracking parameters Google adds to business websites. */
export function cleanWebsite(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|gclid|fbclid|y_source)/i.test(k)) u.searchParams.delete(k);
    return u.toString().replace(/\?$/, "");
  } catch {
    return url;
  }
}

/** One Google Maps place from the Apify dataset → a prospect. Closed places are skipped. */
export function placeToProspect(item: Json, search: string, niche: string): Prospect | null {
  const name = str(item.title).trim();
  if (!name || item.permanentlyClosed === true || item.temporarilyClosed === true) return null;
  const reviews = num(item.reviewsCount) ?? 0;
  return {
    id: uid("pr"),
    placeId: str(item.placeId) || `apify:${str(item.cid) || name}`,
    name,
    category: str(item.categoryName) || niche,
    address: str(item.address),
    city: str(item.city),
    phone: str(item.phoneUnformatted) || str(item.phone),
    website: cleanWebsite(str(item.website)),
    rating: reviews ? num(item.totalScore) : null,
    reviews,
    mapsUrl: str(item.url),
    score: 0,
    signals: [],
    audit: null,
    status: "new",
    contactId: null,
    sample: false,
    foundAt: new Date().toISOString(),
    search,
    source: "apify",
    email: strs(item.emails)[0] ?? "",
    socials: [...strs(item.facebooks), ...strs(item.instagrams), ...strs(item.linkedIns)].slice(0, 6),
  };
}

/** Saves found prospects, keeping what you already did with any you'd found before (audit, status, contact). */
export function mergeProspects(found: Prospect[]): Prospect[] {
  const byPlace = new Map(localDb.read().prospects.map((p) => [p.placeId, p]));
  const merged = found.map((p) => {
    const prev = byPlace.get(p.placeId);
    return scoreProspect(
      prev
        ? { ...p, id: prev.id, audit: prev.audit, status: prev.status, contactId: prev.contactId, email: p.email || prev.email, phone: p.phone || prev.phone, socials: p.socials?.length ? p.socials : prev.socials }
        : p,
    );
  });
  localDb.update((d) => {
    const ids = new Set(merged.map((m) => m.placeId));
    d.prospects = [...merged, ...d.prospects.filter((p) => !ids.has(p.placeId))].slice(0, 3000);
  });
  return merged;
}

const inFlight = new Map<string, Promise<void>>();
const scanning = new Set<string>();

async function collect(job: LeadJob, token: string): Promise<void> {
  const run = await apify<{ data?: Json }>(`actor-runs/${job.runId}`, token);
  const data = obj(run.data);
  const status = str(data.status);
  if (status === "READY" || status === "RUNNING") return;
  const items = await apify<unknown>(`datasets/${job.datasetId}/items?clean=true&format=json&limit=${job.max}`, token);
  const list = (Array.isArray(items) ? items : []).map(obj);
  const search = `${job.niche} in ${job.location}`;
  const prospects = list.map((i) => placeToProspect(i, search, job.niche)).filter((p): p is Prospect => p !== null);
  const usd = num(data.usageTotalUsd);
  if (!prospects.length) {
    jobs.save({
      ...job,
      status: "failed",
      finishedAt: new Date().toISOString(),
      costUsd: usd,
      error: status === "SUCCEEDED" ? `Google Maps had no open businesses for “${job.niche}” in ${job.location}. Try a broader area or a different wording.` : `The search stopped on Apify (${status.toLowerCase()}). Try again.`,
    });
    return;
  }
  const merged = mergeProspects(prospects);
  const toCheck = merged.filter((p) => p.website && !p.audit);
  jobs.save({
    ...job,
    status: toCheck.length ? "finding-contacts" : "done",
    finishedAt: toCheck.length ? undefined : new Date().toISOString(),
    found: merged.length,
    prospectIds: merged.map((p) => p.id),
    contactsToCheck: toCheck.length,
    contactsChecked: 0,
    emailsFound: merged.filter((p) => p.email).length,
    costUsd: usd,
  });
  if (toCheck.length) void scanContacts(job.id);
}

/** Checks each lead's website for an email, phone and social links. Free: it runs on your server. */
async function scanContacts(jobId: string): Promise<void> {
  if (scanning.has(jobId)) return;
  scanning.add(jobId);
  try {
    const job = jobs.get(jobId);
    if (!job) return;
    const ids = new Set(job.prospectIds);
    const queue = localDb.read().prospects.filter((p) => ids.has(p.id) && p.website && !p.audit);
    const worker = async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const audit = await auditWebsite(p.website).catch(() => null);
        const id = p.id;
        localDb.update((d) => {
          d.prospects = d.prospects.map((x) => {
            if (x.id !== id || !audit) return x;
            return scoreProspect({
              ...x,
              audit,
              email: x.email || audit.emails?.[0] || "",
              phone: x.phone || audit.phones?.[0] || "",
              socials: [...new Set([...(x.socials ?? []), ...(audit.socials ?? [])])].slice(0, 6),
            });
          });
          const j = d.leadJobs.find((y) => y.id === jobId);
          if (j) {
            j.contactsChecked++;
            j.emailsFound = d.prospects.filter((x) => ids.has(x.id) && x.email).length;
          }
        });
      }
    };
    await Promise.all(Array.from({ length: CONTACT_CONCURRENCY }, worker));
  } finally {
    scanning.delete(jobId);
    localDb.update((d) => {
      const j = d.leadJobs.find((y) => y.id === jobId);
      if (j && j.status === "finding-contacts") {
        j.status = "done";
        j.finishedAt = new Date().toISOString();
      }
    });
  }
}

/** Moves a job along and returns it with its leads so far. */
export async function refreshLeadJob(id: string): Promise<{ job: LeadJob; prospects: Prospect[] }> {
  const job = jobs.get(id);
  if (!job) throw new CrmError("That search wasn't found. Start a new one.", 404);
  const token = getSettings().apifyToken;
  if (job.status === "scraping") {
    if (!token) throw new CrmError("Connect Apify in Settings → Lead finder first.", 400);
    let p = inFlight.get(id);
    if (!p) {
      p = collect(job, token).finally(() => inFlight.delete(id));
      inFlight.set(id, p);
    }
    await p;
  } else if (job.status === "finding-contacts" && !scanning.has(id)) {
    // The server restarted while checking websites: pick up where it left off.
    void scanContacts(id);
  }
  const now = jobs.get(id) ?? job;
  const ids = new Set(now.prospectIds);
  return { job: now, prospects: localDb.read().prospects.filter((p) => ids.has(p.id)).sort((a, b) => b.score - a.score) };
}

export function recentLeadJobs(): LeadJob[] {
  return localDb.read().leadJobs.slice(0, 10);
}

// "Find clients": search local businesses (Google Places API, New), audit
// their websites, and score each one as an opportunity for the user's offer.
import dns from "node:dns/promises";
import net from "node:net";
import { getSettings } from "./config.ts";
import { demoDataOn } from "./crm/index.ts";
import { CrmError } from "./crm/types.ts";
import { uid, type Prospect, type SiteAudit } from "./store.ts";

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.googleMapsUri",
  "places.primaryTypeDisplayName",
  "places.businessStatus",
  "nextPageToken",
].join(",");

interface PlacesResponse {
  places?: {
    id: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    addressComponents?: { longText?: string; types?: string[] }[];
    nationalPhoneNumber?: string;
    internationalPhoneNumber?: string;
    websiteUri?: string;
    rating?: number;
    userRatingCount?: number;
    googleMapsUri?: string;
    primaryTypeDisplayName?: { text?: string };
    businessStatus?: string;
  }[];
  nextPageToken?: string;
  error?: { message?: string; status?: string };
}

export interface SearchInput {
  niche: string;
  location: string;
  maxResults?: number;
  minRating?: number;
  onlyNoWebsite?: boolean;
}

export async function searchBusinesses(input: SearchInput): Promise<{ prospects: Prospect[]; sample: boolean }> {
  const key = getSettings().googlePlacesApiKey;
  const search = `${input.niche} in ${input.location}`.trim();
  if (!key) {
    if (!demoDataOn()) throw new CrmError("Connect Apify (a free account works) in Settings → Lead finder, or add a Google Places key, to search real businesses.", 400);
    return { prospects: sampleProspects(input, search), sample: true };
  }

  const max = Math.min(input.maxResults ?? 40, 60);
  const out: Prospect[] = [];
  let pageToken: string | undefined;
  do {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELD_MASK },
      body: JSON.stringify({ textQuery: search, pageSize: 20, ...(pageToken ? { pageToken } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json()) as PlacesResponse;
    if (!res.ok) {
      throw new Error(
        res.status === 403
          ? `Google Places refused the key: ${data.error?.message ?? "enable “Places API (New)” for this key in Google Cloud."}`
          : `Google Places error ${res.status}: ${data.error?.message ?? res.statusText}`,
      );
    }
    for (const p of data.places ?? []) {
      if (p.businessStatus && p.businessStatus !== "OPERATIONAL") continue;
      const city = p.addressComponents?.find((c) => c.types?.includes("locality"))?.longText ?? "";
      out.push(
        scoreProspect({
          id: uid("pr"),
          placeId: p.id,
          name: p.displayName?.text ?? "Unknown business",
          category: p.primaryTypeDisplayName?.text ?? input.niche,
          address: p.formattedAddress ?? "",
          city,
          phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? "",
          website: p.websiteUri ?? "",
          rating: p.rating ?? null,
          reviews: p.userRatingCount ?? 0,
          mapsUrl: p.googleMapsUri ?? "",
          score: 0,
          signals: [],
          audit: null,
          status: "new",
          contactId: null,
          sample: false,
          foundAt: new Date().toISOString(),
          search,
        }),
      );
    }
    pageToken = data.nextPageToken;
    // Google needs a moment before a next-page token becomes valid.
    if (pageToken && out.length < max) await new Promise((r) => setTimeout(r, 1500));
  } while (pageToken && out.length < max);

  const filtered = out.filter(
    (p) => (input.minRating ? (p.rating ?? 0) >= input.minRating || p.rating === null : true) && (input.onlyNoWebsite ? !p.website : true),
  );
  return { prospects: filtered.slice(0, max).sort((a, b) => b.score - a.score), sample: false };
}

/** Opportunity score, 0–100: how much this business likely needs what an agency sells. */
export function scoreProspect(p: Prospect): Prospect {
  let score = 40;
  const signals: string[] = [];
  if (!p.website) {
    score += 25;
    signals.push("No website");
  }
  if (p.rating !== null && p.rating < 4) {
    score += 10;
    signals.push(`Rating ${p.rating.toFixed(1)}`);
  }
  // OpenStreetMap has no reviews, so the count says nothing there.
  if (p.source === "osm") {
    /* no review signal */
  } else if (p.reviews < 30) {
    score += 12;
    signals.push(`Only ${p.reviews} reviews`);
  } else if (p.reviews < 100) {
    score += 5;
    signals.push(`${p.reviews} reviews`);
  }
  if (!p.phone) {
    score -= 15;
    signals.push("No phone listed");
  }
  const a = p.audit;
  if (a) {
    if (!a.ok) {
      score += 15;
      signals.push("Website down");
    } else {
      if (!a.https) (score += 8), signals.push("No HTTPS");
      if (!a.mobileViewport) (score += 10), signals.push("Not mobile-friendly");
      if (!a.hasForm) (score += 6), signals.push("No lead form");
      if (!a.bookingWidget) (score += 6), signals.push("No online booking");
      if (!a.analytics.length) (score += 5), signals.push("No tracking pixels");
      if (a.responseMs !== null && a.responseMs > 3000) (score += 6), signals.push("Slow site");
      if (a.copyrightYear && a.copyrightYear < new Date().getFullYear() - 1) (score += 5), signals.push(`© ${a.copyrightYear}`);
    }
  }
  return { ...p, score: Math.max(0, Math.min(100, score)), signals };
}

// ---- Website audit -----------------------------------------------------

// Tests serve sample websites from localhost; never set this in production.
const ALLOW_PRIVATE = process.env.BLOOM_AUDIT_ALLOW_PRIVATE === "1";

function isPrivateIp(ip: string): boolean {
  if (ALLOW_PRIVATE) return false;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:127.") || v === "::";
}

const BOOKING = [
  ["calendly.com", "Calendly"], ["leadconnectorhq.com", "GoHighLevel"], ["msgsndr.com", "GoHighLevel"], ["acuityscheduling", "Acuity"],
  ["squareup.com/appointments", "Square"], ["vagaro", "Vagaro"], ["mindbodyonline", "Mindbody"], ["zocdoc", "Zocdoc"], ["housecallpro", "Housecall Pro"],
  ["servicetitan", "ServiceTitan"], ["jobber", "Jobber"], ["booksy", "Booksy"], ["setmore", "Setmore"], ["opentable", "OpenTable"],
] as const;
const CHAT = [
  ["intercom", "Intercom"], ["drift.com", "Drift"], ["tawk.to", "Tawk"], ["livechatinc", "LiveChat"], ["podium", "Podium"], ["birdeye", "Birdeye"],
  ["hs-scripts.com", "HubSpot"], ["leadconnectorhq.com/loader", "GHL chat widget"], ["crisp.chat", "Crisp"], ["zdassets", "Zendesk"],
] as const;
const ANALYTICS = [
  ["googletagmanager.com", "Google Tag Manager"], ["gtag(", "Google Analytics"], ["google-analytics.com", "Google Analytics"],
  ["fbq(", "Meta Pixel"], ["connect.facebook.net", "Meta Pixel"], ["hotjar", "Hotjar"], ["clarity.ms", "Microsoft Clarity"], ["callrail", "CallRail"],
] as const;

// ---- Contact details on a business website ------------------------------

const JUNK_EMAIL = /\.(png|jpe?g|gif|svg|webp|css|js)$|@(sentry|wixpress|example|domain|email|yourdomain|yoursite|mysite|company)\.|^(name|your|you|email|user|username|test)@|@2x|u00/i;
const SOCIAL = /https?:\/\/(?:www\.)?(facebook\.com|instagram\.com|linkedin\.com\/(?:company|in)|youtube\.com|tiktok\.com|x\.com|twitter\.com)\/[^"'\s<>?#]+/gi;

/** Emails, phone numbers and social profiles published on a page. */
export function extractContacts(html: string): { emails: string[]; phones: string[]; socials: string[] } {
  const decoded = html.replace(/&#64;|&#x40;|\[at\]|\(at\)/gi, "@").replace(/&#46;|&#x2e;/gi, ".");
  const emails = new Set<string>();
  for (const m of decoded.matchAll(/mailto:([^"'?\s>]+)/gi)) emails.add(decodeURIComponent(m[1]).toLowerCase());
  for (const m of decoded.matchAll(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi)) emails.add(m[0].toLowerCase());
  const phones = new Set<string>();
  for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) {
    const digits = decodeURIComponent(m[1]).replace(/[^\d+]/g, "");
    const n = digits.replace(/^\+?1(?=\d{10}$)/, "");
    if (/^\d{10}$/.test(n)) phones.add(`+1${n}`);
    else if (/^\+\d{8,15}$/.test(digits)) phones.add(digits);
  }
  const socials = new Set<string>();
  for (const m of html.matchAll(SOCIAL)) {
    const url = m[0].replace(/\/$/, "");
    if (!/sharer|share\?|\/share|intent\/|dialog\/|plugins\/|\/tr$|\/p\/|\/watch|\/embed/i.test(url)) socials.add(url);
  }
  return {
    emails: [...emails].filter((e) => !JUNK_EMAIL.test(e) && e.length < 80).slice(0, 5),
    phones: [...phones].slice(0, 3),
    socials: [...socials].slice(0, 6),
  };
}

/** Finds the site's contact page link, if it has one on the same host. */
function contactPageUrl(html: string, base: string): string | null {
  for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    if (!/contact|get-in-touch|reach-us|about/i.test(m[1])) continue;
    try {
      const u = new URL(m[1], base);
      if (u.hostname === new URL(base).hostname && /^https?:$/.test(u.protocol)) return u.toString();
    } catch {
      /* not a usable link */
    }
  }
  return null;
}

export async function auditWebsite(rawUrl: string): Promise<SiteAudit> {
  const findings: SiteAudit["findings"] = [];
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const base: SiteAudit = {
    url,
    ok: false,
    statusCode: null,
    https: url.startsWith("https://"),
    responseMs: null,
    title: "",
    metaDescription: false,
    mobileViewport: false,
    hasForm: false,
    hasClickToCall: false,
    bookingWidget: null,
    chatWidget: null,
    analytics: [],
    copyrightYear: null,
    findings,
    checkedAt: new Date().toISOString(),
  };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    findings.push({ level: "bad", text: "Website address is not a valid URL." });
    return base;
  }
  try {
    const { address } = await dns.lookup(parsed.hostname);
    if (isPrivateIp(address)) {
      findings.push({ level: "bad", text: "Refusing to audit a private or local address." });
      return base;
    }
  } catch {
    findings.push({ level: "bad", text: "Domain does not resolve — the website appears to be offline." });
    return base;
  }

  const started = performance.now();
  let res: globalThis.Response;
  try {
    res = await fetch(parsed, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BloomAudit/1.0)", Accept: "text/html" },
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    findings.push({ level: "bad", text: "Website did not respond within 12 seconds." });
    return base;
  }
  const html = (await res.text()).slice(0, 1_500_000);
  const lower = html.toLowerCase();
  const ms = Math.round(performance.now() - started);

  const audit: SiteAudit = {
    ...base,
    url: res.url || url,
    ok: res.ok,
    statusCode: res.status,
    https: (res.url || url).startsWith("https://"),
    responseMs: ms,
    title: (/<title[^>]*>([^<]{0,200})<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim(),
    metaDescription: /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{20,}/i.test(html),
    mobileViewport: /<meta[^>]+name=["']viewport["']/i.test(html),
    hasForm: /<form[\s>]/i.test(html) || lower.includes("typeform") || lower.includes("jotform"),
    hasClickToCall: /href=["']tel:/i.test(html),
    bookingWidget: BOOKING.find(([needle]) => lower.includes(needle))?.[1] ?? null,
    chatWidget: CHAT.find(([needle]) => lower.includes(needle))?.[1] ?? null,
    analytics: [...new Set(ANALYTICS.filter(([needle]) => lower.includes(needle)).map(([, n]) => n))],
    copyrightYear: (() => {
      const years = [...html.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map((m) => Number(m[1])).filter((y) => y > 1995 && y <= new Date().getFullYear());
      return years.length ? Math.max(...years) : null;
    })(),
    findings,
  };

  // Contact details: the homepage first, then the contact page if the homepage has no email.
  const contacts = extractContacts(html);
  if (!contacts.emails.length && audit.ok) {
    const page = contactPageUrl(html, audit.url);
    if (page) {
      try {
        const r = await fetch(page, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; BloomAudit/1.0)", Accept: "text/html" }, signal: AbortSignal.timeout(8_000) });
        if (r.ok && new URL(r.url || page).hostname === new URL(audit.url).hostname) {
          const more = extractContacts((await r.text()).slice(0, 1_000_000));
          contacts.emails.push(...more.emails.filter((e) => !contacts.emails.includes(e)));
          contacts.phones.push(...more.phones.filter((p) => !contacts.phones.includes(p)));
          contacts.socials.push(...more.socials.filter((x) => !contacts.socials.includes(x)));
        }
      } catch {
        /* the homepage results stand */
      }
    }
  }
  audit.emails = contacts.emails.slice(0, 5);
  audit.phones = contacts.phones.slice(0, 3);
  audit.socials = contacts.socials.slice(0, 6);

  if (!audit.ok) findings.push({ level: "bad", text: `Website returned HTTP ${audit.statusCode}.` });
  findings.push(audit.https ? { level: "good", text: "Served over HTTPS." } : { level: "bad", text: "No HTTPS — browsers show “Not secure”." });
  findings.push(
    ms > 3000 ? { level: "bad", text: `Slow first response (${(ms / 1000).toFixed(1)}s).` } : ms > 1500 ? { level: "warn", text: `First response ${(ms / 1000).toFixed(1)}s.` } : { level: "good", text: `Fast first response (${ms} ms).` },
  );
  findings.push(audit.mobileViewport ? { level: "good", text: "Mobile viewport set." } : { level: "bad", text: "Not set up for mobile." });
  findings.push(audit.title ? { level: "good", text: `Title: “${audit.title.slice(0, 70)}”` } : { level: "warn", text: "Missing page title." });
  if (!audit.metaDescription) findings.push({ level: "warn", text: "No meta description — weak search snippet." });
  findings.push(audit.hasForm ? { level: "good", text: "Has a lead/contact form." } : { level: "bad", text: "No lead capture form found." });
  findings.push(audit.hasClickToCall ? { level: "good", text: "Click-to-call phone link." } : { level: "warn", text: "Phone number isn't click-to-call." });
  findings.push(audit.bookingWidget ? { level: "good", text: `Online booking via ${audit.bookingWidget}.` } : { level: "warn", text: "No online booking." });
  if (audit.chatWidget) findings.push({ level: "good", text: `Chat widget: ${audit.chatWidget}.` });
  findings.push(audit.analytics.length ? { level: "good", text: `Tracking: ${audit.analytics.join(", ")}.` } : { level: "bad", text: "No analytics or ad pixels — can't measure marketing." });
  if (audit.copyrightYear && audit.copyrightYear < new Date().getFullYear() - 1) findings.push({ level: "warn", text: `Footer copyright ${audit.copyrightYear} — site may be stale.` });
  return audit;
}

// ---- Sample data when no Places key is configured ------------------------

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function sampleProspects(input: SearchInput, search: string): Prospect[] {
  let seed = hash(search.toLowerCase());
  const r = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const niche = input.niche.trim() || "Business";
  const cap = niche.replace(/\b\w/g, (m) => m.toUpperCase()).replace(/s$/, "");
  const city = input.location.split(",")[0].trim() || "Springfield";
  const prefixes = ["Premier", "Elite", "Family", "Precision", "Summit", "Hometown", "Bright", "Allied", "Classic", "Liberty", "Modern", "Heritage", "Valley", "Metro", "Northgate", "Southside", "Lakeside", "First Choice", "Trusted", "Golden"];
  const n = Math.min(input.maxResults ?? 20, 20);
  const out: Prospect[] = [];
  const start = Math.floor(r() * prefixes.length);
  for (let i = 0; i < n; i++) {
    const name = `${prefixes[(start + i) % prefixes.length]} ${cap}${i % 3 === 0 ? ` of ${city}` : i % 3 === 1 ? " Co." : " Group"}`;
    const hasSite = r() > 0.3;
    const reviews = Math.floor(r() * r() * 400);
    const rating = Math.round((3.2 + r() * 1.8) * 10) / 10;
    const p = scoreProspect({
      id: uid("pr"),
      placeId: `sample_${hash(name + city)}`,
      name,
      category: cap,
      address: `${100 + Math.floor(r() * 8900)} ${["Main St", "Oak Ave", "Commerce Dr", "Park Blvd", "Market St", "Elm St"][i % 6]}, ${city}`,
      city,
      phone: r() > 0.1 ? `+1 (555) 01${String(10 + i).padStart(2, "0")}` : "",
      website: hasSite ? `https://example.com/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : "",
      rating: reviews ? rating : null,
      reviews,
      mapsUrl: "",
      score: 0,
      signals: [],
      audit: null,
      status: "new",
      contactId: null,
      sample: true,
      foundAt: new Date().toISOString(),
      search,
    });
    if (input.onlyNoWebsite && p.website) continue;
    if (input.minRating && p.rating !== null && p.rating < input.minRating) continue;
    out.push(p);
  }
  return out.sort((a, b) => b.score - a.score);
}

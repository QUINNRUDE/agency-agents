// Free lead source: OpenStreetMap. No key, no account, no limit. The location is looked up
// with Nominatim and businesses are pulled from the Overpass API by their map tags and by
// name. OpenStreetMap lists fewer businesses than Google and has no ratings, but most
// listings have a phone or website, and Bloom AI checks each website for an email.
// Data © OpenStreetMap contributors, available under the Open Database License.
import { CrmError } from "./crm/types.ts";
import { scoreProspect } from "./prospect.ts";
import { uid, type Prospect } from "./store.ts";

const UA = "BloomAI/1.0 (self-hosted CRM; free lead finder)";
const NOMINATIM = () => (process.env.OSM_NOMINATIM_URL || "https://nominatim.openstreetmap.org").replace(/\/$/, "");
const OVERPASS = () => (process.env.OSM_OVERPASS_URL ? [process.env.OSM_OVERPASS_URL] : ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]);

type Tags = Record<string, string>;
interface Element {
  type: string;
  id: number;
  tags?: Tags;
}

// How each common niche is tagged on the map, plus the words its business names use.
const NICHES: { match: RegExp; tags: string[]; name: string }[] = [
  { match: /roof/i, tags: ['["craft"="roofer"]'], name: "roof" },
  { match: /plumb/i, tags: ['["craft"="plumber"]'], name: "plumb" },
  { match: /hvac|heating|cooling|air ?condition/i, tags: ['["craft"="hvac"]'], name: "hvac|heating|air condition|cooling" },
  { match: /electric/i, tags: ['["craft"="electrician"]'], name: "electric" },
  { match: /dent|orthodon/i, tags: ['["amenity"="dentist"]', '["healthcare"="dentist"]'], name: "dental|dentist|orthodont" },
  { match: /chiro/i, tags: ['["healthcare:speciality"~"chiropract"]', '["healthcare"="chiropractor"]'], name: "chiropract" },
  { match: /med ?spa|aesthetic|botox|laser/i, tags: ['["leisure"="spa"]', '["shop"="beauty"]["beauty"~"spa|laser|skin"]'], name: "med ?spa|medspa|aesthetic|laser|skin" },
  { match: /salon|hair|barber/i, tags: ['["shop"="hairdresser"]', '["shop"="beauty"]'], name: "salon|hair|barber" },
  { match: /landscap|lawn|garden|tree/i, tags: ['["craft"="gardener"]', '["shop"="garden_centre"]'], name: "landscap|lawn|garden|tree" },
  { match: /law|attorney|lawyer|legal/i, tags: ['["office"="lawyer"]'], name: "law|attorney|legal" },
  { match: /auto|car|mechanic|collision|tire/i, tags: ['["shop"="car_repair"]', '["shop"="tyres"]'], name: "auto|car repair|mechanic|collision|tire" },
  { match: /real ?estate|realt/i, tags: ['["office"="estate_agent"]'], name: "realty|real estate|realtor|properties" },
  { match: /gym|fitness|crossfit|yoga|pilates/i, tags: ['["leisure"="fitness_centre"]', '["sport"="yoga"]'], name: "gym|fitness|crossfit|yoga|pilates" },
  { match: /vet|animal|pet/i, tags: ['["amenity"="veterinary"]', '["shop"="pet_grooming"]'], name: "vet|animal|pet" },
  { match: /paint/i, tags: ['["craft"="painter"]'], name: "paint" },
  { match: /clean|maid|janitor/i, tags: ['["craft"="cleaning"]', '["shop"="dry_cleaning"]'], name: "clean|maid|janitor" },
  { match: /pest|termite|exterminat/i, tags: ['["craft"="pest_control"]'], name: "pest|termite|exterminat" },
  { match: /pool/i, tags: ['["craft"="swimming_pool_construction"]'], name: "pool" },
  { match: /solar/i, tags: ['["craft"="photovoltaic"]'], name: "solar" },
  { match: /restaurant|cafe|food/i, tags: ['["amenity"="restaurant"]', '["amenity"="cafe"]'], name: "restaurant|cafe|grill|kitchen" },
  { match: /account|cpa|bookkeep|tax/i, tags: ['["office"="accountant"]', '["office"="tax_advisor"]'], name: "account|cpa|bookkeep|tax" },
  { match: /insur/i, tags: ['["office"="insurance"]'], name: "insurance" },
  { match: /physical therap|physio/i, tags: ['["healthcare"="physiotherapist"]'], name: "physical therapy|physio" },
  { match: /contract|construct|remodel|build/i, tags: ['["craft"="builder"]', '["office"="construction_company"]'], name: "construction|contracting|remodel|builders" },
];
const NAME_KEYS = ["craft", "shop", "office", "amenity", "healthcare", "leisure"];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\"]/g, "\\$&");

/** Map tags and a name pattern for a business type, e.g. "roofers" → craft=roofer + names with "roof". */
export function nicheQuery(niche: string): { tags: string[]; name: string } {
  const known = NICHES.find((n) => n.match.test(niche));
  if (known) return { tags: known.tags, name: known.name };
  const words = niche
    .toLowerCase()
    .split(/[^a-z]+/)
    .map((w) => w.replace(/(ies)$/, "y").replace(/(ers|ists|ians|s)$/, ""))
    .filter((w) => w.length >= 4);
  if (!words.length) throw new CrmError("Describe the business type in a word or two, like “roofers” or “dentists”.", 400);
  return { tags: [], name: words.map(escapeRe).join("|") };
}

export interface Area {
  name: string;
  city: string;
  /** south, west, north, east */
  bbox: [number, number, number, number];
  lat: number;
  lon: number;
}

const geoCache = new Map<string, Area>();

/** City, state or ZIP → a search box. Big areas (a whole state) are narrowed to their center. */
export async function geocode(location: string): Promise<Area> {
  const key = location.trim().toLowerCase();
  const hit = geoCache.get(key);
  if (hit) return hit;
  const url = `${NOMINATIM()}/search?${new URLSearchParams({ q: location, format: "jsonv2", limit: "1", addressdetails: "1" })}`;
  let rows: { lat?: string; lon?: string; name?: string; display_name?: string; boundingbox?: string[]; address?: Record<string, string> }[];
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(String(res.status));
    rows = (await res.json()) as typeof rows;
  } catch {
    throw new CrmError("Couldn't look up that location right now. Try again in a minute.", 502);
  }
  const r = rows[0];
  if (!r?.boundingbox || r.boundingbox.length !== 4) throw new CrmError(`Couldn't find “${location}”. Try “City, State” or a ZIP code.`, 400);
  let [s, n, w, e] = r.boundingbox.map(Number);
  const lat = Number(r.lat);
  const lon = Number(r.lon);
  const MAX = 0.35; // about 25 miles each way
  if (n - s > MAX * 2) [s, n] = [lat - MAX, lat + MAX];
  if (e - w > MAX * 2) [w, e] = [lon - MAX, lon + MAX];
  const a = r.address ?? {};
  const area: Area = { name: r.display_name ?? location, city: a.city ?? a.town ?? a.village ?? r.name ?? "", bbox: [s, w, n, e], lat, lon };
  geoCache.set(key, area);
  return area;
}

/** A box reaching `miles` out from the area's center in every direction (your city and the towns around it). */
export function radiusBox(area: Area, miles: number): Area["bbox"] {
  const dLat = miles / 69;
  const dLon = miles / (69 * Math.cos((area.lat * Math.PI) / 180));
  return [area.lat - dLat, area.lon - dLon, area.lat + dLat, area.lon + dLon];
}

export function overpassQuery(q: { tags: string[]; name: string }, bbox: Area["bbox"], limit: number): string {
  const b = bbox.map((x) => x.toFixed(4)).join(",");
  const parts = [...q.tags.map((t) => `nwr${t}["name"](${b});`), ...NAME_KEYS.map((k) => `nwr["name"~"${q.name}",i]["${k}"](${b});`)];
  return `[out:json][timeout:40];(${parts.join("")});out center tags ${Math.min(1000, limit * 3)};`;
}

async function overpass(query: string): Promise<Element[]> {
  let last = "";
  for (const endpoint of OVERPASS()) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        last = `HTTP ${res.status}`;
        continue;
      }
      const data = (await res.json()) as { elements?: Element[] };
      return data.elements ?? [];
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
  }
  throw new CrmError(`OpenStreetMap is busy right now (${last}). Try again in a minute.`, 502);
}

const pretty = (v: string) => v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** First US-style phone in a tag value like "+1 512-555-0101; (512) 555-0102". */
export function cleanPhone(v: string): string {
  const first = v.split(/[;,]/)[0] ?? "";
  const digits = first.replace(/[^\d+]/g, "");
  const ten = digits.replace(/^\+?1(?=\d{10}$)/, "");
  if (/^\d{10}$/.test(ten)) return `+1${ten}`;
  return /^\+\d{8,15}$/.test(digits) ? digits : first.trim();
}

function cleanUrl(v: string): string {
  const u = (v.split(/[;\s]/)[0] ?? "").trim();
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

/** One map listing → a prospect. Closed or nameless places are skipped. */
export function elementToProspect(el: Element, search: string, niche: string, area: Area): Prospect | null {
  const t = el.tags ?? {};
  const name = (t.name ?? "").trim();
  if (!name || t.disused === "yes" || t.opening_hours === "closed" || Object.keys(t).some((k) => k.startsWith("disused:") || k.startsWith("was:"))) return null;
  const kind = t.craft ?? t.healthcare ?? t.office ?? t.shop ?? t.amenity ?? t.leisure ?? "";
  const street = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
  const city = t["addr:city"] ?? area.city;
  const address = [street, city, [t["addr:state"], t["addr:postcode"]].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const socials = [t["contact:facebook"] ?? t.facebook, t["contact:instagram"] ?? t.instagram, t["contact:linkedin"]]
    .filter((x): x is string => Boolean(x))
    .map((x) => (/^https?:/i.test(x) ? x : x.includes(".com") ? `https://${x}` : ""))
    .filter(Boolean);
  return scoreProspect({
    id: uid("pr"),
    placeId: `osm:${el.type}/${el.id}`,
    name,
    category: kind && kind !== "yes" ? pretty(kind) : niche,
    address,
    city,
    phone: cleanPhone(t.phone ?? t["contact:phone"] ?? t["contact:mobile"] ?? ""),
    website: cleanUrl(t.website ?? t["contact:website"] ?? t.url ?? ""),
    rating: null,
    reviews: 0,
    mapsUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    score: 0,
    signals: [],
    audit: null,
    status: "new",
    contactId: null,
    sample: false,
    foundAt: new Date().toISOString(),
    search,
    source: "osm",
    email: (t.email ?? t["contact:email"] ?? "").split(/[;\s]/)[0] ?? "",
    socials,
  });
}

/** Searches OpenStreetMap for a type of business in an area. Free, no key. */
export async function searchOsm(input: { niche?: unknown; location?: unknown; max?: unknown; radiusMiles?: unknown }): Promise<{ prospects: Prospect[]; area: string }> {
  const niche = String(input.niche ?? "").trim().slice(0, 80);
  const location = String(input.location ?? "").trim().slice(0, 120);
  if (!niche || !location) throw new CrmError("Enter a type of business and a city or area.", 400);
  const max = Math.min(300, Math.max(10, Math.round(Number(input.max) || 100)));
  const miles = Math.min(50, Math.max(0, Number(input.radiusMiles) || 0));
  const q = nicheQuery(niche);
  const area = await geocode(location);
  const elements = await overpass(overpassQuery(q, miles ? radiusBox(area, miles) : area.bbox, max));
  const search = `${niche} in ${location}`;
  const seen = new Set<string>();
  const out: Prospect[] = [];
  for (const el of elements) {
    const p = elementToProspect(el, search, niche, area);
    if (!p) continue;
    const key = `${p.name.toLowerCase().replace(/[^a-z0-9]/g, "")}|${p.phone.replace(/\D/g, "").slice(-10)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  // Listings you can actually reach first, then by opportunity score.
  out.sort((a, b) => Number(Boolean(b.phone || b.website)) - Number(Boolean(a.phone || a.website)) || b.score - a.score);
  return { prospects: out.slice(0, max), area: area.name };
}

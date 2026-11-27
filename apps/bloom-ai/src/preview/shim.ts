// Preview build only: answers the app's /api calls from a snapshot of the demo workspace
// (preview-data.json, published next to the page) so the real UI runs with no server.
// Anything that would change data, send a message or reach an outside service is refused
// with a clear message instead.
import { CTAS, SAMPLE_PLACES, templateCopy, type Cta } from "../../server/adTemplates.ts";

export const PREVIEW = Boolean(import.meta.env.VITE_PREVIEW);

const SAMPLE_ASSETS = {
  connected: false,
  adAccounts: [{ id: "act_sample", name: "Sample ad account", currency: "USD", active: true }],
  pages: [{ id: "sample_page", name: "Your business", instagram: { id: "sample_ig", username: "yourbusiness" } }],
  defaults: { adAccountId: "act_sample", pageId: "sample_page" },
};

type Json = Record<string, unknown>;
interface Snapshot {
  routes: Record<string, unknown>;
  contacts: Json[];
  bundles: Record<string, Json>;
  threads: Record<string, Json>;
  opportunities: Json[];
  agents: Record<string, Json>;
  log: Json[];
  prospectSearches: Record<string, unknown>;
}

const NOT_SAVED = "This is a preview with demo data, so changes aren't saved and nothing is sent. Run or host Bloom AI to use it for real.";

const OPTED_OUT = ["opted-out", "dnd", "do-not-contact"];
const COLD = ["prospect", "cold-list"];
const CONSENT = ["sms-ok", "sms-consent", "opted-in"];
const DECLINED = ["no-texts"];

/** Same audience + eligibility rules as the server, computed from the snapshot. */
function previewBroadcast(d: Snapshot, b: Json) {
  const channel = b.channel === "Email" ? "Email" : "SMS";
  const a = (b.audience ?? { kind: "all" }) as Json;
  const tagsOf = (c: Json) => ((c.tags as string[]) ?? []).map((t) => t.toLowerCase());
  const won = new Set(d.opportunities.filter((o) => o.status === "won").map((o) => String(o.contactId)));
  let picked = d.contacts;
  let label = "Everyone";
  if (a.kind === "customers") (picked = d.contacts.filter((c) => won.has(String(c.id)))), (label = "Customers (won a deal)");
  else if (a.kind === "tag") (picked = d.contacts.filter((c) => tagsOf(c).includes(String(a.tag).toLowerCase()))), (label = `Tag “${a.tag}”`);
  else if (a.kind === "stage") {
    const ids = new Set(d.opportunities.filter((o) => o.stageId === a.stageId && o.status === "open").map((o) => String(o.contactId)));
    picked = d.contacts.filter((c) => ids.has(String(c.id)));
    label = "Pipeline stage";
  } else if (a.kind === "contacts") {
    const ids = new Set(((a.contactIds as unknown[]) ?? []).map(String));
    picked = d.contacts.filter((c) => ids.has(String(c.id)));
    label = `${ids.size} selected contacts`;
  }
  const excluded: Record<string, number> = {};
  const eligible = picked.filter((c) => {
    const t = tagsOf(c);
    const why = c.dnd || t.some((x) => OPTED_OUT.includes(x))
      ? "Opted out / DND"
      : channel === "SMS" && !c.phone
        ? "No phone number"
        : channel === "Email" && !c.email
          ? "No email address"
          : channel === "SMS" && (t.some((x) => DECLINED.includes(x)) || (t.some((x) => COLD.includes(x)) && !t.some((x) => CONSENT.includes(x))))
            ? "No permission to text"
            : null;
    if (why) excluded[why] = (excluded[why] ?? 0) + 1;
    return !why;
  });
  const first = eligible[0];
  const fill = (s: string, c: Json) =>
    s
      .replace(/\{\{\s*first_name\s*\}\}/g, String(c.firstName || String(c.name ?? "").split(" ")[0] || "there"))
      .replace(/\{\{\s*company\s*\}\}/g, String(c.companyName ?? ""))
      .replace(/\{\{\s*city\s*\}\}/g, String(c.city ?? ""))
      .replace(/\{\{\s*my_name\s*\}\}/g, "the team")
      .replace(/\{\{\s*agency\s*\}\}/g, "our office")
      .replace(/\{\{\s*\w+\s*\}\}/g, "")
      .trim();
  let sampleText = first && b.message ? fill(String(b.message), first) : "";
  if (sampleText && channel === "SMS" && b.optOutLine !== false && !/\bstop\b/i.test(sampleText)) sampleText += "\nReply STOP to opt out.";
  return { label, total: picked.length, eligible: eligible.length, excluded, sample: eligible.slice(0, 6).map((c) => c.name), sampleText, sampleName: first?.name ?? "" };
}

let snapshot: Promise<Snapshot> | null = null;
const load = () => (snapshot ??= fetch("./preview-data.json").then((r) => r.json() as Promise<Snapshot>));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function handle(url: URL, method: string, body: unknown): Promise<Response> {
  const d = await load();
  const p = url.pathname;
  const q = url.searchParams;
  if (method !== "GET") {
    if (p === "/api/meta/ad-copy") {
      const b = (body ?? {}) as Json;
      const t = (k: string) => String(b[k] ?? "");
      const cta = (t("cta") in CTAS ? t("cta") : "GET_QUOTE") as Cta;
      return json({ ai: false, variants: templateCopy({ business: t("business"), offer: t("offer"), audience: t("audience"), place: t("place"), notes: t("notes"), cta }) });
    }
    if (p === "/api/broadcasts/preview") return json(previewBroadcast(d, (body ?? {}) as Json));
    if (p === "/api/prospects/search") {
      const niche = String((body as Json)?.niche ?? "").trim().toLowerCase();
      const hit = d.prospectSearches[niche];
      if (hit) return json(hit);
      return json({ error: `The preview has sample searches for: ${Object.keys(d.prospectSearches).join(", ")}. Pick one of the chips to try it.` }, 400);
    }
    return json({ error: NOT_SAVED }, 400);
  }
  const exact = d.routes[p + url.search] ?? d.routes[p];
  if (exact !== undefined && !/^\/api\/(contacts|opportunities|automation-log)$/.test(p)) return json(exact);

  if (p === "/api/contacts") {
    const term = (q.get("q") ?? "").toLowerCase();
    const limit = Number(q.get("limit") ?? 500);
    const list = d.contacts.filter((c) => !term || JSON.stringify([c.name, c.companyName, c.email, c.phone, c.city, c.tags]).toLowerCase().includes(term));
    return json(list.slice(0, limit));
  }
  let m = /^\/api\/contacts\/([^/]+)$/.exec(p);
  if (m) return d.bundles[m[1]] ? json(d.bundles[m[1]]) : json({ error: "Contact not found" }, 404);
  m = /^\/api\/inbox\/([^/]+)$/.exec(p);
  if (m) return d.threads[m[1]] ? json(d.threads[m[1]]) : json({ error: "Conversation not found" }, 404);
  if (p === "/api/opportunities") {
    const pid = q.get("pipelineId");
    return json(pid ? d.opportunities.filter((o) => o.pipelineId === pid) : d.opportunities);
  }
  m = /^\/api\/agents\/([^/]+)$/.exec(p);
  if (m) return d.agents[m[1]] ? json(d.agents[m[1]]) : json({ error: "Agent not found" }, 404);
  if (p === "/api/automation-log") {
    const id = q.get("automationId");
    return json(d.log.filter((l) => !id || l.automationId === id).slice(0, Number(q.get("limit") ?? 200)));
  }
  if (p === "/api/meta/assets") return json(SAMPLE_ASSETS);
  if (p === "/api/meta/forms") return json([]);
  if (p === "/api/meta/locations") {
    const t = (q.get("q") ?? "").trim().toLowerCase();
    return json(t.length < 2 ? [] : SAMPLE_PLACES.filter((x) => x.name.toLowerCase().startsWith(t) || x.detail.toLowerCase().includes(t)).slice(0, 8));
  }
  if (p === "/api/meta/overview") return json(d.routes[`/api/meta/overview?range=${q.get("range") ?? 30}`] ?? d.routes["/api/meta/overview?range=30"]);
  if (p === "/api/tasks") return json(d.routes[`/api/tasks?status=${q.get("status") ?? "open"}`] ?? []);
  if (exact !== undefined) return json(exact);
  return json({ error: "Not available in the preview" }, 404);
}

if (PREVIEW) {
  const real = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://preview.local");
    if (!url.pathname.startsWith("/api/") || (typeof input === "string" && /^https?:/.test(input) && !input.includes("preview.local"))) return real(input, init);
    let body: unknown = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      body = null;
    }
    return handle(url, (init?.method ?? "GET").toUpperCase(), body);
  };
}

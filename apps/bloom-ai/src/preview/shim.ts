// Preview build only: answers the app's /api calls from a snapshot of the demo workspace
// (preview-data.json, published next to the page) so the real UI runs with no server.
// Anything that would change data, send a message or reach an outside service is refused
// with a clear message instead.
export const PREVIEW = Boolean(import.meta.env.VITE_PREVIEW);

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

let snapshot: Promise<Snapshot> | null = null;
const load = () => (snapshot ??= fetch("./preview-data.json").then((r) => r.json() as Promise<Snapshot>));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function handle(url: URL, method: string, body: unknown): Promise<Response> {
  const d = await load();
  const p = url.pathname;
  const q = url.searchParams;
  if (method !== "GET") {
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

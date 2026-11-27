// A stand-in for the Meta Graph API (Marketing API + Lead Ads) used by the integration tests.
import express from "express";

export const metaCalls: { method: string; path: string; params: Record<string, string> }[] = [];
/** Extra lead-form submissions a test can add to FORM1. */
export const extraLeads: Record<string, unknown>[] = [];
const TOKEN = "EAA-test";
const PAGE_TOKEN = "PAGE-test";

export function startMetaMock(port: number) {
  const app = express();
  app.use(express.urlencoded({ extended: false, limit: "20mb" }));
  app.use((req, res, next) => {
    const params = { ...(req.query as Record<string, string>), ...(req.body ?? {}) };
    metaCalls.push({ method: req.method, path: req.path, params });
    const token = params.access_token;
    if (!req.path.startsWith("/v23.0/")) return void res.status(400).json({ error: { code: 2635, message: "Unsupported version" } });
    const pageScoped = req.path.includes("/PAGE1/leadgen_forms") || req.path.includes("/FORM1/leads");
    if (token !== (pageScoped ? PAGE_TOKEN : TOKEN)) return void res.status(400).json({ error: { code: 190, message: "Invalid OAuth access token" } });
    next();
  });
  const r = express.Router();
  r.get("/me", (_q, s) => s.json({ id: "u1", name: "Bloom Test User" }));
  r.get("/me/adaccounts", (_q, s) => s.json({ data: [{ id: "act_123", name: "Main Account", currency: "USD", account_status: 1 }] }));
  r.get("/me/accounts", (_q, s) => s.json({ data: [{ id: "PAGE1", name: "Reyes Roofing Page", instagram_business_account: { id: "IG1", username: "reyesroofing" } }] }));
  r.get("/search", (q, s) => {
    if (q.query.type !== "adgeolocation") return void s.status(400).json({ error: { code: 100, message: "bad search type" } });
    s.json({
      data: [
        { key: "2420379", name: "Austin", type: "city", region: "Texas", country_code: "US", country_name: "United States" },
        { key: "US:78701", name: "78701", type: "zip", primary_city: "Austin", region: "Texas", country_code: "US", country_name: "United States" },
        { key: "999", name: "Austin", type: "city", region: "Manitoba", country_code: "CA", country_name: "Canada" },
      ],
    });
  });
  // Campaign builder
  r.post("/act_123/adimages", (q, s) => (q.body.bytes ? s.json({ images: { bytes: { hash: "HASH1", url: "https://img.test/1.jpg" } } }) : s.status(400).json({ error: { code: 100, message: "no image" } })));
  r.post("/PAGE1/leadgen_forms", (_q, s) => s.json({ id: "FORM_NEW" }));
  r.post("/act_123/campaigns", (_q, s) => s.json({ id: "C1" }));
  r.post("/act_123/adsets", (q, s) => (String(q.body.name).includes("FAIL") ? s.status(400).json({ error: { code: 100, message: "Invalid parameter: targeting" } }) : s.json({ id: "AS1" })));
  r.post("/act_123/adcreatives", (_q, s) => s.json({ id: "CR1" }));
  r.post("/act_123/ads", (_q, s) => s.json({ id: "AD1" }));
  r.post("/C1", (_q, s) => s.json({ success: true }));
  r.delete("/C1", (_q, s) => s.json({ success: true }));
  r.get("/act_123", (_q, s) => s.json({ id: "act_123", name: "Main Account", currency: "USD", timezone_name: "America/Chicago" }));
  r.get("/act_123/insights", (q, s) => {
    if (q.query.level === "campaign")
      return void s.json({ data: [{ campaign_id: "111", campaign_name: "Spring Leads", spend: "600.50", impressions: "40000", clicks: "800", ctr: "2.0", cpm: "15.01", actions: [{ action_type: "lead", value: "20" }] }] });
    if (q.query.time_increment === "1")
      return void s.json({ data: [{ date_start: "2026-11-25", spend: "300.25", impressions: "20000", clicks: "400", actions: [{ action_type: "lead", value: "9" }] }, { date_start: "2026-11-26", spend: "300.25", impressions: "20000", clicks: "400", actions: [{ action_type: "onsite_conversion.lead_grouped", value: "11" }] }] });
    s.json({ data: [{ spend: "600.50", impressions: "40000", clicks: "800", reach: "15000", ctr: "2.0", cpc: "0.75", cpm: "15.01", frequency: "2.67", actions: [{ action_type: "link_click", value: "800" }, { action_type: "lead", value: "20" }] }] });
  });
  r.get("/act_123/campaigns", (_q, s) =>
    s.json({ data: [{ id: "111", name: "Spring Leads", status: "ACTIVE", effective_status: "ACTIVE", objective: "OUTCOME_LEADS", daily_budget: "5000" }, { id: "222", name: "Old Awareness", status: "PAUSED", effective_status: "PAUSED", objective: "OUTCOME_AWARENESS", lifetime_budget: "100000" }], paging: { cursors: { after: "x" } } }),
  );
  r.post("/111", (q, s) => s.json({ success: true, received: q.body }));
  r.get("/PAGE1", (_q, s) => s.json({ id: "PAGE1", name: "Reyes Roofing Page", access_token: PAGE_TOKEN }));
  r.get("/PAGE1/leadgen_forms", (_q, s) => s.json({ data: [{ id: "FORM1", name: "Free Quote", status: "ACTIVE", leads_count: 2 }] }));
  r.get("/FORM1/leads", (_q, s) =>
    s.json({
      data: [
        { id: "L1", created_time: new Date().toISOString(), campaign_name: "Spring Leads", ad_name: "Video A", platform: "ig", field_data: [{ name: "full_name", values: ["Priya Shah"] }, { name: "email", values: ["priya@shahplumbing.com"] }, { name: "phone_number", values: ["+15125550144"] }, { name: "what_service_do_you_need?", values: ["Water heater"] }] },
        { id: "L2", created_time: new Date().toISOString(), campaign_name: "Spring Leads", platform: "fb", field_data: [{ name: "first_name", values: ["Dana"] }, { name: "email", values: ["dana@reyes.com"] }] },
        ...extraLeads,
      ],
    }),
  );
  app.use("/v23.0", r);
  return app.listen(port);
}

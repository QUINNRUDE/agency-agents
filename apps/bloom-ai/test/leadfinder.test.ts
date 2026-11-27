// Lead finder: an Apify Google Maps search runs in the background, closed places are skipped,
// tracking links are cleaned, emails are found on each lead's own website for free, and a
// search is refused when this month's free Apify credit can't cover it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const TOKEN = "apify_api_test";
let usedUsd = 0.4;
let runPolls = 0;
const runs: { query: Record<string, string>; body: Record<string, unknown> }[] = [];
const SITE = "http://localhost:4562";

// --- A stand-in for Apify's API -------------------------------------------------------
const apifyApp = express();
apifyApp.use(express.json());
apifyApp.use((req, res, next) => (req.headers.authorization === `Bearer ${TOKEN}` ? next() : void res.status(401).json({ error: { type: "token-not-valid", message: "Authentication token is not valid." } })));
apifyApp.get("/v2/users/me", (_q, s) => s.json({ data: { username: "bloomtester", plan: { id: "FREE", monthlyBasePriceUsd: 0, monthlyUsageCreditsUsd: 5 } } }));
apifyApp.get("/v2/users/me/limits", (_q, s) => s.json({ data: { monthlyUsageCycle: { startAt: "2026-11-20T00:00:00.000Z", endAt: "2026-12-19T23:59:59.999Z" }, limits: { maxMonthlyUsageUsd: 5 }, current: { monthlyUsageUsd: usedUsd } } }));
apifyApp.post("/v2/acts/compass~crawler-google-places/runs", (q, s) => {
  runs.push({ query: q.query as Record<string, string>, body: q.body });
  s.status(201).json({ data: { id: "RUN1", defaultDatasetId: "DS1", status: "READY" } });
});
apifyApp.get("/v2/actor-runs/RUN1", (_q, s) => s.json({ data: { id: "RUN1", status: ++runPolls < 2 ? "RUNNING" : "SUCCEEDED", defaultDatasetId: "DS1", usageTotalUsd: 0.013 } }));
apifyApp.get("/v2/datasets/DS1/items", (_q, s) =>
  s.json([
    { title: "Summit Roofing Co", categoryName: "Roofing contractor", address: "1 Main St, Austin, TX", city: "Austin", phone: "(512) 555-0101", phoneUnformatted: "+15125550101", website: `${SITE}/?utm_source=gmb&utm_campaign=austin`, totalScore: 4.1, reviewsCount: 12, url: "https://maps.google.com/?cid=1", placeId: "ChIJsummit", permanentlyClosed: false, temporarilyClosed: false },
    { title: "Closed Roofing", categoryName: "Roofing contractor", placeId: "ChIJclosed", permanentlyClosed: true, temporarilyClosed: false },
    { title: "No Site Roofers", categoryName: "Roofer", address: "2 Elm St, Austin, TX", city: "Austin", phoneUnformatted: "+15125550102", totalScore: null, reviewsCount: 0, placeId: "ChIJnosite", permanentlyClosed: false, temporarilyClosed: false },
  ]),
);
const apifyServer = apifyApp.listen(4561);

// --- A small business website: the email is only on the contact page ------------------
const site = express();
site.get("/", (_q, s) => s.type("html").send(`<html><head><title>Summit Roofing</title><meta name="viewport" content="width=device-width"></head><body><a href="tel:+1 (512) 555-0101">Call</a> <a href="/contact-us">Contact</a> <a href="https://www.facebook.com/summitroofingatx">Facebook</a> <img src="logo@2x.png"></body></html>`));
site.get("/contact-us", (_q, s) => s.type("html").send(`<html><body>Email us: <a href="mailto:owner@summitroofing.co">owner@summitroofing.co</a></body></html>`));
const siteServer = site.listen(4562);

// --- A stand-in for OpenStreetMap (Nominatim + Overpass) -------------------------------
const overpassQueries: string[] = [];
const osm = express();
osm.use(express.urlencoded({ extended: false }));
osm.get("/nominatim/search", (q, s) =>
  s.json(q.query.q === "Nowhere, ZZ" ? [] : [{ lat: "30.2649", lon: "-97.7474", name: "Austin", display_name: "Austin, Travis County, Texas, United States", boundingbox: ["30.0985133", "30.5166255", "-97.9367663", "-97.5605288"], address: { city: "Austin", state: "Texas" } }]),
);
osm.post("/overpass", (q, s) => {
  overpassQueries.push(String(q.body.data));
  s.json({
    elements: [
      { type: "node", id: 101, tags: { craft: "roofer", name: "Barker Roofing", phone: "+1 512-555-0201; 512-555-0202", website: SITE, "addr:housenumber": "12", "addr:street": "Oak St", "addr:city": "Austin", "addr:state": "TX", "addr:postcode": "78701" } },
      { type: "way", id: 202, center: { lat: 30.3, lon: -97.7 }, tags: { craft: "roofer", name: "Alta Roofing, LLC", phone: "(512) 555-0203", email: "office@altaroofing.co" } },
      { type: "node", id: 303, tags: { "disused:craft": "roofer", name: "Old Roofs Inc" } },
      { type: "node", id: 404, tags: { craft: "roofer", name: "Barker Roofing", phone: "512-555-0201" } },
      { type: "node", id: 505, tags: { craft: "roofer" } },
    ],
  });
});
const osmServer = osm.listen(4564);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bloom-leads-"));
const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  env: {
    ...process.env,
    PORT: "4563",
    BLOOM_DATA_DIR: dataDir,
    APIFY_API_BASE: "http://localhost:4561",
    APIFY_TOKEN: TOKEN,
    OSM_NOMINATIM_URL: "http://localhost:4564/nominatim",
    OSM_OVERPASS_URL: "http://localhost:4564/overpass",
    BLOOM_AUDIT_ALLOW_PRIVATE: "1",
    GHL_API_KEY: "",
    GOOGLE_PLACES_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    META_ACCESS_TOKEN: "",
  },
  stdio: "pipe",
});
const base = "http://localhost:4563";
const j = async (method: string, url: string, body?: unknown) => {
  const r = await fetch(base + url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return Object.assign(await r.json(), { _status: r.status });
};
let ok = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  await fn();
  ok++;
  console.log(`  ✓ ${name}`);
};

try {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(base + "/api/health");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  await test("the Apify connection test shows the free credit that's left", async () => {
    const r = await j("POST", "/api/settings/test/apify", {});
    assert.equal(r.ok, true);
    assert.match(r.message, /\$4\.60 of the \$5\.00/);
    assert.match(r.message, /1,150 leads/);
    const u = await j("GET", "/api/lead-finder/usage");
    assert.deepEqual([u.connected, u.leftUsd, u.leadsLeft, u.free], [true, 4.6, 1150, true]);
  });

  let jobId = "";
  await test("a search starts on Apify with a spending cap and no paid add-ons", async () => {
    const r = await j("POST", "/api/prospects/search", { niche: "roofers", location: "Austin, TX", maxResults: 50 });
    assert.equal(r.job.status, "scraping");
    jobId = r.job.id;
    const run = runs.at(-1);
    assert.equal(run?.query.maxTotalChargeUsd, "0.5");
    assert.deepEqual(run?.body, { searchStringsArray: ["roofers"], locationQuery: "Austin, TX", maxCrawledPlacesPerSearch: 50, language: "en", scrapeContacts: false });
  });

  await test("results arrive, closed places are skipped, and emails are found on websites for free", async () => {
    let r = await j("GET", `/api/lead-jobs/${jobId}`);
    for (let i = 0; i < 40 && r.job.status !== "done"; i++) {
      await new Promise((res) => setTimeout(res, 250));
      r = await j("GET", `/api/lead-jobs/${jobId}`);
    }
    assert.equal(r.job.status, "done");
    assert.equal(r.job.found, 2);
    assert.equal(r.job.emailsFound, 1);
    const summit = r.prospects.find((p: { name: string }) => p.name === "Summit Roofing Co");
    assert.equal(summit.website, `${SITE}/`);
    assert.equal(summit.email, "owner@summitroofing.co");
    assert.equal(summit.phone, "+15125550101");
    assert.deepEqual(summit.socials, ["https://www.facebook.com/summitroofingatx"]);
    assert.equal(summit.source, "apify");
    assert.ok(summit.audit);
    const nosite = r.prospects.find((p: { name: string }) => p.name === "No Site Roofers");
    assert.equal(nosite.rating, null);
    assert.ok(nosite.signals.includes("No website"));
    assert.ok(!r.prospects.some((p: { name: string }) => p.name === "Closed Roofing"));
  });

  await test("adding a lead to the CRM keeps its email", async () => {
    const all = await j("GET", "/api/prospects");
    const summit = all.find((p: { name: string }) => p.name === "Summit Roofing Co");
    const added = await j("POST", `/api/prospects/${summit.id}/add`, {});
    const contact = await j("GET", `/api/contacts/${added.contactId}`);
    assert.equal(contact.contact.email, "owner@summitroofing.co");
    assert.ok(contact.contact.tags.includes("prospect"));
  });

  await test("a search that would go past the free credit is refused before anything runs", async () => {
    usedUsd = 4.9;
    const before = runs.length;
    const r = await j("POST", "/api/prospects/search", { niche: "roofers", location: "Austin, TX", maxResults: 50 });
    assert.equal(r._status, 402);
    assert.match(r.error, /Search for 25 or fewer/);
    assert.equal(runs.length, before);
  });

  await test("the free scraper finds businesses on OpenStreetMap with no key, then finds emails on their sites", async () => {
    const r = await j("POST", "/api/prospects/search", { source: "free", niche: "Roofers", location: "Austin, TX", maxResults: 100 });
    assert.equal(r._status, 200);
    const q = overpassQueries.at(-1) ?? "";
    assert.match(q, /nwr\["craft"="roofer"\]\["name"\]\(30\.0985,-97\.9368,30\.5166,-97\.5605\);/);
    assert.match(q, /\["name"~"roof",i\]\["craft"\]/);
    // Closed, nameless and duplicate listings are dropped.
    assert.deepEqual(r.prospects.map((p: { name: string }) => p.name).sort(), ["Alta Roofing, LLC", "Barker Roofing"]);
    const barker = r.prospects.find((p: { name: string }) => p.name === "Barker Roofing");
    assert.equal(barker.phone, "+15125550201");
    assert.equal(barker.address, "12 Oak St, Austin, TX 78701");
    assert.equal(barker.source, "osm");
    assert.equal(barker.mapsUrl, "https://www.openstreetmap.org/node/101");
    assert.ok(!barker.signals.some((s: string) => /reviews/.test(s)), "no review signals for map listings");
    const alta = r.prospects.find((p: { name: string }) => p.name === "Alta Roofing, LLC");
    assert.deepEqual([alta.phone, alta.email, alta.city], ["+15125550203", "office@altaroofing.co", "Austin"]);
    // The website check runs in the background and fills in Barker's email.
    let job = await j("GET", `/api/lead-jobs/${r.job.id}`);
    for (let i = 0; i < 40 && job.job.status !== "done"; i++) {
      await new Promise((res) => setTimeout(res, 250));
      job = await j("GET", `/api/lead-jobs/${r.job.id}`);
    }
    assert.equal(job.job.status, "done");
    assert.equal(job.prospects.find((p: { name: string }) => p.name === "Barker Roofing").email, "owner@summitroofing.co");
    assert.equal(job.job.emailsFound, 2);
  });

  await test("the free scraper explains a place it can't find", async () => {
    const r = await j("POST", "/api/prospects/search", { source: "free", niche: "roofers", location: "Nowhere, ZZ" });
    assert.equal(r._status, 400);
    assert.match(r.error, /Couldn't find “Nowhere, ZZ”/);
  });

  await test("a bad token gets a clear message", async () => {
    const r = await j("POST", "/api/settings/test/apify", { apifyToken: "wrong" });
    assert.equal(r.ok, false);
    assert.match(r.message, /rejected the token/);
  });

  console.log(`\n${ok} passed`);
} finally {
  server.kill();
  apifyServer.close();
  siteServer.close();
  osmServer.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

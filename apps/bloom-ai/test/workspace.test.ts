// Demo data: removing the sample business leaves a clean, working local workspace, hides
// sample ad numbers and sample prospects, and the demo can be loaded again.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bloom-ws-"));
const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  env: { ...process.env, PORT: "4553", BLOOM_DATA_DIR: dataDir, GHL_API_KEY: "", GHL_LOCATION_ID: "", META_ACCESS_TOKEN: "", GOOGLE_PLACES_API_KEY: "", ANTHROPIC_API_KEY: "" },
  stdio: "pipe",
});
const base = "http://localhost:4553";
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

  await test("a new install shows the sample business", async () => {
    const s = await j("GET", "/api/status");
    assert.equal(s.demoData, true);
    assert.equal(s.crm.accountName, "Demo workspace");
    assert.ok((await j("GET", "/api/contacts?limit=500")).length >= 40);
    const ads = await j("GET", "/api/meta/overview?range=30");
    assert.equal(ads.sample, true);
    const found = await j("POST", "/api/prospects/search", { niche: "roofers", location: "Austin, TX", maxResults: 3 });
    assert.equal(found.sample, true);
  });

  await test("removing demo data leaves an empty, working workspace", async () => {
    const someone = (await j("GET", "/api/contacts?limit=1"))[0];
    await j("POST", "/api/calls", { contactId: someone.id, outcome: "connected", notes: "sample call" });
    const r = await j("POST", "/api/workspace/demo-data", { action: "remove" });
    assert.equal(r.demoData, false);
    const s = await j("GET", "/api/status");
    assert.equal(s.demoData, false);
    assert.equal(s.crm.accountName, "Your workspace");
    assert.equal((await j("GET", "/api/contacts?limit=500")).length, 0);
    assert.equal((await j("GET", "/api/calls")).length, 0);
    const pipelines = await j("GET", "/api/pipelines");
    assert.deepEqual(pipelines.map((p: { name: string }) => p.name), ["Client Acquisition", "Account Management"]);
    const added = await j("POST", "/api/contacts", { firstName: "Real", lastName: "Client", phone: "+15125550190" });
    assert.equal(added._status, 200);
    assert.equal((await j("GET", "/api/contacts?limit=500")).length, 1);
  });

  await test("without demo data, nothing made-up is shown for ads or prospects", async () => {
    const ads = await j("GET", "/api/meta/overview?range=30");
    assert.deepEqual([ads.sample, ads.connected, ads.campaigns.length, ads.totals.spend], [false, false, 0, 0]);
    const found = await j("POST", "/api/prospects/search", { niche: "roofers", location: "Austin, TX" });
    assert.equal(found._status, 400);
    assert.match(found.error, /Connect Apify/);
    const assets = await j("GET", "/api/meta/assets");
    assert.deepEqual([assets.connected, assets.adAccounts.length], [false, 0]);
    const camp = await j("POST", "/api/meta/campaigns", { name: "x", pageId: "p", primaryText: "t", headline: "h", image: { hash: "h" }, form: { id: "f" }, dailyBudget: 10 });
    assert.equal(camp._status, 400);
    assert.match(camp.error, /Connect Meta/);
  });

  await test("the demo can be loaded again", async () => {
    await j("POST", "/api/workspace/demo-data", { action: "load" });
    const s = await j("GET", "/api/status");
    assert.equal(s.demoData, true);
    assert.ok((await j("GET", "/api/contacts?limit=500")).length >= 40);
  });

  console.log(`\n${ok} passed`);
} finally {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

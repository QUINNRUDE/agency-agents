// End-to-end: Meta Ads (insights, campaign control, Lead Ads sync) and the
// automation engine (DM auto-reply, Meta-lead sequence, opt-out, 24h window,
// test mode, webhook) against mock GoHighLevel + Meta APIs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { calls, pushInbound, startMock } from "./mock-ghl.ts";
import { metaCalls, startMetaMock } from "./mock-meta.ts";

const ghl = startMock(4541);
const meta = startMetaMock(4542);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bloom-test-"));
const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  env: {
    ...process.env,
    PORT: "4543",
    GHL_API_BASE: "http://localhost:4541",
    GHL_API_KEY: "pit-test-token",
    GHL_LOCATION_ID: "loc_test",
    META_API_BASE: "http://localhost:4542",
    META_ACCESS_TOKEN: "EAA-test",
    META_AD_ACCOUNT_ID: "act_123",
    META_PAGE_ID: "PAGE1",
    BLOOM_DATA_DIR: dataDir,
    ANTHROPIC_API_KEY: "",
  },
  stdio: "pipe",
});
const base = "http://localhost:4543";
const j = async (method: string, url: string, body?: unknown, okStatus = true) => {
  const r = await fetch(base + url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json();
  if (okStatus && !r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return Object.assign(data, { _status: r.status });
};
const tick = () => j("POST", "/api/automation-tick");
const sent = (type: string, contactId: string) => calls.filter((c) => c.method === "POST" && c.path === "/conversations/messages" && (c.body as { type: string; contactId: string }).type === type && (c.body as { contactId: string }).contactId === contactId);

let ok = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  await fn();
  ok++;
  console.log(`  ✓ ${name}`);
};

try {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(base + "/api/status");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  await test("Meta token test lists ad accounts and Pages", async () => {
    const r = await j("POST", "/api/settings/test/meta", {});
    assert.equal(r.ok, true);
    assert.equal(r.adAccounts[0].id, "act_123");
    assert.equal(r.pages[0].name, "Reyes Roofing Page");
  });

  await test("ads overview: totals, daily leads (any lead action type), campaigns with budgets", async () => {
    const o = await j("GET", "/api/meta/overview?range=30");
    assert.equal(o.sample, false);
    assert.equal(o.totals.spend, 600.5);
    assert.equal(o.totals.leads, 20);
    assert.equal(Math.round(o.totals.cpl * 100) / 100, 30.03);
    assert.deepEqual(o.daily.map((d: { leads: number }) => d.leads), [9, 11]);
    const spring = o.campaigns.find((c: { id: string }) => c.id === "111");
    assert.equal(spring.dailyBudget, 50);
    assert.equal(spring.objective, "leads");
    const old = o.campaigns.find((c: { id: string }) => c.id === "222");
    assert.equal(old.lifetimeBudget, 1000);
    assert.ok(metaCalls.some((c) => c.params.date_preset === "last_30d"));
  });

  await test("pause a campaign and change its daily budget", async () => {
    await j("PUT", "/api/meta/campaigns/111", { status: "PAUSED", currency: "USD" });
    assert.equal(metaCalls.filter((c) => c.method === "POST" && c.path === "/v23.0/111").at(-1)?.params.status, "PAUSED");
    await j("PUT", "/api/meta/campaigns/111", { dailyBudget: 75, currency: "USD" });
    assert.equal(metaCalls.filter((c) => c.method === "POST" && c.path === "/v23.0/111").at(-1)?.params.daily_budget, "7500");
  });

  // Automations: seed the engine, then install recipes (template text only — no Claude here).
  const settings = await j("PUT", "/api/automation-settings", { quietStart: "00:00", quietEnd: "23:59", maxPerContactPerDay: 5 });
  await tick(); // first look: remember what already exists
  const dm = await j("POST", "/api/automations", { recipeId: "ai-dm-responder" });
  await j("PUT", `/api/automations/${dm.id}`, { enabled: true, steps: [{ type: "send", channel: "reply", mode: "template", text: "Thanks {{first_name}}! What are you looking to fix first?" }] });
  const ml = await j("POST", "/api/automations", { recipeId: "meta-lead" });
  await j("PUT", `/api/automations/${ml.id}`, { enabled: true });

  await test("Lead Ads sync creates new contacts, matches existing ones, and is idempotent", async () => {
    const r = await j("POST", "/api/meta/sync");
    assert.deepEqual([r.imported, r.matched, r.forms], [1, 1, 1]);
    const created = calls.filter((c) => c.method === "POST" && c.path === "/contacts/").at(-1)?.body as { firstName: string; lastName: string; tags: string[]; source: string };
    assert.deepEqual([created.firstName, created.lastName], ["Priya", "Shah"]);
    assert.ok(created.tags.includes("meta-lead") && created.tags.includes("instagram"));
    assert.equal(created.source, "Meta Lead Ad — Free Quote");
    assert.ok(calls.some((c) => c.method === "POST" && c.path === "/contacts/g1/tags" && JSON.stringify(c.body).includes("meta-lead")));
    const again = await j("POST", "/api/meta/sync");
    assert.deepEqual([again.imported, again.matched, again.skipped], [0, 0, 2]);
  });

  await test("Meta-lead automation texts the new lead instantly", async () => {
    await tick();
    const priya = (await j("GET", "/api/contacts?q=priya"))[0];
    const sms = sent("SMS", priya.id);
    assert.equal(sms.length, 1);
    assert.match((sms[0].body as { message: string }).message, /^Hi Priya! .* got your request from our ad/);
    const log = await j("GET", "/api/automation-log");
    assert.ok(log.some((l: { status: string; contactName: string }) => l.status === "sent" && l.contactName === "Priya Shah"));
  });

  await test("an inbound Instagram DM gets an automatic IG reply", async () => {
    pushInbound("g1", "IG", "Hi, do you do Instagram ads?");
    await tick();
    const ig = sent("IG", "g1");
    assert.equal(ig.length, 1);
    assert.equal((ig[0].body as { message: string }).message, "Thanks Dana! What are you looking to fix first?");
  });

  await test("the same DM is not answered twice", async () => {
    await tick();
    await tick();
    assert.equal(sent("IG", "g1").length, 1);
  });

  await test("Messenger/IG steps are skipped outside Meta's 24-hour window", async () => {
    const a = await j("POST", "/api/automations", { name: "IG nudge", trigger: { type: "manual" }, steps: [{ type: "send", channel: "IG", mode: "template", text: "Hey {{first_name}}" }] });
    await j("PUT", `/api/automations/${a.id}`, { enabled: true });
    const priya = (await j("GET", "/api/contacts?q=priya"))[0];
    await j("POST", `/api/automations/${a.id}/enroll`, { contactIds: [priya.id] });
    await tick();
    assert.equal(sent("IG", priya.id).length, 0);
    const log = await j("GET", `/api/automation-log?automationId=${a.id}`);
    assert.equal(log[0].status, "skipped");
    assert.match(log[0].reason, /24-hour window/);
  });

  await test("test mode logs messages without sending", async () => {
    await j("PUT", "/api/automation-settings", { dryRun: true });
    const a = await j("POST", "/api/automations", { name: "Dry", trigger: { type: "manual" }, steps: [{ type: "send", channel: "SMS", mode: "template", text: "Test {{first_name}}" }, { type: "add_tag", tag: "dry-tag" }] });
    await j("PUT", `/api/automations/${a.id}`, { enabled: true });
    const before = calls.length;
    await j("POST", `/api/automations/${a.id}/enroll`, { contactIds: ["g1"] });
    await tick();
    const log = await j("GET", `/api/automation-log?automationId=${a.id}`);
    assert.deepEqual(log.map((l: { status: string }) => l.status), ["dry_run", "dry_run"]);
    assert.ok(!calls.slice(before).some((c) => c.path === "/conversations/messages" || c.path.endsWith("/tags")));
    await j("PUT", "/api/automation-settings", { dryRun: false });
  });

  await test("cold prospects from Find clients get no welcome text", async () => {
    const welcome = await j("POST", "/api/automations", { name: "Welcome text", trigger: { type: "new_contact" }, steps: [{ type: "send", channel: "SMS", mode: "template", text: "Thanks for reaching out, {{first_name}}!" }] });
    await j("PUT", `/api/automations/${welcome.id}`, { enabled: true });
    await tick();
    const s2 = await j("POST", "/api/prospects/search", { niche: "electricians", location: "Austin, TX", maxResults: 3 });
    const added = await j("POST", `/api/prospects/${s2.prospects[0].id}/add`, {});
    await tick();
    await tick();
    assert.equal(sent("SMS", added.contactId).length, 0);
    const runs = await j("GET", `/api/automation-runs?automationId=${welcome.id}`);
    assert.ok(!runs.some((r: { contactId: string }) => r.contactId === added.contactId));
    // A real inbound lead (no prospect tag) still gets the welcome text.
    const lead = await j("POST", "/api/contacts", { firstName: "Rosa", phone: "+15125550166", source: "Website form" });
    await tick();
    await tick();
    assert.equal(sent("SMS", lead.id).length, 1);
  });

  await test("texts to a prospect are blocked until they agree (sms-ok)", async () => {
    const nudge = await j("POST", "/api/automations", { name: "Prospect text", trigger: { type: "manual" }, steps: [{ type: "send", channel: "SMS", mode: "template", text: "Hi {{first_name}}" }] });
    await j("PUT", `/api/automations/${nudge.id}`, { enabled: true });
    const s3 = await j("POST", "/api/prospects/search", { niche: "painters", location: "Austin, TX", maxResults: 3 });
    const p = s3.prospects.find((x: { phone: string }) => x.phone) ?? s3.prospects[0];
    const added = await j("POST", `/api/prospects/${p.id}/add`, {});
    await j("POST", `/api/automations/${nudge.id}/enroll`, { contactIds: [added.contactId] });
    await tick();
    assert.equal(sent("SMS", added.contactId).length, 0);
    const log = await j("GET", `/api/automation-log?automationId=${nudge.id}`);
    assert.equal(log[0].status, "skipped");
    assert.match(log[0].reason, /No permission to text yet/);
    await j("POST", `/api/contacts/${added.contactId}/tags`, { tags: ["sms-ok"] });
    await j("POST", `/api/automations/${nudge.id}/enroll`, { contactIds: [added.contactId] });
    await tick();
    assert.equal(sent("SMS", added.contactId).length, 1);
  });

  await test("STOP opts the contact out and nothing more is sent", async () => {
    pushInbound("g1", "SMS", "STOP");
    await tick();
    assert.ok(calls.some((c) => c.method === "POST" && c.path === "/contacts/g1/tags" && JSON.stringify(c.body).includes("opted-out")));
    const log = await j("GET", "/api/automation-log?limit=20");
    assert.ok(log.some((l: { automationName: string }) => l.automationName === "Opt-out"));
    assert.equal(sent("SMS", "g1").length, 0);
  });

  await test("automations can't be switched on with missing settings", async () => {
    const a = await j("POST", "/api/automations", { name: "Broken", trigger: { type: "tag_added" }, steps: [] });
    const r = await j("PUT", `/api/automations/${a.id}`, { enabled: true }, false);
    assert.equal(r._status, 400);
    assert.match(r.error, /Pick the tag/);
  });

  await test("GHL workflow webhook requires the secret", async () => {
    const bad = await j("POST", "/api/webhooks/ghl/nope", { contact_id: "g1", message: { body: "hi", type: "SMS" } }, false);
    assert.equal(bad._status, 403);
    const good = await j("POST", `/api/webhooks/ghl/${settings.webhookSecret}`, { contact_id: "g1", message: { body: "hello again", type: "SMS" } });
    assert.equal(good.ok, true);
  });

  await test("manual DMs outside the 24-hour window are refused with a clear message", async () => {
    const r = await j("POST", "/api/messages", { contactId: "g1", channel: "FB", body: "hi" }, false);
    assert.equal(r._status, 400);
    assert.match(r.error, /24 hours/);
  });

  console.log(`\n${ok} passed`);
} finally {
  server.kill();
  ghl.close();
  meta.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

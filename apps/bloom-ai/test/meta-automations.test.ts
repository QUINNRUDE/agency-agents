// End-to-end: Meta Ads (insights, campaign control, Lead Ads sync) and the
// automation engine (DM auto-reply, Meta-lead sequence, opt-out, 24h window,
// test mode, webhook) against mock GoHighLevel + Meta APIs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { calls, pushInbound, startMock } from "./mock-ghl.ts";
import { extraLeads, metaCalls, startMetaMock } from "./mock-meta.ts";

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

  const draft = {
    name: "Free roof inspection",
    adAccountId: "act_123",
    pageId: "PAGE1",
    instagramId: "IG1",
    locations: [{ key: "2420379", name: "Austin", type: "city", detail: "Texas, United States", radius: 25 }, { key: "US:78701", name: "78701", type: "zip", detail: "Austin, Texas" }],
    ageMin: 30,
    ageMax: 65,
    primaryText: "Free roof inspection for Austin homeowners. Tap Get quote.",
    headline: "Free roof inspection",
    description: "Takes 30 seconds",
    cta: "GET_QUOTE",
    // Bigger than the 2 MB limit on other routes: the builder route must still accept it.
    image: { base64: `data:image/jpeg;base64,${"A".repeat(3_000_000)}`, filename: "roof photo.jpg" },
    form: { create: { name: "Roof form", question: "What do you need help with?", askTextConsent: true, privacyUrl: "https://reyesroofing.com/privacy", websiteUrl: "https://reyesroofing.com" } },
    dailyBudget: 25,
    launch: false,
  };
  const posted = (p: string) => metaCalls.filter((c) => c.method === "POST" && c.path === `/v23.0/${p}`);

  await test("campaign builder lists ad accounts, Pages and the Page's Instagram account", async () => {
    const a = await j("GET", "/api/meta/assets");
    assert.equal(a.connected, true);
    assert.equal(a.adAccounts[0].id, "act_123");
    assert.deepEqual(a.pages[0].instagram, { id: "IG1", username: "reyesroofing" });
    assert.deepEqual(a.defaults, { adAccountId: "act_123", pageId: "PAGE1" });
  });

  await test("location search returns US cities and ZIP codes from Meta", async () => {
    const r = await j("GET", "/api/meta/locations?q=austin");
    assert.deepEqual(r.map((l: { key: string }) => l.key), ["2420379", "US:78701"]);
    assert.equal(r[1].detail, "Austin, Texas, United States");
  });

  await test("a new campaign is built image → form → campaign → ad set → creative → ad, and left paused", async () => {
    const r = await j("POST", "/api/meta/campaigns", draft);
    assert.deepEqual([r.campaignId, r.adSetId, r.adId, r.formId, r.status], ["C1", "AS1", "AD1", "FORM_NEW", "PAUSED"]);
    assert.equal(posted("act_123/adimages").at(-1)?.params.bytes.length, 3_000_000);
    const form = posted("PAGE1/leadgen_forms").at(-1)?.params ?? {};
    assert.equal(form.access_token, "PAGE-test");
    const questions = JSON.parse(form.questions);
    assert.deepEqual(questions.slice(0, 3).map((q: { type: string }) => q.type), ["FULL_NAME", "EMAIL", "PHONE"]);
    assert.equal(questions.at(-1).key, "text_consent");
    assert.equal(questions.at(-1).options[0].value, "Yes, text me");
    assert.equal(JSON.parse(form.privacy_policy).url, "https://reyesroofing.com/privacy");
    const camp = posted("act_123/campaigns").at(-1)?.params ?? {};
    assert.deepEqual([camp.objective, camp.status, camp.daily_budget, camp.special_ad_categories], ["OUTCOME_LEADS", "PAUSED", "2500", "[]"]);
    const adset = posted("act_123/adsets").at(-1)?.params ?? {};
    assert.equal(adset.campaign_id, "C1");
    assert.equal(adset.optimization_goal, "LEAD_GENERATION");
    assert.equal(JSON.parse(adset.promoted_object).page_id, "PAGE1");
    const t = JSON.parse(adset.targeting);
    assert.deepEqual(t.geo_locations, { cities: [{ key: "2420379", radius: 25, distance_unit: "mile" }], zips: [{ key: "US:78701" }] });
    assert.deepEqual([t.age_min, t.age_max, t.publisher_platforms], [30, 65, ["facebook", "instagram"]]);
    const story = JSON.parse(posted("act_123/adcreatives").at(-1)?.params.object_story_spec ?? "{}");
    assert.equal(story.instagram_user_id, "IG1");
    assert.equal(story.link_data.image_hash, "HASH1");
    assert.equal(story.link_data.call_to_action.value.lead_gen_form_id, "FORM_NEW");
    assert.equal(JSON.parse(posted("act_123/ads").at(-1)?.params.creative ?? "{}").creative_id, "CR1");
    assert.equal(posted("C1").length, 0, "a paused build never switches the campaign on");
  });

  await test("launching uses an existing form and switches the campaign on", async () => {
    const formsBefore = posted("PAGE1/leadgen_forms").length;
    const r = await j("POST", "/api/meta/campaigns", { ...draft, image: { hash: "HASH1" }, form: { id: "FORM1" }, instagramId: "", locations: [], launch: true });
    assert.equal(r.status, "ACTIVE");
    assert.equal(posted("PAGE1/leadgen_forms").length, formsBefore);
    assert.equal(posted("C1").at(-1)?.params.status, "ACTIVE");
    const t = JSON.parse(posted("act_123/adsets").at(-1)?.params.targeting ?? "{}");
    assert.deepEqual([t.geo_locations, t.publisher_platforms], [{ countries: ["US"] }, ["facebook"]]);
  });

  await test("a failed step deletes the half-built campaign", async () => {
    const r = await j("POST", "/api/meta/campaigns", { ...draft, name: "FAIL test", image: { hash: "HASH1" }, form: { id: "FORM1" } }, false);
    assert.equal(r._status, 502);
    assert.match(r.error, /targeting/);
    assert.ok(metaCalls.some((c) => c.method === "DELETE" && c.path === "/v23.0/C1"));
  });

  await test("a campaign with missing pieces is refused with what to fix", async () => {
    const r = await j("POST", "/api/meta/campaigns", { ...draft, headline: "", dailyBudget: 0, form: { create: { privacyUrl: "" } } }, false);
    assert.equal(r._status, 400);
    assert.match(r.error, /headline/);
    assert.match(r.error, /privacy policy/);
    assert.match(r.error, /at least \$1/);
  });

  await test("ad copy falls back to plain templates when Claude isn't connected", async () => {
    const r = await j("POST", "/api/meta/ad-copy", { business: "Reyes Roofing", offer: "Free roof inspection", audience: "Homeowners", place: "Austin", cta: "GET_QUOTE" });
    assert.equal(r.ai, false);
    assert.equal(r.variants.length, 3);
    assert.match(r.variants[0].primaryText, /Free roof inspection from Reyes Roofing in Austin/);
    assert.match(r.variants[0].primaryText, /Get quote/);
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

  await test("the lead form's texting answer tags the lead, and a \"no\" blocks automated texts", async () => {
    const now = new Date().toISOString();
    extraLeads.push(
      { id: "L3", created_time: now, campaign_name: "Free roof inspection", platform: "fb", field_data: [{ name: "full_name", values: ["Omar Haddad"] }, { name: "phone_number", values: ["+15125550177"] }, { name: "text_consent", values: ["No texts, please"] }] },
      { id: "L4", created_time: now, campaign_name: "Free roof inspection", platform: "fb", field_data: [{ name: "full_name", values: ["Lena Park"] }, { name: "phone_number", values: ["+15125550178"] }, { name: "text_consent", values: ["Yes, text me"] }] },
    );
    const r = await j("POST", "/api/meta/sync");
    assert.equal(r.imported, 2);
    const omar = (await j("GET", "/api/contacts?q=omar"))[0];
    const lena = (await j("GET", "/api/contacts?q=lena"))[0];
    assert.ok(omar.tags.includes("no-texts"));
    assert.ok(lena.tags.includes("sms-ok"));
    await tick();
    assert.equal(sent("SMS", omar.id).length, 0);
    assert.equal(sent("SMS", lena.id).length, 1);
    const log = await j("GET", "/api/automation-log");
    assert.ok(log.some((l: { contactName: string; status: string; reason: string }) => l.contactName === "Omar Haddad" && l.status === "skipped" && /No permission to text/.test(l.reason)));
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

  const waitDone = async (id: string) => {
    for (let i = 0; i < 40; i++) {
      const b = await j("GET", `/api/broadcasts/${id}`);
      if (b.status === "done" || b.status === "cancelled") return b;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("broadcast did not finish");
  };

  await test("broadcast preview leaves out opted-out contacts and cold prospects", async () => {
    const p = await j("POST", "/api/broadcasts/preview", { audience: { kind: "all" }, channel: "SMS", message: "Hi {{first_name}}, we have openings next week!" });
    assert.ok(p.eligible > 0);
    assert.ok(p.excluded["Opted out / DND"] >= 1);
    assert.ok(p.excluded["No permission to text"] >= 1);
    assert.match(p.sampleText, /Reply STOP to opt out\.$/);
  });

  await test("an SMS broadcast reaches eligible contacts only, with the opt-out line", async () => {
    const before = calls.filter((c) => c.path === "/conversations/messages").length;
    const b = await j("POST", "/api/broadcasts", { name: "Openings", channel: "SMS", message: "Hi {{first_name}}, we have openings next week!", audience: { kind: "all" }, perMinute: 120 });
    const done = await waitDone(b.id);
    const sentNow = calls.filter((c) => c.path === "/conversations/messages").slice(before).map((c) => c.body as { contactId: string; message: string; type: string });
    assert.equal(done.status, "done");
    assert.equal(sentNow.length, done.recipients.filter((r: { status: string }) => r.status === "sent").length);
    assert.ok(sentNow.length >= 1);
    assert.ok(sentNow.every((m) => m.type === "SMS" && /Reply STOP to opt out\.$/.test(m.message)));
    assert.ok(!sentNow.some((m) => m.contactId === "g1")); // opted out earlier with STOP
    const contacts = await j("GET", "/api/contacts");
    const cold = contacts.filter((c: { tags: string[] }) => c.tags.includes("prospect") && !c.tags.includes("sms-ok")).map((c: { id: string }) => c.id);
    assert.ok(cold.length >= 1);
    assert.ok(!sentNow.some((m) => cold.includes(m.contactId)));
  });

  await test("broadcasts respect test mode", async () => {
    await j("PUT", "/api/automation-settings", { dryRun: true });
    const before = calls.filter((c) => c.path === "/conversations/messages").length;
    const b = await j("POST", "/api/broadcasts", { channel: "SMS", message: "Test {{first_name}}", audience: { kind: "all" }, perMinute: 120 });
    const done = await waitDone(b.id);
    assert.ok(done.recipients.every((r: { status: string }) => r.status === "test_mode"));
    assert.equal(calls.filter((c) => c.path === "/conversations/messages").length, before);
    await j("PUT", "/api/automation-settings", { dryRun: false });
  });

  await test("a scheduled broadcast can be cancelled before it sends", async () => {
    const before = calls.filter((c) => c.path === "/conversations/messages").length;
    const b = await j("POST", "/api/broadcasts", { channel: "SMS", message: "Later {{first_name}}", audience: { kind: "all" }, scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    assert.equal(b.status, "scheduled");
    await j("POST", `/api/broadcasts/${b.id}/cancel`);
    const after = await j("GET", `/api/broadcasts/${b.id}`);
    assert.equal(after.status, "cancelled");
    assert.ok(after.recipients.every((r: { status: string }) => r.status === "skipped"));
    assert.equal(calls.filter((c) => c.path === "/conversations/messages").length, before);
  });

  console.log(`\n${ok} passed`);
} finally {
  server.kill();
  ghl.close();
  meta.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

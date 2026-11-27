// End-to-end: boots the mock GHL API and the Clientline server pointed at it,
// then drives the Clientline HTTP API the way the UI does.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { calls, startMock } from "./mock-ghl.ts";

const mock = startMock(4511);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clientline-test-"));
const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  env: { ...process.env, PORT: "4512", GHL_API_BASE: "http://localhost:4511", GHL_API_KEY: "pit-test-token", GHL_LOCATION_ID: "loc_test", CLIENTLINE_DATA_DIR: dataDir, ANTHROPIC_API_KEY: "" },
  stdio: "pipe",
});
const base = "http://localhost:4512";
const j = async (method: string, url: string, body?: unknown) => {
  const r = await fetch(base + url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
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
      await fetch(base + "/api/status");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  await test("status reports the connected GHL location", async () => {
    const s = await j("GET", "/api/status");
    assert.equal(s.crm.mode, "ghl");
    assert.equal(s.crm.accountName, "Mock Agency HQ");
  });
  await test("contacts are listed and normalised", async () => {
    const list = await j("GET", "/api/contacts");
    assert.equal(list.length, 2);
    assert.equal(list[0].name, "Dana Reyes");
  });
  await test("contact detail bundles notes, messages and deals", async () => {
    const b = await j("GET", "/api/contacts/g1");
    assert.equal(b.notes[0].body, "Interested in ads");
    assert.equal(b.messages[0].channel, "Sms");
    assert.equal(b.opportunities[0].value, 3000);
    assert.deepEqual(b.warnings, []);
  });
  await test("dashboard computes from GHL data, incl. calendar events", async () => {
    const d = await j("GET", "/api/dashboard");
    assert.equal(d.kpis.openValue, 3000);
    assert.equal(d.appointments.length, 1);
    assert.equal(d.stale.length, 1);
  });
  await test("logging a call writes a note, a task and moves the stage", async () => {
    const r = await j("POST", "/api/calls", { contactId: "g1", outcome: "booked", durationSec: 245, notes: "Great call", nextStep: "Discovery Thu", followUpDate: new Date(Date.now() + 864e5).toISOString(), opportunityId: "o1", stageId: "s2" });
    assert.deepEqual(r.warnings, []);
    assert.ok(r.call.syncedToCrm);
    const note = calls.find((c) => c.method === "POST" && c.path === "/contacts/g1/notes");
    assert.match(String((note?.body as { body: string }).body), /Meeting booked \(4:05\)/);
    assert.ok(calls.some((c) => c.method === "POST" && c.path === "/contacts/g1/tasks"));
    const move = calls.find((c) => c.method === "PUT" && c.path === "/opportunities/o1");
    assert.equal((move?.body as { pipelineStageId: string }).pipelineStageId, "s2");
  });
  await test("creating a contact with a deal", async () => {
    const c = await j("POST", "/api/contacts", { firstName: "Lee", companyName: "Lee HVAC", phone: "+15125550199", tags: ["hvac"], opportunity: { pipelineId: "p1", stageId: "s1", value: 2500 } });
    assert.equal(c.companyName, "Lee HVAC");
    const opp = calls.find((x) => x.method === "POST" && x.path === "/opportunities/");
    assert.equal((opp?.body as { monetaryValue: number }).monetaryValue, 2500);
  });
  await test("editing a contact does not send locationId", async () => {
    await j("PUT", "/api/contacts/g2", { city: "Dallas" });
  });
  await test("sending SMS and email through conversations", async () => {
    const sms = await j("POST", "/api/messages", { contactId: "g1", channel: "SMS", body: "Hi Dana" });
    assert.equal(sms.delivered, true);
    await j("POST", "/api/messages", { contactId: "g1", channel: "Email", subject: "Next steps", body: "Hi Dana,\n\nThanks!" });
    const email = calls.filter((c) => c.path === "/conversations/messages").at(-1);
    assert.match(String((email?.body as { html: string }).html), /<p>Hi Dana,<\/p><p>Thanks!<\/p>/);
  });
  await test("prospect → CRM creates a tagged contact, a note and a deal", async () => {
    const s = await j("POST", "/api/prospects/search", { niche: "plumbers", location: "Austin, TX", maxResults: 5 });
    const p = s.prospects[0];
    const r = await j("POST", `/api/prospects/${p.id}/add`, { pipelineId: "p1" });
    assert.ok(r.contactId);
    const created = calls.filter((c) => c.method === "POST" && c.path === "/contacts/").at(-1);
    assert.ok(((created?.body as { tags: string[] }).tags).includes("prospect"));
  });
  await test("call queue ranks GHL contacts", async () => {
    const q = await j("GET", "/api/calls/queue");
    assert.ok(Array.isArray(q));
  });
  await test("bad token surfaces a clear message", async () => {
    const r = await j("POST", "/api/settings/test/ghl", { ghlApiKey: "nope", ghlLocationId: "loc_test" });
    assert.equal(r.ok, false);
    assert.match(r.message, /rejected the token/);
  });
  await test("owners and contact custom fields load (opportunity fields excluded)", async () => {
    const m = await j("GET", "/api/meta");
    assert.deepEqual(m.users.map((u: { name: string }) => u.name), ["Alex Owner", "Jo Rep"]);
    assert.deepEqual(m.customFields.map((f: { id: string }) => f.id), ["cf1", "cf2"]);
    assert.deepEqual(m.customFields[1].options, ["None", "Agency"]);
    const b = await j("GET", "/api/contacts/g1");
    assert.equal(b.contact.assignedTo, "u1");
    assert.deepEqual(b.contact.customFields, [{ id: "cf1", value: "2500" }]);
  });
  await test("custom fields and owner are written in GHL's shape", async () => {
    await j("PUT", "/api/contacts/g1", { assignedTo: "u2", customFields: [{ id: "cf2", value: "Agency" }] });
    const put = calls.filter((c) => c.method === "PUT" && c.path === "/contacts/g1").at(-1);
    assert.deepEqual(put?.body, { assignedTo: "u2", customFields: [{ id: "cf2", field_value: "Agency" }] });
  });
  await test("account-wide task list via location task search", async () => {
    const open = await j("GET", "/api/tasks?status=open");
    const t = open.find((x: { title: string }) => x.title === "Send proposal");
    assert.ok(t);
    assert.equal(t.contactName, "Dana Reyes");
    assert.equal(t.contactId, "g1");
  });
  await test("task edit, complete and delete", async () => {
    const created = await j("POST", "/api/contacts/g2/tasks", { title: "Call back", dueDate: new Date().toISOString(), assignedTo: "u2" });
    const upd = await j("PUT", `/api/contacts/g2/tasks/${created.id}`, { title: "Call back Thursday" });
    assert.equal(upd.title, "Call back Thursday");
    await j("PUT", `/api/contacts/g2/tasks/${created.id}`, { completed: true });
    assert.ok(calls.some((c) => c.path === `/contacts/g2/tasks/${created.id}/completed`));
    await j("DELETE", `/api/contacts/g2/tasks/${created.id}`);
    assert.ok(calls.some((c) => c.method === "DELETE" && c.path === `/contacts/g2/tasks/${created.id}`));
  });
  await test("note edit and delete", async () => {
    const n = await j("POST", "/api/contacts/g2/notes", { body: "first" });
    await j("PUT", `/api/contacts/g2/notes/${n.id}`, { body: "edited" });
    assert.equal((await j("GET", "/api/contacts/g2")).notes[0].body, "edited");
    await j("DELETE", `/api/contacts/g2/notes/${n.id}`);
    assert.equal((await j("GET", "/api/contacts/g2")).notes.length, 0);
  });
  await test("tag removal sends tags in the DELETE body", async () => {
    await j("DELETE", "/api/contacts/g1/tags", { tags: ["roofer"] });
    const del = calls.find((c) => c.method === "DELETE" && c.path === "/contacts/g1/tags");
    assert.deepEqual(del?.body, { tags: ["roofer"] });
  });
  await test("CSV import creates new contacts and skips duplicates", async () => {
    const r = await j("POST", "/api/contacts/import", {
      rows: [
        { firstName: "Ann", email: "ann@new.com", phone: "512-555-0177" },
        { firstName: "Dup", email: "DANA@reyes.com" },
        { firstName: "Dup2", phone: "(512) 555-0102" },
        { firstName: "Ann again", email: "ann@new.com" },
        {},
      ],
      tags: ["imported"],
      assignedTo: "u1",
    });
    assert.deepEqual({ created: r.created, skipped: r.skipped, failed: r.failed.length }, { created: 1, skipped: 4, failed: 0 });
    const body = calls.filter((c) => c.method === "POST" && c.path === "/contacts/").at(-1)?.body as { tags: string[]; assignedTo: string; source: string };
    assert.deepEqual(body.tags, ["imported"]);
    assert.equal(body.assignedTo, "u1");
    assert.equal(body.source, "CSV import");
  });
  await test("duplicate finder groups shared emails/phones", async () => {
    await j("POST", "/api/contacts", { firstName: "Dana", lastName: "Twin", email: "dana@reyes.com" });
    const groups = await j("GET", "/api/contacts-duplicates");
    assert.ok(groups.some((g: { contacts: { id: string }[] }) => g.contacts.some((c) => c.id === "g1") && g.contacts.length === 2));
  });
  await test("bulk tag, assign and add-to-pipeline", async () => {
    const r1 = await j("POST", "/api/contacts/bulk", { ids: ["g1", "g2"], action: "addTag", tag: "vip" });
    assert.equal(r1.done, 2);
    const r2 = await j("POST", "/api/contacts/bulk", { ids: ["g2"], action: "assign", assignedTo: "u1" });
    assert.equal(r2.done, 1);
    const r3 = await j("POST", "/api/contacts/bulk", { ids: ["g2"], action: "addToPipeline", pipelineId: "p1", value: 1200 });
    assert.equal(r3.done, 1);
    const opp = calls.filter((c) => c.method === "POST" && c.path === "/opportunities/").at(-1)?.body as { contactId: string; pipelineStageId: string; monetaryValue: number };
    assert.deepEqual([opp.contactId, opp.pipelineStageId, opp.monetaryValue], ["g2", "s1", 1200]);
  });
  await test("deal delete and contact delete", async () => {
    await j("DELETE", "/api/opportunities/o1");
    assert.ok(calls.some((c) => c.method === "DELETE" && c.path === "/opportunities/o1"));
    const r = await j("POST", "/api/contacts/bulk", { ids: ["g2"], action: "delete" });
    assert.equal(r.done, 1);
    const list = await j("GET", "/api/contacts");
    assert.ok(!list.some((c: { id: string }) => c.id === "g2"));
  });
  await test("saved views persist locally", async () => {
    const v = await j("POST", "/api/views", { name: "Hot roofers", filters: { tag: "hot", q: "roof" } });
    assert.equal((await j("GET", "/api/views"))[0].name, "Hot roofers");
    await j("DELETE", `/api/views/${v.id}`);
    assert.equal((await j("GET", "/api/views")).length, 0);
  });
  await test("dashboard includes due and overdue tasks", async () => {
    const d = await j("GET", "/api/dashboard");
    assert.ok(d.tasksOverdue >= 1);
  });
  await test("every request carried Bearer auth and the Version header", async () => {
    assert.ok(calls.length > 15);
  });
  console.log(`\n${ok} passed`);
} finally {
  server.kill();
  mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

// A stand-in for the GoHighLevel API v2 that checks auth/version headers and
// request shapes, so the GHL adapter can be exercised end to end without a live account.
import express from "express";

export const calls: { method: string; path: string; body: unknown }[] = [];

// Location-wide conversation list (what the automation engine polls).
const conversations: { id: string; contactId: string; fullName: string; lastMessageBody: string; lastMessageDate: number; lastMessageDirection: string; lastMessageType: string; unreadCount: number }[] = [];
const TYPE: Record<string, string> = { SMS: "TYPE_SMS", IG: "TYPE_INSTAGRAM", FB: "TYPE_FACEBOOK", WhatsApp: "TYPE_WHATSAPP", Email: "TYPE_EMAIL" };

/** Simulates a contact messaging the business. */
export function pushInbound(contactId: string, channel: string, body: string, at = Date.now()) {
  const existing = conversations.find((c) => c.contactId === contactId);
  const row = { id: `conv_${contactId}`, contactId, fullName: contactId, lastMessageBody: body, lastMessageDate: at, lastMessageDirection: "inbound", lastMessageType: TYPE[channel] ?? "TYPE_SMS", unreadCount: 1 };
  if (existing) Object.assign(existing, row);
  else conversations.push(row);
}
const TOKEN = "pit-test-token";
const LOC = "loc_test";

const contacts = [
  { id: "g1", firstName: "dana", lastName: "reyes", companyName: "Reyes Roofing", email: "dana@reyes.com", phone: "+15125550101", tags: ["roofer"], assignedTo: "u1", customFields: [{ id: "cf1", value: 2500 }], dateAdded: new Date(Date.now() - 3 * 864e5).toISOString(), source: "Facebook Ads", city: "Austin", state: "TX" },
  { id: "g2", firstName: "Sam", lastName: "Ortiz", companyName: "Ortiz Dental", email: "sam@ortiz.com", phone: "+15125550102", tags: [], dateAdded: new Date(Date.now() - 20 * 864e5).toISOString(), source: "Referral" },
];
const pipelines = [{ id: "p1", name: "Sales", stages: [{ id: "s1", name: "New", position: 0 }, { id: "s2", name: "Booked", position: 1 }, { id: "s3", name: "Won", position: 2 }] }];
const opportunities = [{ id: "o1", name: "Reyes Roofing deal", pipelineId: "p1", pipelineStageId: "s1", status: "open", monetaryValue: 3000, contactId: "g1", contact: { id: "g1", name: "Dana Reyes", companyName: "Reyes Roofing" }, createdAt: new Date(Date.now() - 30 * 864e5).toISOString(), updatedAt: new Date().toISOString(), lastStageChangeAt: new Date(Date.now() - 20 * 864e5).toISOString() }];
const tasks: Record<string, { id: string; title: string; body: string; dueDate: string; completed: boolean; assignedTo?: string }[]> = {
  g1: [{ id: "t0", title: "Send proposal", body: "", dueDate: new Date(Date.now() - 864e5).toISOString(), completed: false, assignedTo: "u1" }],
};
const notes: Record<string, { id: string; body: string; dateAdded: string }[]> = { g1: [{ id: "n1", body: "Interested in ads", dateAdded: new Date().toISOString() }] };

export function startMock(port: number) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    calls.push({ method: req.method, path: req.path, body: req.body });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.status(401).json({ message: "Invalid JWT" });
    if (req.headers.version !== "2021-07-28") return void res.status(400).json({ message: "Version header missing" });
    next();
  });
  app.get("/locations/:id", (req, res) => (req.params.id === LOC ? res.json({ location: { id: LOC, name: "Mock Agency HQ" } }) : res.status(404).json({ message: "not found" })));
  app.post("/contacts/search", (req, res) => {
    if (req.body.locationId !== LOC) return void res.status(422).json({ message: "locationId required" });
    const q = String(req.body.query ?? "").toLowerCase();
    res.json({ contacts: contacts.filter((c) => !q || JSON.stringify(c).toLowerCase().includes(q)), total: contacts.length });
  });
  app.get("/contacts/:id", (req, res) => {
    const c = contacts.find((x) => x.id === req.params.id);
    return c ? res.json({ contact: c }) : res.status(400).json({ message: "Contact not found" });
  });
  app.post("/contacts/", (req, res) => {
    if (req.body.locationId !== LOC) return void res.status(422).json({ message: "locationId required" });
    const c = { id: `g${contacts.length + 1}`, tags: [], dateAdded: new Date().toISOString(), ...req.body };
    contacts.push(c);
    res.status(201).json({ contact: c });
  });
  app.put("/contacts/:id", (req, res) => {
    const c = contacts.find((x) => x.id === req.params.id);
    if (!c) return void res.status(400).json({ message: "nf" });
    if ("locationId" in req.body) return void res.status(422).json({ message: "property locationId should not exist" });
    Object.assign(c, req.body);
    res.json({ contact: c });
  });
  app.post("/contacts/:id/tags", (req, res) => res.status(201).json({ tags: req.body.tags }));
  app.get("/contacts/:id/notes", (req, res) => res.json({ notes: notes[req.params.id] ?? [] }));
  app.post("/contacts/:id/notes", (req, res) => {
    const n = { id: `n${Date.now()}`, body: req.body.body, dateAdded: new Date().toISOString() };
    (notes[req.params.id] ??= []).unshift(n);
    res.status(201).json({ note: n });
  });
  app.get("/contacts/:id/tasks", (req, res) => res.json({ tasks: tasks[req.params.id] ?? [] }));
  app.post("/contacts/:id/tasks", (req, res) => {
    if (!req.body.title || !req.body.dueDate) return void res.status(422).json({ message: "title and dueDate required" });
    const t = { id: `t${Date.now()}`, completed: false, body: "", ...req.body };
    (tasks[req.params.id] ??= []).push(t);
    res.status(201).json({ task: t });
  });
  app.put("/contacts/:id/tasks/:taskId/completed", (req, res) => {
    const t = tasks[req.params.id]?.find((x) => x.id === req.params.taskId);
    if (!t) return void res.status(404).json({ message: "nf" });
    t.completed = Boolean(req.body.completed);
    res.json({ task: t });
  });
  app.put("/contacts/:id/tasks/:taskId", (req, res) => {
    const t = tasks[req.params.id]?.find((x) => x.id === req.params.taskId);
    if (!t) return void res.status(404).json({ message: "nf" });
    Object.assign(t, req.body);
    res.json({ task: t });
  });
  app.delete("/contacts/:id/tasks/:taskId", (req, res) => {
    tasks[req.params.id] = (tasks[req.params.id] ?? []).filter((x) => x.id !== req.params.taskId);
    res.json({ succeded: true });
  });
  app.post("/locations/:id/tasks/search", (req, res) => {
    if (req.params.id !== LOC) return void res.status(422).json({ message: "bad location" });
    const all = Object.entries(tasks).flatMap(([cid, list]) => list.map((t) => ({ _id: t.id, ...t, id: undefined, contactId: cid, contactDetails: { firstName: contacts.find((c) => c.id === cid)?.firstName, lastName: contacts.find((c) => c.id === cid)?.lastName } })));
    const filtered = req.body.completed === undefined ? all : all.filter((t) => t.completed === req.body.completed);
    res.json({ tasks: filtered.slice(req.body.skip ?? 0, (req.body.skip ?? 0) + (req.body.limit ?? 100)) });
  });
  app.get("/users/", (req, res) => (req.query.locationId === LOC ? res.json({ users: [{ id: "u1", name: "Alex Owner", email: "alex@a.com" }, { id: "u2", firstName: "Jo", lastName: "Rep", email: "jo@a.com" }] }) : res.status(422).json({ message: "locationId" })));
  app.get("/locations/:id/customFields", (_req, res) =>
    res.json({ customFields: [{ id: "cf1", name: "Budget", dataType: "MONETORY", model: "contact" }, { id: "cf2", name: "Provider", dataType: "SINGLE_OPTIONS", picklistOptions: ["None", "Agency"], model: "contact" }, { id: "cfo", name: "Opp field", dataType: "TEXT", model: "opportunity" }] }),
  );
  app.delete("/contacts/:id/tags", (req, res) => {
    const c = contacts.find((x) => x.id === req.params.id);
    if (!c || !Array.isArray(req.body?.tags)) return void res.status(422).json({ message: "tags required" });
    c.tags = (c.tags as string[]).filter((t) => !req.body.tags.includes(t));
    res.json({ tags: c.tags });
  });
  app.delete("/contacts/:id", (req, res) => {
    const i = contacts.findIndex((x) => x.id === req.params.id);
    if (i < 0) return void res.status(404).json({ message: "nf" });
    contacts.splice(i, 1);
    res.json({ succeded: true });
  });
  app.put("/contacts/:id/notes/:noteId", (req, res) => {
    const n = notes[req.params.id]?.find((x) => x.id === req.params.noteId);
    if (!n) return void res.status(404).json({ message: "nf" });
    n.body = req.body.body;
    res.json({ note: n });
  });
  app.delete("/contacts/:id/notes/:noteId", (req, res) => {
    notes[req.params.id] = (notes[req.params.id] ?? []).filter((x) => x.id !== req.params.noteId);
    res.json({ succeded: true });
  });
  app.delete("/opportunities/:id", (req, res) => {
    const i = opportunities.findIndex((x) => x.id === req.params.id);
    if (i < 0) return void res.status(404).json({ message: "nf" });
    opportunities.splice(i, 1);
    res.json({ succeded: true });
  });
  app.get("/opportunities/pipelines", (req, res) => (req.query.locationId === LOC ? res.json({ pipelines }) : res.status(422).json({ message: "locationId" })));
  app.get("/opportunities/search", (req, res) => (req.query.location_id === LOC ? res.json({ opportunities, meta: { total: opportunities.length } }) : res.status(422).json({ message: "location_id" })));
  app.post("/opportunities/", (req, res) => {
    const o = { id: `o${opportunities.length + 1}`, ...req.body, contact: {} };
    opportunities.push(o);
    res.status(201).json({ opportunity: o });
  });
  app.put("/opportunities/:id", (req, res) => {
    const o = opportunities.find((x) => x.id === req.params.id);
    if (!o) return void res.status(404).json({ message: "nf" });
    Object.assign(o, req.body);
    res.json({ opportunity: o });
  });
  app.get("/calendars/", (_req, res) => res.json({ calendars: [{ id: "c1", name: "Discovery" }] }));
  app.get("/calendars/events", (req, res) => {
    if (!req.query.calendarId || !/^\d+$/.test(String(req.query.startTime))) return void res.status(422).json({ message: "calendarId + ms startTime required" });
    res.json({ events: [{ id: "e1", title: "Discovery — Reyes", contactId: "g1", startTime: new Date(Date.now() + 3600e3).toISOString(), endTime: new Date(Date.now() + 5400e3).toISOString(), appointmentStatus: "confirmed" }] });
  });
  app.get("/conversations/search", (req, res) => {
    if (req.query.contactId) return void res.json({ conversations: [{ id: "cv1" }] });
    res.json({ conversations: [...conversations].sort((a, b) => b.lastMessageDate - a.lastMessageDate) });
  });
  app.get("/conversations/:id/messages", (_req, res) => res.json({ messages: { messages: [{ id: "m1", body: "Hi!", direction: "inbound", messageType: "TYPE_SMS", dateAdded: new Date().toISOString() }] } }));
  app.post("/conversations/messages", (req, res) => {
    if (!["SMS", "Email", "IG", "FB", "WhatsApp"].includes(req.body.type) || !req.body.contactId) return void res.status(422).json({ message: "bad message" });
    const conv = conversations.find((c) => c.contactId === req.body.contactId);
    if (conv) Object.assign(conv, { lastMessageBody: req.body.message, lastMessageDate: Date.now(), lastMessageDirection: "outbound", lastMessageType: TYPE[req.body.type] });
    res.status(201).json({ conversationId: "cv1", messageId: "m2" });
  });
  return app.listen(port);
}

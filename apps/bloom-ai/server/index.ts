import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentMeta, allAgents, getAgent } from "./agents.ts";
import { authEnabled, authMiddleware, hosted, mountAuthRoutes } from "./auth.ts";
import { generateMessage, PLAYBOOKS, streamAgent, testClaude } from "./ai.ts";
import * as engine from "./automations.ts";
import * as broadcasts from "./broadcasts.ts";
import { metaOverview, MetaError, syncLeads, testMeta, updateCampaign, listForms, type MetaOverview } from "./meta.ts";
import { getSettings, publicSettings, saveSettings } from "./config.ts";
import { activeDemo, crm, testGhl } from "./crm/index.ts";
import { CrmError, SEND_CHANNELS, type Contact, type ContactInput, type Message, type Opportunity, type Pipeline } from "./crm/types.ts";
import { auditWebsite, scoreProspect, searchBusinesses } from "./prospect.ts";
import { localDb, uid, type SavedView, type CallLog, type CallOutcome, type Prospect, type SiteAudit } from "./store.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1); // behind the hosting platform's HTTPS proxy
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
mountAuthRoutes(app);
app.use(authMiddleware);

// Any successful change to CRM data asks the automation engine to look for new triggers right away.
app.use((req, res, next) => {
  if (req.method !== "GET" && req.path.startsWith("/api/") && !/^\/api\/(automation|ai|settings|webhooks|views)/.test(req.path)) {
    res.on("finish", () => {
      if (res.statusCode < 400) engine.nudge();
    });
  }
  next();
});

type Handler = (req: Request, res: Response) => Promise<unknown>;
const route = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).then(
    (body) => {
      if (!res.headersSent && body !== undefined) res.json(body);
    },
    (err) => next(err),
  );
};
const param = (req: Request, name: string) => String(req.params[name] ?? "");
const DAY = 86_400_000;

// ---- Status & settings --------------------------------------------------

app.get(
  "/api/status",
  route(async () => {
    const s = publicSettings();
    try {
      const info = await crm().info();
      return { ok: true, crm: info, has: s.has, authEnabled };
    } catch (err) {
      return { ok: false, crm: { mode: "ghl", accountName: "" }, has: s.has, error: err instanceof Error ? err.message : String(err) };
    }
  }),
);

app.get("/api/settings", route(async () => publicSettings()));
app.put(
  "/api/settings",
  route(async (req) => {
    saveSettings(req.body ?? {});
    return publicSettings();
  }),
);

app.post(
  "/api/settings/test/:service",
  route(async (req) => {
    const s = getSettings();
    const body = (req.body ?? {}) as Record<string, string>;
    const secret = (v: string | undefined, saved: string) => (v && !v.includes("••••") ? v.trim() : saved);
    try {
      switch (param(req, "service")) {
        case "ghl": {
          const info = await testGhl(secret(body.ghlApiKey, s.ghlApiKey), (body.ghlLocationId || s.ghlLocationId).trim());
          return { ok: true, message: `Connected to “${info.accountName}”.` };
        }
        case "claude": {
          const name = await testClaude(secret(body.anthropicApiKey, s.anthropicApiKey), body.claudeModel || s.claudeModel);
          return { ok: true, message: `Connected — ${name} is available.` };
        }
        case "meta": {
          const r = await testMeta(secret(body.metaAccessToken, s.metaAccessToken));
          return {
            ok: true,
            message: `Connected as ${r.name} — ${r.adAccounts.length} ad account${r.adAccounts.length === 1 ? "" : "s"}, ${r.pages.length} Page${r.pages.length === 1 ? "" : "s"}.`,
            adAccounts: r.adAccounts,
            pages: r.pages,
          };
        }
        case "places": {
          const key = secret(body.googlePlacesApiKey, s.googlePlacesApiKey);
          const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "places.id" },
            body: JSON.stringify({ textQuery: "coffee in Austin", pageSize: 1 }),
          });
          if (!r.ok) {
            const d = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
            return { ok: false, message: d.error?.message ?? `Google returned ${r.status}` };
          }
          return { ok: true, message: "Google Places is working." };
        }
        default:
          return { ok: false, message: "Unknown service" };
      }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }),
);

// ---- Contacts ------------------------------------------------------------

app.get(
  "/api/contacts",
  route(async (req) => crm().listContacts({ query: String(req.query.q ?? ""), limit: Number(req.query.limit ?? 500) })),
);

app.post(
  "/api/contacts",
  route(async (req) => {
    const { opportunity, ...input } = req.body ?? {};
    const contact = await crm().createContact(input);
    if (opportunity?.pipelineId) {
      await crm().createOpportunity({ ...opportunity, contactId: contact.id, name: opportunity.name || `${contact.companyName || contact.name} — New opportunity` });
    }
    return contact;
  }),
);

app.get(
  "/api/contacts/:id",
  route(async (req, res) => {
    const id = param(req, "id");
    const c = crm();
    const contact = await c.getContact(id);
    if (!contact) {
      res.status(404);
      return { error: "Contact not found" };
    }
    const settled = await Promise.allSettled([c.listNotes(id), c.listTasks(id), c.listMessages(id), c.listOpportunities(), c.listPipelines(), c.listUsers(), c.listCustomFields()]);
    const val = <T,>(r: PromiseSettledResult<T>, d: T) => (r.status === "fulfilled" ? r.value : d);
    const opportunities = (val(settled[3], [] as Opportunity[]) ?? []).filter((o) => o.contactId === id);
    return {
      contact,
      notes: val(settled[0], []),
      tasks: val(settled[1], []),
      messages: val(settled[2], []),
      opportunities,
      pipelines: val(settled[4], []),
      users: val(settled[5], []),
      customFields: val(settled[6], []),
      calls: localDb.read().calls.filter((cl) => cl.contactId === id).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
      warnings: settled.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason?.message ?? r)),
    };
  }),
);

app.put("/api/contacts/:id", route(async (req) => crm().updateContact(param(req, "id"), req.body ?? {})));
app.delete(
  "/api/contacts/:id",
  route(async (req) => {
    await crm().deleteContact(param(req, "id"));
    localDb.update((d) => {
      d.calls = d.calls.filter((c) => c.contactId !== param(req, "id"));
    });
    return { ok: true };
  }),
);
app.delete(
  "/api/contacts/:id/tags",
  route(async (req) => {
    await crm().removeTags(param(req, "id"), (req.body?.tags ?? []).map(String));
    return { ok: true };
  }),
);

/** Owners and custom field definitions. Either can be empty if the token lacks the scope. */
app.get(
  "/api/meta",
  route(async () => {
    const [users, customFields] = await Promise.allSettled([crm().listUsers(), crm().listCustomFields()]);
    return {
      users: users.status === "fulfilled" ? users.value : [],
      customFields: customFields.status === "fulfilled" ? customFields.value : [],
    };
  }),
);

const digits = (s: string) => s.replace(/\D/g, "").slice(-10);

app.get(
  "/api/contacts-duplicates",
  route(async () => {
    const contacts = await crm().listContacts({ limit: 2000 });
    const groups = new Map<string, { reason: string; contacts: Contact[] }>();
    const add = (key: string, reason: string, c: Contact) => {
      const g = groups.get(key) ?? { reason, contacts: [] };
      if (!g.contacts.some((x) => x.id === c.id)) g.contacts.push(c);
      groups.set(key, g);
    };
    for (const c of contacts) {
      if (c.email) add(`e:${c.email.toLowerCase().trim()}`, `Same email: ${c.email.toLowerCase()}`, c);
      if (digits(c.phone).length === 10) add(`p:${digits(c.phone)}`, `Same phone: ${c.phone}`, c);
      if (c.firstName && c.lastName && c.companyName) add(`n:${`${c.firstName} ${c.lastName} ${c.companyName}`.toLowerCase()}`, "Same name and company", c);
    }
    // One group per set of contacts, keeping the first reason found.
    const seen = new Set<string>();
    return [...groups.values()]
      .filter((g) => g.contacts.length > 1)
      .filter((g) => {
        const key = g.contacts.map((c) => c.id).sort().join(",");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }),
);

app.post(
  "/api/contacts/import",
  route(async (req) => {
    const rows: ContactInput[] = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 2000) : [];
    const extraTags: string[] = (req.body?.tags ?? []).map(String).filter(Boolean);
    const assignedTo = String(req.body?.assignedTo ?? "");
    // A cold list (bought, scraped, or otherwise without permission) is tagged so automations never text it.
    if (req.body?.coldList) extraTags.push("cold-list");
    const skipDuplicates = req.body?.skipDuplicates !== false;
    const existing = await crm().listContacts({ limit: 2000 });
    const emails = new Set(existing.map((c) => c.email.toLowerCase()).filter(Boolean));
    const phones = new Set(existing.map((c) => digits(c.phone)).filter((p) => p.length === 10));
    const result = { created: 0, skipped: 0, failed: [] as { row: number; error: string }[] };
    let i = 0;
    const work = async () => {
      while (i < rows.length) {
        const n = i++;
        const r = rows[n];
        const email = (r.email ?? "").toLowerCase().trim();
        const phone = digits(r.phone ?? "");
        if (!email && !phone && !r.firstName && !r.lastName && !r.companyName) {
          result.skipped++;
          continue;
        }
        if (skipDuplicates && ((email && emails.has(email)) || (phone.length === 10 && phones.has(phone)))) {
          result.skipped++;
          continue;
        }
        if (email) emails.add(email);
        if (phone.length === 10) phones.add(phone);
        try {
          await crm().createContact({
            ...r,
            source: r.source || "CSV import",
            tags: [...new Set([...(r.tags ?? []), ...extraTags])],
            ...(assignedTo ? { assignedTo } : {}),
          });
          result.created++;
        } catch (err) {
          result.failed.push({ row: n + 1, error: err instanceof Error ? err.message : String(err) });
        }
      }
    };
    // A few in parallel keeps well under GoHighLevel's burst limit.
    await Promise.all([work(), work(), work()]);
    return result;
  }),
);

app.post(
  "/api/contacts/bulk",
  route(async (req) => {
    const ids: string[] = (req.body?.ids ?? []).map(String).slice(0, 1000);
    const action = String(req.body?.action ?? "");
    const c = crm();
    let pipelineStage: { pipelineId: string; stageId: string } | null = null;
    if (action === "addToPipeline") {
      const pl = (await c.listPipelines()).find((p) => p.id === req.body?.pipelineId);
      if (!pl) throw new CrmError("Pick a pipeline", 400);
      pipelineStage = { pipelineId: pl.id, stageId: String(req.body?.stageId || pl.stages[0]?.id) };
    }
    const contacts = action === "addToPipeline" ? new Map((await c.listContacts({ limit: 2000 })).map((x) => [x.id, x])) : null;
    let done = 0;
    const errors: string[] = [];
    let i = 0;
    const work = async () => {
      while (i < ids.length) {
        const id = ids[i++];
        try {
          if (action === "addTag") await c.addTags(id, [String(req.body.tag)]);
          else if (action === "removeTag") await c.removeTags(id, [String(req.body.tag)]);
          else if (action === "assign") await c.updateContact(id, { assignedTo: String(req.body.assignedTo ?? "") });
          else if (action === "delete") await c.deleteContact(id);
          else if (action === "addToPipeline" && pipelineStage) {
            const ct = contacts?.get(id);
            await c.createOpportunity({ ...pipelineStage, contactId: id, name: `${ct?.companyName || ct?.name || "New"} — Opportunity`, value: Number(req.body.value) || 0 });
          } else throw new Error(`Unknown action ${action}`);
          done++;
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
    };
    await Promise.all([work(), work(), work()]);
    if (action === "delete") {
      localDb.update((d) => {
        d.calls = d.calls.filter((cl) => !ids.includes(cl.contactId));
      });
    }
    return { done, failed: errors.length, errors: [...new Set(errors)].slice(0, 5) };
  }),
);

// ---- Saved views ----
app.get("/api/views", route(async () => localDb.read().views));
app.post(
  "/api/views",
  route(async (req) => {
    const view: SavedView = { id: uid("vw"), name: String(req.body?.name ?? "Untitled view").slice(0, 60), filters: req.body?.filters ?? {}, createdAt: new Date().toISOString() };
    localDb.update((d) => d.views.push(view));
    return view;
  }),
);
app.delete(
  "/api/views/:id",
  route(async (req) => {
    localDb.update((d) => {
      d.views = d.views.filter((v) => v.id !== param(req, "id"));
    });
    return { ok: true };
  }),
);
app.post(
  "/api/contacts/:id/tags",
  route(async (req) => {
    await crm().addTags(param(req, "id"), (req.body?.tags ?? []).map(String));
    return { ok: true };
  }),
);
app.post("/api/contacts/:id/notes", route(async (req) => crm().addNote(param(req, "id"), String(req.body?.body ?? ""))));
app.put("/api/contacts/:id/notes/:noteId", route(async (req) => crm().updateNote(param(req, "id"), param(req, "noteId"), String(req.body?.body ?? ""))));
app.delete(
  "/api/contacts/:id/notes/:noteId",
  route(async (req) => {
    await crm().deleteNote(param(req, "id"), param(req, "noteId"));
    return { ok: true };
  }),
);
app.post("/api/contacts/:id/tasks", route(async (req) => crm().addTask(param(req, "id"), req.body)));
app.put(
  "/api/contacts/:id/tasks/:taskId",
  route(async (req) => {
    const b = req.body ?? {};
    const keys = Object.keys(b);
    // Just ticking the box uses GHL's dedicated "completed" endpoint.
    if (keys.length === 1 && keys[0] === "completed") {
      await crm().completeTask(param(req, "id"), param(req, "taskId"), Boolean(b.completed));
      return { ok: true };
    }
    return crm().updateTask(param(req, "id"), param(req, "taskId"), b);
  }),
);
app.delete(
  "/api/contacts/:id/tasks/:taskId",
  route(async (req) => {
    await crm().deleteTask(param(req, "id"), param(req, "taskId"));
    return { ok: true };
  }),
);
app.get(
  "/api/tasks",
  route(async (req) => {
    const status = String(req.query.status ?? "open");
    const tasks = await crm().listAllTasks({ completed: status === "all" ? undefined : status === "completed", limit: 1000 });
    return tasks.sort((a, b) => Number(a.completed) - Number(b.completed) || (a.dueDate || "9").localeCompare(b.dueDate || "9"));
  }),
);
function lastInboundByChannel(messages: Message[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of messages) if (m.direction === "inbound" && (!out[m.channel] || out[m.channel] < m.dateAdded)) out[m.channel] = m.dateAdded;
  return out;
}

app.post(
  "/api/messages",
  route(async (req) => {
    const b = req.body ?? {};
    if (!SEND_CHANNELS.includes(b.channel)) throw new CrmError(`Unsupported channel “${b.channel}”`, 400);
    if (!String(b.body ?? "").trim()) throw new CrmError("Message is empty", 400);
    if (b.channel === "FB" || b.channel === "IG") {
      const last = lastInboundByChannel(await crm().listMessages(String(b.contactId)).catch(() => []))[b.channel];
      if (!last || Date.now() - Date.parse(last) > DAY)
        throw new CrmError(`${b.channel === "IG" ? "Instagram" : "Messenger"} only allows business messages within 24 hours of the person's last message to you. Text or email them instead.`, 400);
    }
    return crm().sendMessage({ contactId: String(b.contactId), channel: b.channel, body: String(b.body), subject: b.subject ? String(b.subject) : undefined });
  }),
);

// ---- Pipeline ---------------------------------------------------------------

app.get("/api/pipelines", route(async () => crm().listPipelines()));
app.get("/api/opportunities", route(async (req) => crm().listOpportunities(req.query.pipelineId ? String(req.query.pipelineId) : undefined)));
app.post("/api/opportunities", route(async (req) => crm().createOpportunity(req.body)));
app.put("/api/opportunities/:id", route(async (req) => crm().updateOpportunity(param(req, "id"), req.body ?? {})));
app.delete(
  "/api/opportunities/:id",
  route(async (req) => {
    await crm().deleteOpportunity(param(req, "id"));
    return { ok: true };
  }),
);
app.get(
  "/api/appointments",
  route(async (req) => {
    const from = String(req.query.from ?? new Date(Date.now() - DAY).toISOString());
    const to = String(req.query.to ?? new Date(Date.now() + 7 * DAY).toISOString());
    return crm().listAppointments(from, to);
  }),
);

function primaryPipeline(pipelines: Pipeline[]): Pipeline | undefined {
  const id = getSettings().defaultPipelineId;
  return pipelines.find((p) => p.id === id) ?? pipelines[0];
}

/** Probability a deal at this stage closes, from its position in the pipeline. */
function stageProbability(p: Pipeline, stageId: string): number {
  const idx = p.stages.findIndex((s) => s.id === stageId);
  if (idx < 0 || p.stages.length < 2) return 0.1;
  return Math.min(0.9, 0.1 + (idx / (p.stages.length - 1)) * 0.8);
}

// ---- Dashboard --------------------------------------------------------------

app.get(
  "/api/dashboard",
  route(async () => {
    const c = crm();
    const now = Date.now();
    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    const [contacts, pipelines, opps, appts, openTasks] = await Promise.all([
      c.listContacts({ limit: 1000 }),
      c.listPipelines(),
      c.listOpportunities(),
      c.listAppointments(startToday.toISOString(), new Date(startToday.getTime() + 2 * DAY).toISOString()).catch(() => []),
      c.listAllTasks({ completed: false, limit: 1000 }).catch(() => []),
    ]);
    const endToday = startToday.getTime() + DAY;
    const dueTasks = openTasks.filter((tk) => tk.dueDate && new Date(tk.dueDate).getTime() < endToday).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const pipeline = primaryPipeline(pipelines);
    const inPipe = pipeline ? opps.filter((o) => o.pipelineId === pipeline.id) : opps;
    const open = inPipe.filter((o) => o.status === "open");
    const wonStage = pipeline?.stages.find((s) => /won|closed|signed/i.test(s.name));
    const isWon = (o: Opportunity) => o.status === "won" || (wonStage && o.stageId === wonStage.id);
    const openActive = open.filter((o) => !isWon(o));
    const t = (s: string | null) => (s ? new Date(s).getTime() : 0);
    const within = (s: string | null, days: number, offset = 0) => {
      const v = t(s);
      return v > now - (days + offset) * DAY && v <= now - offset * DAY;
    };

    const won30 = inPipe.filter((o) => isWon(o) && within(o.lastStageChangeAt ?? o.updatedAt, 30));
    const won90 = inPipe.filter((o) => isWon(o) && within(o.lastStageChangeAt ?? o.updatedAt, 90)).length;
    const lost90 = inPipe.filter((o) => o.status === "lost" && within(o.updatedAt, 90)).length;

    const calls = localDb.read().calls;
    const weekStart = now - 7 * DAY;
    const callsWeek = calls.filter((cl) => t(cl.startedAt) > weekStart);
    const connected = callsWeek.filter((cl) => ["connected", "booked", "callback", "not_interested"].includes(cl.outcome)).length;

    const weeks = Array.from({ length: 12 }, (_, i) => {
      const end = now - (11 - i) * 7 * DAY;
      const start = end - 7 * DAY;
      return {
        label: new Date(start + DAY).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        value: contacts.filter((ct) => t(ct.dateAdded) > start && t(ct.dateAdded) <= end).length,
      };
    });

    const sourceCounts = new Map<string, number>();
    for (const ct of contacts.filter((x) => within(x.dateAdded, 90))) sourceCounts.set(ct.source || "Unknown", (sourceCounts.get(ct.source || "Unknown") ?? 0) + 1);

    const contactById = new Map(contacts.map((ct) => [ct.id, ct]));
    const stale = openActive
      .filter((o) => now - t(o.lastStageChangeAt ?? o.updatedAt) > 14 * DAY)
      .sort((a, b) => b.value - a.value)
      .slice(0, 6)
      .map((o) => ({ ...o, idleDays: Math.floor((now - t(o.lastStageChangeAt ?? o.updatedAt)) / DAY), stageName: pipeline?.stages.find((s) => s.id === o.stageId)?.name ?? "" }));

    const followUps = calls
      .filter((cl) => cl.followUpDate && t(cl.followUpDate) <= startToday.getTime() + DAY)
      .filter((cl) => !calls.some((later) => later.contactId === cl.contactId && later.startedAt > cl.startedAt))
      .slice(0, 8);

    return {
      pipeline: pipeline ? { id: pipeline.id, name: pipeline.name } : null,
      pipelines: pipelines.map((p) => ({ id: p.id, name: p.name })),
      kpis: {
        openValue: openActive.reduce((s, o) => s + o.value, 0),
        openCount: openActive.length,
        weighted: Math.round(pipeline ? openActive.reduce((s, o) => s + o.value * stageProbability(pipeline, o.stageId), 0) : 0),
        wonValue30: won30.reduce((s, o) => s + o.value, 0),
        wonCount30: won30.length,
        winRate90: won90 + lost90 ? won90 / (won90 + lost90) : null,
        newContacts30: contacts.filter((x) => within(x.dateAdded, 30)).length,
        newContactsPrev30: contacts.filter((x) => within(x.dateAdded, 30, 30)).length,
        callsWeek: callsWeek.length,
        connectRate: callsWeek.length ? connected / callsWeek.length : null,
        booked: callsWeek.filter((cl) => cl.outcome === "booked").length,
        totalContacts: contacts.length,
      },
      stages: (pipeline?.stages ?? []).map((s) => {
        const list = inPipe.filter((o) => o.stageId === s.id && (o.status === "open" || isWon(o)));
        return { id: s.id, name: s.name, count: list.length, value: list.reduce((a, o) => a + o.value, 0) };
      }),
      leadsByWeek: weeks,
      sources: [...sourceCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([label, value]) => ({ label, value })),
      stale,
      appointments: appts.map((a) => ({ ...a, contactName: a.contactId ? (contactById.get(a.contactId)?.name ?? "") : "" })),
      followUps,
      tasksDue: dueTasks.slice(0, 8),
      spark: {
        leads: Array.from({ length: 14 }, (_, i) => contacts.filter((x) => { const t0 = startToday.getTime() - (13 - i) * DAY; const v = t(x.dateAdded); return v >= t0 && v < t0 + DAY; }).length),
        calls: Array.from({ length: 14 }, (_, i) => calls.filter((x) => { const t0 = startToday.getTime() - (13 - i) * DAY; const v = t(x.startedAt); return v >= t0 && v < t0 + DAY; }).length),
        won: Array.from({ length: 8 }, (_, i) => inPipe.filter((o) => { const t1 = endToday - (7 - i) * 7 * DAY; const v = t(o.lastStageChangeAt ?? o.updatedAt); return isWon(o) && v >= t1 - 7 * DAY && v < t1; }).reduce((a, o) => a + o.value, 0)),
      },
      today: {
        calls: calls.filter((x) => t(x.startedAt) >= startToday.getTime()).length,
        callGoal: Number(getSettings().callGoal) || 20,
        newLeads: contacts.filter((x) => t(x.dateAdded) >= startToday.getTime()).length,
        automated: engine.automationState().status.sent24h,
      },
      ads: await metaOverview(30)
        .then(async (ov) => {
          const at = await attribution(ov).catch(() => null);
          return { sample: ov.sample, spend: ov.totals.spend, leads: ov.totals.leads, cpl: ov.totals.cpl, roas: at?.roas ?? null, currency: ov.account.currency, daily: ov.daily.slice(-14).map((d) => d.spend) };
        })
        .catch(() => null),
      tasksOverdue: dueTasks.filter((tk) => new Date(tk.dueDate).getTime() < startToday.getTime()).length,
      tasksToday: dueTasks.filter((tk) => new Date(tk.dueDate).getTime() >= startToday.getTime()).length,
      recentCalls: [...calls].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 6),
      newestContacts: contacts.slice(0, 6),
    };
  }),
);

// ---- Calls ----------------------------------------------------------------

app.get("/api/calls", route(async () => [...localDb.read().calls].sort((a, b) => b.startedAt.localeCompare(a.startedAt))));

app.get(
  "/api/calls/queue",
  route(async () => {
    const c = crm();
    const [contacts, opps, pipelines] = await Promise.all([c.listContacts({ limit: 1000 }), c.listOpportunities(), c.listPipelines()]);
    const calls = localDb.read().calls;
    const now = Date.now();
    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    const lastCall = new Map<string, CallLog>();
    for (const cl of calls) if (!lastCall.has(cl.contactId) || lastCall.get(cl.contactId)!.startedAt < cl.startedAt) lastCall.set(cl.contactId, cl);
    const stageName = new Map(pipelines.flatMap((p) => p.stages.map((s) => [s.id, { name: s.name, pos: s.position, total: p.stages.length }] as const)));

    const queue = contacts
      .filter((ct) => ct.phone && !ct.dnd)
      .map((ct) => {
        let score = 0;
        const reasons: string[] = [];
        const lc = lastCall.get(ct.id);
        if (lc && new Date(lc.startedAt).getTime() >= startToday.getTime()) return null;
        if (lc && ["not_interested", "wrong_number"].includes(lc.outcome)) return null;
        if (lc?.followUpDate && new Date(lc.followUpDate).getTime() <= now + 12 * 3_600_000) {
          score += 50;
          reasons.push("Follow-up due");
        }
        const opp = opps.filter((o) => o.contactId === ct.id && o.status === "open").sort((a, b) => b.value - a.value)[0];
        const st = opp ? stageName.get(opp.stageId) : undefined;
        if (opp && st) {
          if (/won|active|onboard/i.test(st.name)) score += 0;
          else if (st.pos <= 1) (score += 30), reasons.push(st.name);
          else (score += 20), reasons.push(st.name);
          if (opp.value >= 4000) (score += 8), reasons.push(`$${opp.value.toLocaleString()}`);
        }
        const ageDays = (now - new Date(ct.dateAdded).getTime()) / DAY;
        if (ageDays < 7 && !lc) (score += 40), reasons.push("New lead, never called");
        if (ct.tags.some((t) => /hot/i.test(t))) (score += 15), reasons.push("Hot");
        if (lc?.outcome === "no_answer" || lc?.outcome === "voicemail") (score += 10), reasons.push("Retry");
        if (score <= 0) return null;
        return { contact: ct, score, reasons, opportunity: opp ?? null, stage: st?.name ?? null, lastCall: lc ?? null };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
    return queue;
  }),
);

const OUTCOME_LABEL: Record<CallOutcome, string> = {
  connected: "Connected",
  booked: "Meeting booked",
  voicemail: "Left voicemail",
  no_answer: "No answer",
  callback: "Callback requested",
  not_interested: "Not interested",
  wrong_number: "Wrong number",
};

app.post(
  "/api/calls",
  route(async (req) => {
    const b = req.body ?? {};
    const contact = await crm().getContact(String(b.contactId));
    if (!contact) throw new CrmError("Contact not found", 404);
    const outcome = (Object.keys(OUTCOME_LABEL).includes(b.outcome) ? b.outcome : "connected") as CallOutcome;
    const log: CallLog = {
      id: uid("cl"),
      contactId: contact.id,
      contactName: contact.name,
      companyName: contact.companyName,
      phone: contact.phone,
      outcome,
      durationSec: Math.max(0, Math.round(Number(b.durationSec) || 0)),
      notes: String(b.notes ?? ""),
      nextStep: String(b.nextStep ?? ""),
      followUpDate: b.followUpDate ? new Date(b.followUpDate).toISOString() : null,
      startedAt: b.startedAt ? new Date(b.startedAt).toISOString() : new Date().toISOString(),
      syncedToCrm: false,
    };
    const warnings: string[] = [];
    const mins = `${Math.floor(log.durationSec / 60)}:${String(log.durationSec % 60).padStart(2, "0")}`;
    const noteBody = [
      `Call — ${OUTCOME_LABEL[outcome]} (${mins})`,
      log.notes && `\n${log.notes}`,
      log.nextStep && `\nNext step: ${log.nextStep}`,
      log.followUpDate && `Follow up: ${new Date(log.followUpDate).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`,
      "\n— Logged in Bloom AI",
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await crm().addNote(contact.id, noteBody);
      log.syncedToCrm = true;
    } catch (err) {
      warnings.push(`Note not saved to CRM: ${err instanceof Error ? err.message : err}`);
    }
    if (log.followUpDate) {
      try {
        await crm().addTask(contact.id, { title: log.nextStep || `Follow up with ${contact.name}`, body: log.notes.slice(0, 500), dueDate: log.followUpDate });
      } catch (err) {
        warnings.push(`Follow-up task not created: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (b.opportunityId && b.stageId) {
      try {
        await crm().updateOpportunity(String(b.opportunityId), { stageId: String(b.stageId) });
      } catch (err) {
        warnings.push(`Stage not updated: ${err instanceof Error ? err.message : err}`);
      }
    }
    localDb.update((d) => d.calls.push(log));
    void engine.fire({ type: "call_logged", contactId: contact.id, outcome, key: `call:${log.id}` });
    return { call: log, warnings };
  }),
);

// ---- Prospecting -----------------------------------------------------------

app.get("/api/prospects", route(async () => [...localDb.read().prospects].sort((a, b) => b.foundAt.localeCompare(a.foundAt))));

app.post(
  "/api/prospects/search",
  route(async (req) => {
    const { prospects, sample } = await searchBusinesses(req.body ?? {});
    const existing = localDb.read().prospects;
    const byPlace = new Map(existing.map((p) => [p.placeId, p]));
    const merged = prospects.map((p) => {
      const prev = byPlace.get(p.placeId);
      return prev ? scoreProspect({ ...p, id: prev.id, audit: prev.audit, status: prev.status, contactId: prev.contactId }) : p;
    });
    localDb.update((d) => {
      const ids = new Set(merged.map((m) => m.placeId));
      d.prospects = [...merged, ...d.prospects.filter((p) => !ids.has(p.placeId))].slice(0, 2000);
    });
    return { prospects: merged, sample };
  }),
);

function simulatedAudit(p: Prospect): SiteAudit {
  const h = [...p.name].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const bit = (n: number) => ((h >> n) & 1) === 1;
  const findings: SiteAudit["findings"] = [
    { level: "warn", text: "Sample prospect — connect Google Places in Settings for real businesses and live audits." },
    bit(1) ? { level: "good", text: "Served over HTTPS." } : { level: "bad", text: "No HTTPS — browsers show “Not secure”." },
    bit(2) ? { level: "good", text: "Mobile viewport set." } : { level: "bad", text: "Not set up for mobile." },
    bit(3) ? { level: "good", text: "Has a lead/contact form." } : { level: "bad", text: "No lead capture form found." },
    bit(4) ? { level: "good", text: "Online booking via Calendly." } : { level: "warn", text: "No online booking." },
    bit(5) ? { level: "good", text: "Tracking: Google Analytics." } : { level: "bad", text: "No analytics or ad pixels — can't measure marketing." },
  ];
  return {
    url: p.website,
    ok: true,
    statusCode: 200,
    https: bit(1),
    responseMs: 400 + (h % 3600),
    title: p.name,
    metaDescription: bit(6),
    mobileViewport: bit(2),
    hasForm: bit(3),
    hasClickToCall: bit(7),
    bookingWidget: bit(4) ? "Calendly" : null,
    chatWidget: null,
    analytics: bit(5) ? ["Google Analytics"] : [],
    copyrightYear: bit(8) ? 2021 : null,
    findings,
    checkedAt: new Date().toISOString(),
  };
}

app.post(
  "/api/prospects/:id/audit",
  route(async (req, res) => {
    const p = localDb.read().prospects.find((x) => x.id === param(req, "id"));
    if (!p) {
      res.status(404);
      return { error: "Prospect not found" };
    }
    if (!p.website) {
      res.status(400);
      return { error: "This business has no website to audit — that's the pitch." };
    }
    const audit = p.sample ? simulatedAudit(p) : await auditWebsite(p.website);
    const updated = scoreProspect({ ...p, audit });
    localDb.update((d) => {
      d.prospects = d.prospects.map((x) => (x.id === p.id ? updated : x));
    });
    return updated;
  }),
);

app.patch(
  "/api/prospects/:id",
  route(async (req) => {
    let out: Prospect | undefined;
    localDb.update((d) => {
      const p = d.prospects.find((x) => x.id === param(req, "id"));
      if (p && req.body?.status) p.status = req.body.status;
      out = p;
    });
    return out ?? { error: "not found" };
  }),
);

app.post(
  "/api/prospects/:id/add",
  route(async (req, res) => {
    const p = localDb.read().prospects.find((x) => x.id === param(req, "id"));
    if (!p) {
      res.status(404);
      return { error: "Prospect not found" };
    }
    if (p.contactId) return { contactId: p.contactId, already: true };
    const contact = await crm().createContact({
      companyName: p.name,
      firstName: String(req.body?.firstName ?? ""),
      lastName: String(req.body?.lastName ?? ""),
      phone: p.phone,
      website: p.website,
      city: p.city,
      source: "Bloom AI Finder",
      tags: ["prospect", ...(req.body?.tags ?? []), ...(p.category ? [p.category.toLowerCase()] : [])],
    });
    const summary = [
      `Prospect added from Bloom AI Finder (search: “${p.search}”).`,
      `Opportunity score ${p.score}/100 — ${p.signals.join(", ") || "no flags"}.`,
      p.rating !== null ? `Google rating ${p.rating} from ${p.reviews} reviews.` : "No Google rating.",
      p.address && `Address: ${p.address}`,
      p.mapsUrl && `Maps: ${p.mapsUrl}`,
      p.audit && `\nWebsite audit:\n${p.audit.findings.map((f) => `• ${f.text}`).join("\n")}`,
    ]
      .filter(Boolean)
      .join("\n");
    await crm().addNote(contact.id, summary).catch(() => undefined);
    const pipelineId = String(req.body?.pipelineId ?? "");
    if (pipelineId) {
      const pipelines = await crm().listPipelines();
      const pl = pipelines.find((x) => x.id === pipelineId);
      if (pl?.stages[0]) {
        await crm().createOpportunity({
          pipelineId,
          stageId: String(req.body?.stageId || pl.stages[0].id),
          contactId: contact.id,
          name: `${p.name} — New opportunity`,
          value: Number(req.body?.value ?? 0),
        });
      }
    }
    localDb.update((d) => {
      const x = d.prospects.find((y) => y.id === p.id);
      if (x) {
        x.status = "added";
        x.contactId = contact.id;
      }
    });
    return { contactId: contact.id };
  }),
);

// ---- Agents & AI ------------------------------------------------------------

app.get(
  "/api/agents",
  route(async () => ({
    agents: allAgents().map(agentMeta),
    playbooks: PLAYBOOKS.map((p) => ({ ...p, agentName: getAgent(p.agentSlug)?.name ?? p.agentSlug })),
  })),
);
app.get(
  "/api/agents/:slug",
  route(async (req, res) => {
    const a = getAgent(param(req, "slug"));
    if (!a) {
      res.status(404);
      return { error: "Agent not found" };
    }
    return a;
  }),
);

app.post("/api/ai/run", (req, res) => {
  const b = req.body ?? {};
  void streamAgent(res, { agentSlug: String(b.agentSlug), messages: Array.isArray(b.messages) ? b.messages : [], effort: b.effort });
});

function fmtDate(s: string | null | undefined) {
  return s ? new Date(s).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "—";
}

async function clientContext(contactId: string): Promise<string> {
  const c = crm();
  const contact = await c.getContact(contactId);
  if (!contact) throw new CrmError("Contact not found", 404);
  const [notes, opps, pipelines, messages] = await Promise.all([
    c.listNotes(contactId).catch(() => []),
    c.listOpportunities().catch(() => [] as Opportunity[]),
    c.listPipelines().catch(() => [] as Pipeline[]),
    c.listMessages(contactId).catch(() => []),
  ]);
  const stage = (o: Opportunity) => pipelines.flatMap((p) => p.stages.map((s) => ({ ...s, pipeline: p.name }))).find((s) => s.id === o.stageId);
  const calls = localDb.read().calls.filter((cl) => cl.contactId === contactId).slice(-8);
  return `## Client
- Name: ${contact.name}
- Company: ${contact.companyName || "—"}
- Email / phone: ${contact.email || "—"} / ${contact.phone || "—"}
- Website: ${contact.website || "none"}
- Location: ${[contact.city, contact.state].filter(Boolean).join(", ") || "—"}
- Lead source: ${contact.source || "—"} · Added ${fmtDate(contact.dateAdded)}
- Tags: ${contact.tags.join(", ") || "—"}

## Opportunities
${
  opps
    .filter((o) => o.contactId === contactId)
    .map((o) => `- ${o.name} · ${stage(o)?.pipeline ?? ""} / ${stage(o)?.name ?? o.stageId} · $${o.value.toLocaleString()} · ${o.status} · in stage since ${fmtDate(o.lastStageChangeAt)}`)
    .join("\n") || "- None"
}

## Notes (newest first)
${notes.slice(0, 12).map((n) => `- [${fmtDate(n.dateAdded)}] ${n.body.replace(/\n+/g, " ").slice(0, 600)}`).join("\n") || "- None"}

## Calls
${calls.map((cl) => `- [${fmtDate(cl.startedAt)}] ${cl.outcome} · ${Math.round(cl.durationSec / 60)} min · ${cl.notes.replace(/\n+/g, " ").slice(0, 400)}${cl.nextStep ? ` · next: ${cl.nextStep}` : ""}`).join("\n") || "- None logged"}

## Recent messages
${messages.slice(0, 8).map((m) => `- [${fmtDate(m.dateAdded)}] ${m.direction} ${m.channel}: ${m.body.replace(/\n+/g, " ").slice(0, 240)}`).join("\n") || "- None"}`;
}

async function adsContext(): Promise<string> {
  const ov = await metaOverview(30);
  const at = await attribution(ov).catch(() => null);
  const m = (n: number) => `${ov.account.currency} ${n.toFixed(2)}`;
  const t = ov.totals;
  return `${ov.sample ? "NOTE: this is sample data (Meta not connected yet) — say so and keep advice general.\n\n" : ""}## Meta ad account: ${ov.account.name} — last ${ov.range} days
- Spend ${m(t.spend)} · Impressions ${t.impressions} · Reach ${t.reach} · Frequency ${t.frequency.toFixed(2)}
- Clicks ${t.clicks} · CTR ${t.ctr.toFixed(2)}% · CPC ${m(t.cpc)} · CPM ${m(t.cpm)}
- Leads (Meta-reported) ${t.leads} · CPL ${t.cpl === null ? "—" : m(t.cpl)}

## What the CRM says these leads became
${at ? `- Leads in CRM from Meta: ${at.crmLeads}\n- Customers won: ${at.customers} · Revenue won: ${m(at.wonValue)} · Open pipeline: ${m(at.openValue)}\n- ROAS on won revenue: ${at.roas === null ? "—" : at.roas.toFixed(2) + "x"} · Cost per customer: ${at.costPerCustomer === null ? "—" : m(at.costPerCustomer)}` : "- Not available"}

## Campaigns
| Campaign | Status | Objective | Daily budget | Spend | CTR | Leads | CPL | CRM leads | CRM won |
|---|---|---|---|---|---|---|---|---|---|
${ov.campaigns
  .map((c) => {
    const a = at?.byCampaign[c.name];
    return `| ${c.name} | ${c.effectiveStatus || c.status} | ${c.objective} | ${c.dailyBudget ?? "—"} | ${c.spend.toFixed(2)} | ${c.ctr.toFixed(2)}% | ${c.leads} | ${c.cpl === null ? "—" : c.cpl.toFixed(2)} | ${a?.crmLeads ?? "—"} | ${a ? a.wonValue : "—"} |`;
  })
  .join("\n")}

## Daily (date, spend, leads)
${ov.daily.map((d) => `${d.date}: ${d.spend.toFixed(2)}, ${d.leads}`).join("\n")}`;
}

async function pipelineContext(): Promise<string> {
  const c = crm();
  const [pipelines, opps] = await Promise.all([c.listPipelines(), c.listOpportunities()]);
  const pl = primaryPipeline(pipelines);
  if (!pl) return "No pipelines found.";
  const now = Date.now();
  const rows = opps
    .filter((o) => o.pipelineId === pl.id)
    .map((o) => {
      const s = pl.stages.find((x) => x.id === o.stageId);
      const idle = Math.floor((now - new Date(o.lastStageChangeAt ?? o.updatedAt).getTime()) / DAY);
      return `| ${o.name} | ${s?.name ?? "?"} | ${o.status} | $${o.value} | ${idle}d | ${fmtDate(o.createdAt)} |`;
    });
  return `Pipeline: ${pl.name}. Stages in order: ${pl.stages.map((s) => s.name).join(" → ")}.\n\n| Deal | Stage | Status | Value | Days in stage | Created |\n|---|---|---|---|---|---|\n${rows.join("\n")}`;
}

app.post("/api/ai/playbook", async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const pb = PLAYBOOKS.find((p) => p.id === b.playbookId);
    if (!pb) {
      res.status(404).json({ error: "Unknown playbook" });
      return;
    }
    let context = "";
    if (pb.id === "pipeline-review") context = await pipelineContext();
    else if (pb.id === "ads-review") context = await adsContext();
    else if (b.prospectId) {
      const p = localDb.read().prospects.find((x) => x.id === b.prospectId);
      if (!p) throw new CrmError("Prospect not found", 404);
      context = `## Prospect\n- ${p.name} (${p.category})\n- ${p.address}\n- Phone: ${p.phone || "none"} · Website: ${p.website || "none"}\n- Google rating: ${p.rating ?? "none"} from ${p.reviews} reviews\n- Opportunity score ${p.score}/100: ${p.signals.join(", ")}\n\n## Website audit\n${p.audit ? p.audit.findings.map((f) => `- [${f.level}] ${f.text}`).join("\n") : "- Not audited yet"}`;
    } else if (b.contactId) context = await clientContext(String(b.contactId));
    const extra = typeof b.extra === "string" && b.extra.trim() ? `\n\n## From me\n${b.extra.trim()}` : "";
    await streamAgent(res, {
      agentSlug: pb.agentSlug,
      effort: pb.effort,
      messages: [{ role: "user", content: `${pb.task}\n\n${context}${extra}` }],
    });
  } catch (err) {
    next(err);
  }
});

// ---- Meta Ads -------------------------------------------------------------------

async function attribution(ov: MetaOverview) {
  if (ov.sample && getSettings().ghlApiKey) return null; // sample spend against real revenue would be misleading
  const c = crm();
  const [contacts, opps] = await Promise.all([c.listContacts({ limit: 2000 }), c.listOpportunities()]);
  const since = Date.now() - ov.range * DAY;
  const leads = localDb.read().metaLeads;
  const leadByContact = new Map(leads.map((l) => [l.contactId, l]));
  const isMeta = (ct: Contact) => leadByContact.has(ct.id) || ct.tags.includes("meta-lead") || /facebook|instagram|meta/i.test(ct.source);
  const metaContacts = contacts.filter(isMeta);
  const ids = new Set(metaContacts.map((x) => x.id));
  const when = (o: Opportunity) => Date.parse(o.lastStageChangeAt ?? o.updatedAt);
  const won = opps.filter((o) => ids.has(o.contactId) && o.status === "won" && when(o) >= since);
  const wonValue = won.reduce((a, o) => a + o.value, 0);
  const customers = new Set(won.map((o) => o.contactId)).size;
  const openValue = opps.filter((o) => ids.has(o.contactId) && o.status === "open").reduce((a, o) => a + o.value, 0);
  const byCampaign: Record<string, { crmLeads: number; wonValue: number }> = {};
  for (const l of leads) {
    if (!l.campaignName || Date.parse(l.createdAt) < since) continue;
    const row = (byCampaign[l.campaignName] ??= { crmLeads: 0, wonValue: 0 });
    row.crmLeads++;
    row.wonValue += opps.filter((o) => o.contactId === l.contactId && o.status === "won").reduce((a, o) => a + o.value, 0);
  }
  return {
    crmLeads: metaContacts.filter((x) => Date.parse(x.dateAdded) >= since).length,
    customers,
    wonValue,
    openValue,
    roas: ov.totals.spend ? wonValue / ov.totals.spend : null,
    costPerCustomer: customers ? ov.totals.spend / customers : null,
    byCampaign,
  };
}

app.get(
  "/api/meta/overview",
  route(async (req) => {
    const ov = await metaOverview(Number(req.query.range ?? 30));
    const st = localDb.read();
    return { ...ov, attribution: await attribution(ov).catch(() => null), sync: st.metaSync, autoSync: getSettings().metaAutoSync === "on", hasPage: Boolean(getSettings().metaPageId) };
  }),
);

app.put(
  "/api/meta/campaigns/:id",
  route(async (req) => {
    if (!getSettings().metaAccessToken) throw new CrmError("Connect Meta in Settings to change campaigns — these are sample campaigns.", 400);
    const b = req.body ?? {};
    return updateCampaign(param(req, "id"), { status: b.status === "PAUSED" || b.status === "ACTIVE" ? b.status : undefined, dailyBudget: b.dailyBudget !== undefined ? Number(b.dailyBudget) : undefined }, String(b.currency ?? "USD"));
  }),
);

app.get("/api/meta/forms", route(async () => listForms()));
app.get("/api/meta/leads", route(async () => localDb.read().metaLeads.slice(0, 200)));

async function runMetaSync() {
  const r = await syncLeads();
  for (const l of r.newContactIds) await engine.fire({ type: "meta_lead", contactId: l.contactId, formName: l.formName, key: `meta:${l.contactId}` });
  return r;
}

app.post(
  "/api/meta/sync",
  route(async () => {
    try {
      return await runMetaSync();
    } catch (err) {
      localDb.update((d) => {
        d.metaSync.lastError = err instanceof Error ? err.message : String(err);
      });
      throw err;
    }
  }),
);

// Pull new lead-form leads every 5 minutes when auto-sync is on.
setInterval(() => {
  const s = getSettings();
  if (s.metaAutoSync === "on" && s.metaAccessToken && s.metaPageId) {
    runMetaSync().catch((err) =>
      localDb.update((d) => {
        d.metaSync.lastError = err instanceof Error ? err.message : String(err);
      }),
    );
  }
}, 5 * 60_000).unref();

// ---- Automations ------------------------------------------------------------------

app.get("/api/automations", route(async () => engine.automationState()));
app.post(
  "/api/automations",
  route(async (req) => engine.createAutomation(req.body ?? {})),
);
app.put(
  "/api/automations/:id",
  route(async (req, res) => {
    const b = req.body ?? {};
    if (b.enabled === true) {
      const current = engine.automationState().automations.find((a) => a.id === param(req, "id"));
      const issues = current ? engine.validate({ ...current, ...b }) : ["Automation not found"];
      if (issues.length) {
        res.status(400);
        return { error: issues.join(" "), issues };
      }
    }
    return engine.updateAutomation(param(req, "id"), b);
  }),
);
app.delete(
  "/api/automations/:id",
  route(async (req) => {
    engine.deleteAutomation(param(req, "id"));
    return { ok: true };
  }),
);
app.post(
  "/api/automations/:id/preview",
  route(async (req) => {
    const a = engine.automationState().automations.find((x) => x.id === param(req, "id"));
    if (!a) throw new CrmError("Automation not found", 404);
    return engine.preview({ ...a, ...(req.body?.draft ?? {}) }, String(req.body?.contactId ?? ""));
  }),
);
app.post("/api/automations/:id/enroll", route(async (req) => ({ enrolled: await engine.enroll(param(req, "id"), (req.body?.contactIds ?? []).map(String)) })));
app.get("/api/automation-log", route(async (req) => engine.listLog(Number(req.query.limit ?? 200), req.query.automationId ? String(req.query.automationId) : undefined)));
app.get("/api/automation-runs", route(async (req) => engine.listRuns(req.query.automationId ? String(req.query.automationId) : undefined)));
app.put("/api/automation-settings", route(async (req) => engine.saveSettings(req.body ?? {})));
app.post(
  "/api/automation-tick",
  route(async () => {
    engine.nudge(0);
    await engine.tick();
    return engine.automationState().status;
  }),
);

/** GoHighLevel workflow → "Webhook" action posts here (inbound messages, new contacts). */
app.post(
  "/api/webhooks/ghl/:secret",
  route(async (req, res) => {
    try {
      return await engine.handleWebhook(param(req, "secret"), req.body ?? {});
    } catch (err) {
      res.status((err as { status?: number }).status ?? 500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }),
);

// ---- Broadcasts -------------------------------------------------------------------

app.get("/api/broadcasts", route(async () => broadcasts.listBroadcasts()));
app.get(
  "/api/broadcasts/:id",
  route(async (req, res) => {
    const b = broadcasts.getBroadcast(param(req, "id"));
    if (!b) {
      res.status(404);
      return { error: "Broadcast not found" };
    }
    return b;
  }),
);
app.post(
  "/api/broadcasts/preview",
  route(async (req) => {
    const b = req.body ?? {};
    const channel = b.channel === "Email" ? "Email" : "SMS";
    const r = await broadcasts.resolveAudience(b.audience ?? { kind: "all" }, channel);
    const first = r.eligible[0];
    return {
      label: r.label,
      total: r.total,
      eligible: r.eligible.length,
      excluded: r.excluded,
      sample: r.eligible.slice(0, 6).map((c) => c.name),
      sampleText: first && b.message ? broadcasts.finalText({ channel, message: String(b.message), optOutLine: b.optOutLine !== false }, first) : "",
      sampleName: first?.name ?? "",
    };
  }),
);
app.post(
  "/api/broadcasts",
  route(async (req, res) => {
    try {
      return await broadcasts.createBroadcast(req.body ?? {});
    } catch (err) {
      res.status(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }),
);
app.post(
  "/api/broadcasts/test",
  route(async (req) => broadcasts.sendTest(req.body ?? {})),
);
app.post(
  "/api/broadcasts/:id/:action",
  route(async (req, res) => {
    const action = param(req, "action");
    if (action !== "pause" && action !== "resume" && action !== "cancel") {
      res.status(404);
      return { error: "Unknown action" };
    }
    const b = broadcasts.setStatus(param(req, "id"), action);
    if (!b) {
      res.status(400);
      return { error: "This broadcast can't be changed any more." };
    }
    return { status: b.status };
  }),
);

// ---- Inbox ------------------------------------------------------------------------

app.get("/api/inbox", route(async (req) => crm().listConversations(Math.min(Number(req.query.limit ?? 60), 100))));
app.get(
  "/api/inbox/:contactId",
  route(async (req, res) => {
    const c = crm();
    const contact = await c.getContact(param(req, "contactId"));
    if (!contact) {
      res.status(404);
      return { error: "Contact not found" };
    }
    const messages = (await c.listMessages(contact.id).catch(() => [])).sort((a, b) => a.dateAdded.localeCompare(b.dateAdded));
    return { contact, messages, lastInbound: lastInboundByChannel(messages) };
  }),
);
app.post(
  "/api/inbox/simulate",
  route(async (req, res) => {
    const demo = activeDemo();
    if (!demo) {
      res.status(400);
      return { error: "Simulated messages are only available in the demo workspace." };
    }
    const b = req.body ?? {};
    const m = demo.simulateInbound(String(b.contactId), String(b.channel ?? "SMS"), String(b.body ?? "Hi!"));
    engine.nudge(200);
    return m;
  }),
);
app.post(
  "/api/ai/draft",
  route(async (req) => {
    const b = req.body ?? {};
    const c = crm();
    const contact = await c.getContact(String(b.contactId));
    if (!contact) throw new CrmError("Contact not found", 404);
    const history = await c.listMessages(contact.id).catch(() => []);
    const gen = await generateMessage({ contact, history, channel: String(b.channel ?? "SMS"), instructions: String(b.instructions ?? "Reply to their latest message and move toward booking a call."), purpose: "reply", agentSlug: b.agentSlug });
    if (!gen) throw new CrmError("Claude isn't connected. Add your Anthropic API key in Settings.", 400);
    return { text: gen.text, handoff: gen.handoff };
  }),
);

// ---- Static client & errors -------------------------------------------------

const dist = path.resolve(here, "..", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof CrmError || err instanceof MetaError ? err.status : 500;
  const message = err instanceof Error ? err.message : "Unexpected error";
  if (status >= 500) console.error(err);
  if (res.headersSent) return void res.end();
  res.status(status).json({ error: message });
});

const port = Number(process.env.PORT ?? 4400);
app.listen(port, () => {
  const s = getSettings();
  console.log(`Bloom AI on http://localhost:${port}`);
  console.log(`  Login: ${authEnabled ? "password required" : hosted ? "LOCKED — set BLOOM_PASSWORD to finish setup" : "off (local use)"}`);
  console.log(`  CRM: ${s.ghlApiKey && s.ghlLocationId ? "GoHighLevel" : "demo workspace (connect GoHighLevel in Settings)"}`);
  console.log(`  Agents indexed: ${allAgents().length}`);
  console.log(`  Meta Ads: ${s.metaAccessToken ? "connected" : "sample data (connect in Settings)"}`);
  engine.startEngine();
});

export type { Contact };

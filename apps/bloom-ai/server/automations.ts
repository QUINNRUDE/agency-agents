// Bloom AI automation engine: watches the CRM for triggers and runs
// multi-step sequences that send texts, emails and Messenger / Instagram /
// WhatsApp DMs automatically — from templates or written by Claude — with
// guardrails for opt-outs, quiet hours, frequency caps and Meta's 24-hour rule.
import crypto from "node:crypto";
import { generateMessage } from "./ai.ts";
import { getSettings } from "./config.ts";
import { crm } from "./crm/index.ts";
import { normalizeChannel, SEND_CHANNELS, type Contact, type SendChannel } from "./crm/types.ts";
import { JsonFile, uid } from "./store.ts";

export type TriggerType = "new_contact" | "meta_lead" | "inbound_message" | "tag_added" | "stage_changed" | "deal_idle" | "call_logged" | "manual";

export interface Trigger {
  type: TriggerType;
  tag?: string;
  stageId?: string;
  channel?: string; // inbound: any | SMS | DM (FB+IG) | FB | IG | WhatsApp | Email
  keyword?: string; // inbound: comma-separated, any match
  days?: number; // deal_idle
  outcome?: string; // call_logged
  formName?: string; // meta_lead: form name contains
  includeProspects?: boolean; // new_contact: also enroll cold prospects (they still can't be texted without consent)
}

export type StepType = "wait" | "send" | "add_tag" | "remove_tag" | "create_task" | "move_stage";

export interface Step {
  id: string;
  type: StepType;
  amount?: number;
  unit?: "minutes" | "hours" | "days";
  channel?: SendChannel | "reply";
  mode?: "template" | "ai";
  text?: string;
  subject?: string;
  instructions?: string;
  agentSlug?: string;
  tag?: string;
  title?: string;
  dueInDays?: number;
  stageId?: string;
}

export interface Automation {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: Trigger;
  steps: Step[];
  exitOnReply: boolean;
  createdAt: string;
  updatedAt: string;
  stats: { enrolled: number; sent: number; skipped: number; failed: number; handoffs: number };
}

export interface Run {
  id: string;
  automationId: string;
  contactId: string;
  contactName: string;
  step: number;
  waiting: boolean;
  nextAt: string;
  status: "active" | "done" | "exited" | "failed";
  startedAt: string;
  endedAt?: string;
  reason?: string;
  context: { channel?: string; inboundText?: string; inboundAt?: string; detail?: string };
}

export type LogStatus = "sent" | "demo" | "dry_run" | "skipped" | "failed" | "handoff" | "action";

export interface SendLog {
  id: string;
  at: string;
  automationId: string;
  automationName: string;
  runId: string;
  contactId: string;
  contactName: string;
  channel: string;
  body: string;
  status: LogStatus;
  reason: string;
  ai: boolean;
}

export interface EngineSettings {
  enabled: boolean;
  dryRun: boolean;
  quietStart: string; // "08:00"
  quietEnd: string; // "20:00"
  timezone: string;
  maxPerContactPerDay: number;
  maxPerDay: number;
  webhookSecret: string;
}

interface Watch {
  seeded: boolean;
  contactIds: string[];
  tags: Record<string, string[]>;
  stages: Record<string, string>;
  conv: Record<string, string>;
  lastInbound: Record<string, Record<string, string>>; // contactId → channel → ISO
  idleFired: Record<string, string>;
  lastPoll: string;
  lastIdleCheck: string;
  lastError: string;
}

interface AutoDb {
  settings: EngineSettings;
  automations: Automation[];
  runs: Run[];
  log: SendLog[];
  watch: Watch;
  dedupe: Record<string, string>;
}

const freshWatch = (): Watch => ({ seeded: false, contactIds: [], tags: {}, stages: {}, conv: {}, lastInbound: {}, idleFired: {}, lastPoll: "", lastIdleCheck: "", lastError: "" });

const file = new JsonFile<AutoDb>("automations.json", () => ({
  settings: {
    enabled: true,
    dryRun: false,
    quietStart: "08:00",
    quietEnd: "20:00",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York",
    maxPerContactPerDay: 3,
    maxPerDay: 300,
    webhookSecret: crypto.randomBytes(16).toString("hex"),
  },
  automations: [],
  runs: [],
  log: [],
  watch: freshWatch(),
  dedupe: {},
}));

const db = {
  read: () => file.read(),
  update: (fn: (d: AutoDb) => void) => file.update(fn),
};

const OPT_OUT = /^\s*(stop|stopall|stop all|unsubscribe|cancel|end|quit|opt[\s-]?out|remove me)\b/i;
export const OPTED_OUT_TAGS = ["opted-out", "dnd", "do-not-contact"];
// Cold prospects (found with Find clients or imported as a cold list) never gave permission to be texted.
const PROSPECT_TAGS = ["prospect", "cold-list"];
// Any of these, or the contact messaging you first, counts as permission to text.
const CONSENT_TAGS = ["sms-ok", "sms-consent", "opted-in"];
// Said "no texts" on a lead form: email is fine, texts are not, unless they text you first.
const DECLINED_TAGS = ["no-texts"];

/**
 * Drops runs and log entries for contacts that no longer exist (the sample business), and
 * optionally forgets what the engine has seen so it takes a fresh first look at the CRM.
 */
export function forgetContacts(ids: Set<string>, resetWatch: boolean): void {
  db.update((d) => {
    d.runs = d.runs.filter((r) => !ids.has(r.contactId));
    d.log = d.log.filter((l) => !ids.has(l.contactId));
    if (resetWatch) d.watch = freshWatch();
  });
}

/** A cold prospect, or someone who declined texts, with no permission to receive automated texts. */
export function noTextConsent(c: Contact): boolean {
  const tags = c.tags.map((t) => t.toLowerCase());
  const declined = tags.some((t) => DECLINED_TAGS.includes(t));
  if (!declined && !tags.some((t) => PROSPECT_TAGS.includes(t))) return false;
  if (!declined && tags.some((t) => CONSENT_TAGS.includes(t))) return false;
  return !db.read().watch.lastInbound[c.id]?.["*"];
}
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---- Recipes ------------------------------------------------------------------

type Recipe = Omit<Automation, "id" | "createdAt" | "updatedAt" | "stats" | "enabled"> & { recipeId: string; icon: string; needs?: string };
const sid = () => uid("st");

export const RECIPES: Recipe[] = [
  {
    recipeId: "speed-to-lead",
    icon: "zap",
    name: "Speed-to-lead text",
    description: "Texts every new lead within a minute, follows up if they go quiet, then hands you a call task.",
    trigger: { type: "new_contact" },
    exitOnReply: true,
    steps: [
      { id: sid(), type: "send", channel: "SMS", mode: "template", text: "Hi {{first_name}}, it's {{my_name}} from {{agency}} — thanks for reaching out! What's the best time today or tomorrow for a quick 10-minute call?" },
      { id: sid(), type: "wait", amount: 1, unit: "days" },
      { id: sid(), type: "send", channel: "SMS", mode: "ai", instructions: "They haven't replied to yesterday's text. Send a short, friendly nudge with one easy question. Include the booking link if one is set.", text: "Hi {{first_name}}, just following up — would a quick call this week help? {{booking_link}}" },
      { id: sid(), type: "wait", amount: 2, unit: "days" },
      { id: sid(), type: "create_task", title: "Call {{first_name}} — no reply to texts", dueInDays: 0 },
    ],
  },
  {
    recipeId: "meta-lead",
    icon: "megaphone",
    name: "Meta lead instant follow-up",
    description: "When someone fills in a Facebook or Instagram lead form, text them instantly and email the next day.",
    trigger: { type: "meta_lead" },
    exitOnReply: true,
    needs: "meta",
    steps: [
      { id: sid(), type: "send", channel: "SMS", mode: "template", text: "Hi {{first_name}}! {{my_name}} from {{agency}} here — got your request from our ad. Is now a good time for a quick call, or is later today better?" },
      { id: sid(), type: "add_tag", tag: "contacted" },
      { id: sid(), type: "wait", amount: 1, unit: "days" },
      { id: sid(), type: "send", channel: "Email", mode: "ai", subject: "Your request, {{first_name}}", instructions: "They filled in our Facebook/Instagram lead form yesterday and haven't replied to our text. Write a short, helpful email that restates what we do for businesses like theirs and invites them to book a call.", text: "Hi {{first_name}},\n\nThanks for your request yesterday. Would a quick call this week work? You can grab a time here: {{booking_link}}\n\n{{my_name}}" },
    ],
  },
  {
    recipeId: "ai-dm-responder",
    icon: "instagram",
    name: "AI DM responder",
    description: "Answers every Instagram and Messenger DM within a minute, qualifies the lead, and hands off anything tricky.",
    trigger: { type: "inbound_message", channel: "DM" },
    exitOnReply: false,
    steps: [
      { id: sid(), type: "send", channel: "reply", mode: "ai", agentSlug: "sales-outreach", instructions: "Answer their question using only the business profile. If they're a potential client, ask one qualifying question (what they need and their timeline) and invite them to book a call using the booking link if one is set.", text: "Thanks for reaching out, {{first_name}}! Happy to help — what are you hoping to get done, and how soon? {{booking_link}}" },
      { id: sid(), type: "add_tag", tag: "dm-lead" },
    ],
  },
  {
    recipeId: "ai-sms-responder",
    icon: "message",
    name: "AI text responder",
    description: "Replies to inbound texts automatically, after hours or all day, and flags conversations that need you.",
    trigger: { type: "inbound_message", channel: "SMS" },
    exitOnReply: false,
    steps: [{ id: sid(), type: "send", channel: "reply", mode: "ai", agentSlug: "sales-outreach", instructions: "Reply helpfully and briefly. Move the conversation toward booking a call. Use the booking link if one is set.", text: "Thanks {{first_name}}! Got your message — what's the best time for a quick call? {{booking_link}}" }],
  },
  {
    recipeId: "stale-deal",
    icon: "snowflake",
    name: "Revive deals going cold",
    description: "When a deal sits in one stage for 14 days, send a personal check-in and remind you to call.",
    trigger: { type: "deal_idle", days: 14 },
    exitOnReply: true,
    steps: [
      { id: sid(), type: "send", channel: "SMS", mode: "ai", instructions: "Their deal has been quiet for two weeks. Send a casual, no-pressure check-in that references what they were interested in and asks one simple question.", text: "Hi {{first_name}}, checking in — is getting more customers still a priority this month?" },
      { id: sid(), type: "wait", amount: 3, unit: "days" },
      { id: sid(), type: "create_task", title: "Call {{first_name}} — deal has gone quiet", dueInDays: 0 },
    ],
  },
  {
    recipeId: "booked-confirmation",
    icon: "calendar",
    name: "Booked-call confirmation",
    description: "After you log a call as “meeting booked”, text a confirmation, then a reminder the day before.",
    trigger: { type: "call_logged", outcome: "booked" },
    exitOnReply: false,
    steps: [
      { id: sid(), type: "send", channel: "SMS", mode: "template", text: "Great talking with you, {{first_name}}! You're booked in — I'll send over a quick agenda before we meet. Reply here if anything changes. – {{my_name}}" },
      { id: sid(), type: "add_tag", tag: "meeting-booked" },
    ],
  },
  {
    recipeId: "review-request",
    icon: "star",
    name: "Review request after a win",
    description: "A week after a deal moves to your won stage, ask for a Google review.",
    trigger: { type: "stage_changed", stageId: "" },
    exitOnReply: true,
    needs: "stage",
    steps: [
      { id: sid(), type: "wait", amount: 7, unit: "days" },
      { id: sid(), type: "send", channel: "SMS", mode: "template", text: "Hi {{first_name}}, it's been great working with you! Would you mind leaving us a quick review? It really helps a small business like ours. Thank you! – {{my_name}}" },
    ],
  },
];

// ---- Public API -----------------------------------------------------------------

export function automationState() {
  const d = db.read();
  const active = d.runs.filter((r) => r.status === "active");
  return {
    settings: d.settings,
    automations: d.automations,
    status: {
      seeded: d.watch.seeded,
      lastPoll: d.watch.lastPoll,
      lastError: d.watch.lastError,
      activeRuns: active.length,
      nextRunAt: active.map((r) => r.nextAt).sort()[0] ?? null,
      sent24h: d.log.filter((l) => (l.status === "sent" || l.status === "demo") && Date.now() - Date.parse(l.at) < DAY).length,
    },
    recipes: RECIPES.map(({ steps: _s, ...r }) => r),
  };
}

export function listLog(limit = 200, automationId?: string) {
  return db.read().log.filter((l) => !automationId || l.automationId === automationId).slice(0, limit);
}

export function listRuns(automationId?: string) {
  return db
    .read()
    .runs.filter((r) => !automationId || r.automationId === automationId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 200);
}

export function saveSettings(patch: Partial<EngineSettings>) {
  db.update((d) => {
    const wasOn = d.settings.enabled;
    d.settings = { ...d.settings, ...patch, webhookSecret: d.settings.webhookSecret };
    d.settings.maxPerContactPerDay = Math.max(1, Math.min(20, Number(d.settings.maxPerContactPerDay) || 3));
    d.settings.maxPerDay = Math.max(1, Math.min(5000, Number(d.settings.maxPerDay) || 300));
    // Turning the engine back on re-baselines what it has "seen", so changes made while it was off don't all fire at once.
    if (!wasOn && d.settings.enabled) d.watch = freshWatch();
  });
  nudge();
  return db.read().settings;
}

export function createAutomation(input: Partial<Automation> & { recipeId?: string }): Automation {
  const recipe = input.recipeId ? RECIPES.find((r) => r.recipeId === input.recipeId) : undefined;
  const now = new Date().toISOString();
  const base = recipe ? structuredClone(recipe) : null;
  const a: Automation = {
    id: uid("au"),
    name: input.name ?? base?.name ?? "Untitled automation",
    description: input.description ?? base?.description ?? "",
    enabled: false,
    trigger: input.trigger ?? base?.trigger ?? { type: "new_contact" },
    steps: (input.steps ?? base?.steps ?? []).map((s) => ({ ...s, id: s.id || sid() })),
    exitOnReply: input.exitOnReply ?? base?.exitOnReply ?? true,
    createdAt: now,
    updatedAt: now,
    stats: { enrolled: 0, sent: 0, skipped: 0, failed: 0, handoffs: 0 },
  };
  db.update((d) => d.automations.push(a));
  return a;
}

export function updateAutomation(id: string, patch: Partial<Automation>): Automation {
  let out: Automation | undefined;
  db.update((d) => {
    const a = d.automations.find((x) => x.id === id);
    if (!a) return;
    if (patch.name !== undefined) a.name = patch.name;
    if (patch.description !== undefined) a.description = patch.description;
    if (patch.enabled !== undefined) a.enabled = patch.enabled;
    if (patch.trigger) a.trigger = patch.trigger;
    if (patch.steps) a.steps = patch.steps.map((s) => ({ ...s, id: s.id || sid() }));
    if (patch.exitOnReply !== undefined) a.exitOnReply = patch.exitOnReply;
    a.updatedAt = new Date().toISOString();
    // Turning an automation off ends its in-flight runs.
    if (patch.enabled === false) {
      for (const r of d.runs) if (r.automationId === id && r.status === "active") end(r, "exited", "Automation turned off");
    }
    out = a;
  });
  if (!out) throw new Error("Automation not found");
  return out;
}

export function deleteAutomation(id: string) {
  db.update((d) => {
    d.automations = d.automations.filter((a) => a.id !== id);
    for (const r of d.runs) if (r.automationId === id && r.status === "active") end(r, "exited", "Automation deleted");
  });
}

/** Problems that would stop an automation from working, shown before it can be turned on. */
export function validate(a: Automation): string[] {
  const issues: string[] = [];
  if (!a.steps.length) issues.push("Add at least one step.");
  if (a.trigger.type === "tag_added" && !a.trigger.tag) issues.push("Pick the tag that starts this automation.");
  if (a.trigger.type === "stage_changed" && !a.trigger.stageId) issues.push("Pick the pipeline stage that starts this automation.");
  if (a.trigger.type === "deal_idle" && !(Number(a.trigger.days) > 0)) issues.push("Set how many idle days start this automation.");
  for (const [i, s] of a.steps.entries()) {
    if (s.type === "send" && s.mode !== "ai" && !s.text?.trim()) issues.push(`Step ${i + 1}: write the message.`);
    if (s.type === "send" && s.channel === "reply" && a.trigger.type !== "inbound_message") issues.push(`Step ${i + 1}: “Reply on the same channel” only works with the “Message received” trigger.`);
    if ((s.type === "add_tag" || s.type === "remove_tag") && !s.tag) issues.push(`Step ${i + 1}: pick a tag.`);
    if (s.type === "move_stage" && !s.stageId) issues.push(`Step ${i + 1}: pick a stage.`);
    if (s.type === "wait" && !(Number(s.amount) > 0)) issues.push(`Step ${i + 1}: set how long to wait.`);
  }
  return issues;
}

export interface EngineEvent {
  type: TriggerType;
  contactId: string;
  key: string; // de-duplication key
  tag?: string;
  stageId?: string;
  channel?: string;
  body?: string;
  at?: string;
  outcome?: string;
  formName?: string;
  days?: number;
}

function matches(t: Trigger, e: EngineEvent): boolean {
  if (t.type !== e.type) return false;
  switch (t.type) {
    case "tag_added":
      return Boolean(t.tag) && t.tag!.toLowerCase() === (e.tag ?? "").toLowerCase();
    case "stage_changed":
      return Boolean(t.stageId) && t.stageId === e.stageId;
    case "inbound_message": {
      const ch = (t.channel ?? "any").toUpperCase();
      const ec = (e.channel ?? "").toUpperCase();
      if (ch !== "ANY" && !(ch === "DM" ? ec === "FB" || ec === "IG" : ch === ec)) return false;
      const words = (t.keyword ?? "").split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
      return !words.length || words.some((w) => (e.body ?? "").toLowerCase().includes(w));
    }
    case "call_logged":
      return !t.outcome || t.outcome === "any" || t.outcome === e.outcome;
    case "meta_lead":
      return !t.formName || (e.formName ?? "").toLowerCase().includes(t.formName.toLowerCase());
    case "deal_idle":
      return Number(t.days) === e.days;
    default:
      return true;
  }
}

/** Feed an event into the engine: enrolls the contact in every enabled automation it matches. */
export async function fire(e: EngineEvent): Promise<number> {
  const d = db.read();
  if (!d.settings.enabled) return 0;
  if (e.type === "inbound_message") {
    const handled = await handleInbound(e);
    if (handled === "opted_out") return 0;
  }
  const targets = d.automations.filter((a) => a.enabled && matches(a.trigger, e));
  if (!targets.length) return 0;
  const contact = await crm().getContact(e.contactId).catch(() => null);
  if (!contact) return 0;
  // "Thanks for reaching out" sequences are for people who reached out, not for cold prospects you added yourself.
  const eligible = targets.filter((a) => !(e.type === "new_contact" && noTextConsent(contact) && !a.trigger.includeProspects));
  let n = 0;
  db.update((x) => {
    for (const a of eligible) {
      const key = `${a.id}:${e.key}`;
      if (x.dedupe[key]) continue;
      if (x.runs.some((r) => r.automationId === a.id && r.contactId === e.contactId && r.status === "active")) continue;
      x.dedupe[key] = new Date().toISOString();
      x.runs.push({
        id: uid("run"),
        automationId: a.id,
        contactId: contact.id,
        contactName: contact.name,
        step: 0,
        waiting: false,
        nextAt: new Date().toISOString(),
        status: "active",
        startedAt: new Date().toISOString(),
        context: { channel: e.channel, inboundText: e.body, inboundAt: e.at, detail: e.tag ?? e.outcome ?? e.formName },
      });
      a.stats.enrolled++;
      n++;
    }
  });
  if (n) nudge(0);
  return n;
}

/** Manually enroll contacts (from the builder) regardless of trigger. */
export async function enroll(automationId: string, contactIds: string[]) {
  const a = db.read().automations.find((x) => x.id === automationId);
  if (!a) throw new Error("Automation not found");
  const contacts = await Promise.all(contactIds.slice(0, 500).map((id) => crm().getContact(id).catch(() => null)));
  let n = 0;
  db.update((d) => {
    const au = d.automations.find((x) => x.id === automationId)!;
    for (const c of contacts) {
      if (!c || d.runs.some((r) => r.automationId === automationId && r.contactId === c.id && r.status === "active")) continue;
      d.runs.push({ id: uid("run"), automationId, contactId: c.id, contactName: c.name, step: 0, waiting: false, nextAt: new Date().toISOString(), status: "active", startedAt: new Date().toISOString(), context: { detail: "Enrolled manually" } });
      au.stats.enrolled++;
      n++;
    }
  });
  nudge(0);
  return n;
}

/** Inbound bookkeeping: opt-outs, the 24-hour DM window, and exiting sequences when someone replies. */
async function handleInbound(e: EngineEvent): Promise<"opted_out" | "ok"> {
  const at = e.at ?? new Date().toISOString();
  const channel = e.channel ?? "SMS";
  db.update((d) => {
    const m = (d.watch.lastInbound[e.contactId] ??= {});
    if (!m[channel] || m[channel] < at) m[channel] = at;
    const anyKey = "*";
    if (!m[anyKey] || m[anyKey] < at) m[anyKey] = at;
  });
  if (OPT_OUT.test(e.body ?? "")) {
    await crm().addTags(e.contactId, ["opted-out"]).catch(() => undefined);
    db.update((d) => {
      for (const r of d.runs) if (r.contactId === e.contactId && r.status === "active") end(r, "exited", "Contact opted out");
      d.log.unshift(logEntry({ automationId: "", automationName: "Opt-out", runId: "", contactId: e.contactId, contactName: "", channel, body: e.body ?? "", status: "skipped", reason: "Opt-out keyword received — contact tagged opted-out and removed from all automations", ai: false }));
    });
    return "opted_out";
  }
  return "ok";
}

// ---- Engine loop -------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let nudgeTimer: NodeJS.Timeout | null = null;
let pollForced = false;

/** Ask the engine to check for changes soon (after the app itself changes the CRM). */
export function nudge(delayMs = 1500) {
  pollForced = true;
  if (nudgeTimer) clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => void tick(), delayMs);
}

export function startEngine() {
  if (timer) return;
  timer = setInterval(() => void tick(), 10_000);
  setTimeout(() => void tick(), 2_000);
}

export function stopEngine() {
  if (timer) clearInterval(timer);
  timer = null;
}

let current: Promise<void> | null = null;
let again = false;

/**
 * Runs one engine pass (poll for triggers, then advance due sequences). If a pass is already
 * running, the caller waits for it and one more pass runs afterwards, so requests made mid-pass
 * (a new contact, an inbound DM) are never dropped until the next interval.
 */
export function tick(): Promise<void> {
  if (current) {
    again = true;
    return current;
  }
  current = (async () => {
    do {
      again = false;
      await tickOnce();
    } while (again);
  })().finally(() => {
    current = null;
  });
  return current;
}

async function tickOnce() {
  const d = db.read();
  if (!d.settings.enabled) return;
  const isDemo = !getSettings().ghlApiKey;
  const every = isDemo ? 10_000 : 45_000;
  if (pollForced || !d.watch.lastPoll || Date.now() - Date.parse(d.watch.lastPoll) >= every) {
    pollForced = false;
    try {
      await poll();
      db.update((x) => {
        x.watch.lastError = "";
      });
    } catch (err) {
      db.update((x) => {
        x.watch.lastError = err instanceof Error ? err.message : String(err);
        x.watch.lastPoll = new Date().toISOString();
      });
    }
  }
  await processDue();
}

async function poll() {
  const c = crm();
  const [contacts, opps, convs] = await Promise.all([c.listContacts({ limit: 300 }), c.listOpportunities(), c.listConversations(60)]);
  const w = db.read().watch;
  const now = new Date().toISOString();

  if (!w.seeded) {
    // First look: remember what exists so nothing already in the CRM gets blasted.
    db.update((d) => {
      d.watch.contactIds = contacts.map((x) => x.id);
      d.watch.tags = Object.fromEntries(contacts.map((x) => [x.id, x.tags]));
      d.watch.stages = Object.fromEntries(opps.map((o) => [o.id, o.stageId]));
      d.watch.conv = Object.fromEntries(convs.map((cv) => [cv.id, cv.lastMessageDate]));
      for (const cv of convs) {
        if (cv.lastMessageDirection !== "inbound") continue;
        const m = (d.watch.lastInbound[cv.contactId] ??= {});
        m[cv.channel] = cv.lastMessageDate;
        if (!m["*"] || m["*"] < cv.lastMessageDate) m["*"] = cv.lastMessageDate;
      }
      d.watch.seeded = true;
      d.watch.lastPoll = now;
      d.watch.lastIdleCheck = now;
    });
    return;
  }

  const events: EngineEvent[] = [];
  const known = new Set(w.contactIds);
  for (const ct of contacts) {
    if (!known.has(ct.id) && Date.now() - Date.parse(ct.dateAdded || now) < 2 * DAY) {
      events.push({ type: "new_contact", contactId: ct.id, key: `new:${ct.id}` });
      // Tags a contact is created with count as "added" too.
      for (const t of ct.tags) events.push({ type: "tag_added", contactId: ct.id, tag: t, key: `tag:${ct.id}:${t}:new` });
    }
    const prev = w.tags[ct.id];
    if (prev) for (const t of ct.tags) if (!prev.includes(t)) events.push({ type: "tag_added", contactId: ct.id, tag: t, key: `tag:${ct.id}:${t}:${now}` });
  }
  for (const o of opps) {
    const prev = w.stages[o.id];
    if (prev !== o.stageId && o.contactId) events.push({ type: "stage_changed", contactId: o.contactId, stageId: o.stageId, key: `stage:${o.id}:${o.stageId}:${now}` });
  }
  for (const cv of convs) {
    const seen = w.conv[cv.id];
    if (cv.lastMessageDirection === "inbound" && cv.lastMessageDate && (!seen || cv.lastMessageDate > seen)) {
      events.push({ type: "inbound_message", contactId: cv.contactId, channel: cv.channel, body: cv.lastMessageBody, at: cv.lastMessageDate, key: `in:${cv.id}:${cv.lastMessageDate}` });
    }
  }

  // Idle deals, checked every 10 minutes.
  const idleAutomations = db.read().automations.filter((a) => a.enabled && a.trigger.type === "deal_idle");
  const checkIdle = idleAutomations.length && (!w.lastIdleCheck || Date.now() - Date.parse(w.lastIdleCheck) > 10 * 60_000);
  const idleFired: Record<string, string> = {};
  if (checkIdle) {
    for (const a of idleAutomations) {
      const days = Number(a.trigger.days) || 14;
      for (const o of opps) {
        if (o.status !== "open" || !o.contactId) continue;
        const since = o.lastStageChangeAt ?? o.updatedAt;
        const key = `${o.id}:${days}`;
        if (Date.now() - Date.parse(since) < days * DAY || w.idleFired[key] === since) continue;
        idleFired[key] = since;
        events.push({ type: "deal_idle", contactId: o.contactId, days, key: `idle:${o.id}:${days}:${since}` });
      }
    }
  }

  db.update((d) => {
    d.watch.contactIds = [...new Set([...contacts.map((x) => x.id), ...d.watch.contactIds])].slice(0, 5000);
    for (const ct of contacts) d.watch.tags[ct.id] = ct.tags;
    for (const o of opps) d.watch.stages[o.id] = o.stageId;
    for (const cv of convs) d.watch.conv[cv.id] = cv.lastMessageDate;
    Object.assign(d.watch.idleFired, idleFired);
    if (checkIdle) d.watch.lastIdleCheck = now;
    d.watch.lastPoll = now;
    // Forget de-duplication keys after 30 days.
    for (const [k, v] of Object.entries(d.dedupe)) if (Date.now() - Date.parse(v) > 30 * DAY) delete d.dedupe[k];
  });

  for (const e of events) await fire(e);
}

async function processDue() {
  const now = Date.now();
  const due = db
    .read()
    .runs.filter((r) => r.status === "active" && Date.parse(r.nextAt) <= now)
    .sort((a, b) => a.nextAt.localeCompare(b.nextAt))
    .slice(0, 40);
  for (const r of due) {
    try {
      await advance(r.id);
    } catch (err) {
      db.update((d) => {
        const run = d.runs.find((x) => x.id === r.id);
        if (run) end(run, "failed", err instanceof Error ? err.message : String(err));
      });
    }
  }
  // Keep the file small: finished runs beyond the latest 1,500 and log entries beyond 3,000.
  db.update((d) => {
    if (d.runs.length > 2000) {
      const active = d.runs.filter((x) => x.status === "active");
      const done = d.runs.filter((x) => x.status !== "active").sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? "")).slice(0, 1500);
      d.runs = [...active, ...done];
    }
    d.log = d.log.slice(0, 3000);
  });
}

function end(r: Run, status: Run["status"], reason: string) {
  r.status = status;
  r.reason = reason;
  r.endedAt = new Date().toISOString();
}

function logEntry(l: Omit<SendLog, "id" | "at">): SendLog {
  return { id: uid("lg"), at: new Date().toISOString(), ...l };
}

const durationMs = (s: Step) => (Number(s.amount) || 0) * (s.unit === "minutes" ? 60_000 : s.unit === "hours" ? HOUR : DAY);

async function advance(runId: string) {
  for (let guard = 0; guard < 25; guard++) {
    const d = db.read();
    const run = d.runs.find((x) => x.id === runId);
    if (!run || run.status !== "active") return;
    const a = d.automations.find((x) => x.id === run.automationId);
    if (!a || !a.enabled) {
      db.update((x) => end(x.runs.find((y) => y.id === runId)!, "exited", "Automation turned off"));
      return;
    }
    // Stop the sequence once the contact replies (anything newer than what started it).
    if (a.exitOnReply) {
      const lastIn = d.watch.lastInbound[run.contactId]?.["*"];
      const since = run.context.inboundAt ?? run.startedAt;
      if (lastIn && lastIn > since) {
        db.update((x) => end(x.runs.find((y) => y.id === runId)!, "exited", "Contact replied"));
        return;
      }
    }
    if (run.step >= a.steps.length) {
      db.update((x) => end(x.runs.find((y) => y.id === runId)!, "done", "Completed"));
      return;
    }
    const step = a.steps[run.step];
    if (step.type === "wait") {
      if (!run.waiting) {
        db.update((x) => {
          const r = x.runs.find((y) => y.id === runId)!;
          r.waiting = true;
          r.nextAt = new Date(Date.now() + durationMs(step)).toISOString();
        });
        return;
      }
      db.update((x) => {
        const r = x.runs.find((y) => y.id === runId)!;
        r.waiting = false;
        r.step++;
      });
      continue;
    }
    const outcome = step.type === "send" ? await sendStep(run, a, step) : await actionStep(run, a, step);
    if (outcome === "defer") return;
    if (outcome === "stop") return;
    db.update((x) => {
      x.runs.find((y) => y.id === runId)!.step++;
    });
  }
}

export function inQuietHours(s: EngineSettings, at = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: s.timezone || "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const t = hh * 60 + mm;
  const [sh, sm] = s.quietStart.split(":").map(Number);
  const [eh, em] = s.quietEnd.split(":").map(Number);
  const start = sh * 60 + sm;
  const endM = eh * 60 + em;
  // Sending window is start → end; anything outside is quiet.
  return start <= endM ? t < start || t >= endM : t < start && t >= endM;
}

export function nextWindowOpen(s: EngineSettings): Date {
  const t = new Date();
  for (let i = 0; i < 4 * 48; i++) {
    t.setTime(t.getTime() + 15 * 60_000);
    if (!inQuietHours(s, t)) return t;
  }
  return new Date(Date.now() + 8 * HOUR);
}

/** "dana" → "Dana" (CRMs often store names in lowercase); leaves "McKay" / "de Silva" alone. */
const cap = (s: string) => (s && s === s.toLowerCase() ? s.replace(/(^|[\s-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase()) : s);

export function render(template: string, c: Contact): string {
  const p = getSettings().profile;
  const vars: Record<string, string> = {
    first_name: cap(c.firstName || c.name.split(" ")[0] || "there"),
    last_name: cap(c.lastName),
    full_name: c.name,
    company: c.companyName,
    city: c.city,
    email: c.email,
    phone: c.phone,
    my_name: p.yourName || (p.agencyName ? `the ${p.agencyName} team` : "the team"),
    agency: p.agencyName || "our office",
    booking_link: p.bookingLink,
  };
  return template
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k.toLowerCase()] ?? "")
    .replace(/[ \t]+([,.!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function record(run: Run, a: Automation, entry: Omit<SendLog, "id" | "at" | "automationId" | "automationName" | "runId" | "contactId" | "contactName">, stat?: keyof Automation["stats"]) {
  db.update((d) => {
    d.log.unshift(logEntry({ automationId: a.id, automationName: a.name, runId: run.id, contactId: run.contactId, contactName: run.contactName, ...entry }));
    const au = d.automations.find((x) => x.id === a.id);
    if (au && stat) au.stats[stat]++;
  });
}

async function sendStep(run: Run, a: Automation, step: Step): Promise<"next" | "defer" | "stop"> {
  const s = db.read().settings;
  const c = crm();
  const contact = await c.getContact(run.contactId);
  if (!contact) {
    db.update((x) => end(x.runs.find((y) => y.id === run.id)!, "failed", "Contact no longer exists"));
    return "stop";
  }
  // Opted out / do-not-disturb: end the sequence.
  if (contact.dnd || contact.tags.some((t) => OPTED_OUT_TAGS.includes(t.toLowerCase()))) {
    record(run, a, { channel: String(step.channel), body: "", status: "skipped", reason: "Contact is opted out / DND", ai: false }, "skipped");
    db.update((x) => end(x.runs.find((y) => y.id === run.id)!, "exited", "Contact is opted out"));
    return "stop";
  }

  let channel: string = step.channel === "reply" ? (run.context.channel ?? "SMS") : (step.channel ?? "SMS");
  if (!(SEND_CHANNELS as string[]).includes(channel)) channel = contact.phone ? "SMS" : "Email";
  const isReply = step.channel === "reply" && run.context.inboundAt && Date.now() - Date.parse(run.context.inboundAt) < 30 * 60_000;

  const skip = (reason: string) => {
    record(run, a, { channel, body: "", status: "skipped", reason, ai: step.mode === "ai" }, "skipped");
    return "next" as const;
  };
  if ((channel === "SMS" || channel === "WhatsApp") && !contact.phone) return skip("No phone number on file");
  if ((channel === "SMS" || channel === "WhatsApp") && noTextConsent(contact))
    return skip("No permission to text yet: this is a cold prospect. Call or email them first, and tag them sms-ok once they agree to texts (or they text you first).");
  if (channel === "Email" && !contact.email) return skip("No email address on file");
  if (channel === "FB" || channel === "IG") {
    const last = db.read().watch.lastInbound[contact.id]?.[channel];
    if (!last || Date.now() - Date.parse(last) > DAY) return skip(`Outside Meta's 24-hour window — ${channel === "IG" ? "Instagram" : "Messenger"} only allows automated messages within 24 hours of the person's last message`);
  }

  // Quiet hours apply to messages we start; instant replies to someone who just messaged go out right away.
  if (!isReply && inQuietHours(s)) {
    const at = nextWindowOpen(s);
    db.update((x) => {
      x.runs.find((y) => y.id === run.id)!.nextAt = at.toISOString();
    });
    return "defer";
  }

  const log = db.read().log;
  const sentStatuses: LogStatus[] = ["sent", "demo"];
  const recentToContact = log.filter((l) => l.contactId === contact.id && sentStatuses.includes(l.status) && Date.now() - Date.parse(l.at) < DAY);
  if (recentToContact.length >= s.maxPerContactPerDay) {
    const oldest = recentToContact.map((l) => l.at).sort()[0];
    db.update((x) => {
      x.runs.find((y) => y.id === run.id)!.nextAt = new Date(Date.parse(oldest) + DAY + 60_000).toISOString();
    });
    return "defer";
  }
  if (log.filter((l) => sentStatuses.includes(l.status) && Date.now() - Date.parse(l.at) < DAY).length >= s.maxPerDay) {
    db.update((x) => {
      x.runs.find((y) => y.id === run.id)!.nextAt = new Date(Date.now() + HOUR).toISOString();
    });
    return "defer";
  }

  let body = "";
  let usedAi = false;
  if (step.mode === "ai") {
    const history = await c.listMessages(contact.id).catch(() => []);
    let gen: Awaited<ReturnType<typeof generateMessage>> = null;
    try {
      gen = await generateMessage({ agentSlug: step.agentSlug, contact, history, channel, instructions: step.instructions ?? "", purpose: step.channel === "reply" ? "reply" : "outreach" });
    } catch (err) {
      if (!step.text?.trim()) return skip(`AI couldn't write this message: ${err instanceof Error ? err.message : err}`);
    }
    if (gen?.handoff) {
      record(run, a, { channel, body: run.context.inboundText ?? "", status: "handoff", reason: "AI handed this conversation to you (opt-out, complaint, or a question it shouldn't answer)", ai: true }, "handoffs");
      await c.addTags(contact.id, ["needs-human"]).catch(() => undefined);
      await c.addTask(contact.id, { title: `Reply to ${contact.name} — Bloom AI handed off`, body: run.context.inboundText ?? "", dueDate: new Date().toISOString() }).catch(() => undefined);
      db.update((x) => end(x.runs.find((y) => y.id === run.id)!, "exited", "Handed off to a human"));
      return "stop";
    }
    if (gen?.text) {
      body = gen.text;
      usedAi = true;
    } else body = render(step.text ?? "", contact);
  } else {
    body = render(step.text ?? "", contact);
  }
  if (!body) return skip(step.mode === "ai" ? "Claude isn't connected and this step has no fallback text" : "Message is empty");
  const subject = channel === "Email" ? render(step.subject || "Following up", contact) : undefined;

  if (s.dryRun) {
    record(run, a, { channel, body, status: "dry_run", reason: "Test mode — not sent", ai: usedAi }, "sent");
    return "next";
  }
  try {
    const res = await c.sendMessage({ contactId: contact.id, channel: channel as SendChannel, body, subject });
    record(run, a, { channel, body, status: res.delivered ? "sent" : "demo", reason: res.delivered ? "" : "Demo workspace — recorded, not delivered", ai: usedAi }, "sent");
  } catch (err) {
    record(run, a, { channel, body, status: "failed", reason: err instanceof Error ? err.message : String(err), ai: usedAi }, "failed");
  }
  return "next";
}

async function actionStep(run: Run, a: Automation, step: Step): Promise<"next" | "stop"> {
  const s = db.read().settings;
  const c = crm();
  const contact = await c.getContact(run.contactId);
  if (!contact) return "stop";
  const label =
    step.type === "add_tag" ? `Add tag “${step.tag}”` : step.type === "remove_tag" ? `Remove tag “${step.tag}”` : step.type === "create_task" ? `Task: ${render(step.title ?? "", contact)}` : `Move deal to stage`;
  if (s.dryRun) {
    record(run, a, { channel: "—", body: label, status: "dry_run", reason: "Test mode — not applied", ai: false });
    return "next";
  }
  try {
    if (step.type === "add_tag" && step.tag) await c.addTags(contact.id, [step.tag]);
    else if (step.type === "remove_tag" && step.tag) await c.removeTags(contact.id, [step.tag]);
    else if (step.type === "create_task") await c.addTask(contact.id, { title: render(step.title || "Follow up with {{first_name}}", contact), dueDate: new Date(Date.now() + (Number(step.dueInDays) || 0) * DAY).toISOString(), assignedTo: contact.assignedTo || undefined });
    else if (step.type === "move_stage" && step.stageId) {
      const opps = await c.listOpportunities();
      const pipelines = await c.listPipelines();
      const pl = pipelines.find((p) => p.stages.some((x) => x.id === step.stageId));
      const opp = opps.filter((o) => o.contactId === contact.id && o.status === "open" && (!pl || o.pipelineId === pl.id)).sort((x, y) => y.value - x.value)[0];
      if (opp) await c.updateOpportunity(opp.id, { stageId: step.stageId });
    }
    record(run, a, { channel: "—", body: label, status: "action", reason: "", ai: false });
  } catch (err) {
    record(run, a, { channel: "—", body: label, status: "failed", reason: err instanceof Error ? err.message : String(err), ai: false }, "failed");
  }
  return "next";
}

/** Renders (and for AI steps, writes) every message for one contact without sending anything. */
export async function preview(automation: Automation, contactId: string) {
  const c = crm();
  const contact = await c.getContact(contactId);
  if (!contact) throw new Error("Contact not found");
  const history = await c.listMessages(contactId).catch(() => []);
  const out: { stepIndex: number; channel: string; subject?: string; body: string; ai: boolean; note?: string }[] = [];
  for (const [i, step] of automation.steps.entries()) {
    if (step.type !== "send") continue;
    const channel = step.channel === "reply" ? (history.find((m) => m.direction === "inbound")?.channel ?? "SMS") : (step.channel ?? "SMS");
    if (step.mode === "ai") {
      try {
        const gen = await generateMessage({ agentSlug: step.agentSlug, contact, history, channel, instructions: step.instructions ?? "", purpose: step.channel === "reply" ? "reply" : "outreach" });
        if (gen === null) out.push({ stepIndex: i, channel, body: render(step.text ?? "", contact), ai: false, note: "Claude isn't connected — this is the fallback text." });
        else if (gen.handoff) out.push({ stepIndex: i, channel, body: "", ai: true, note: "AI would hand this conversation to you instead of replying." });
        else out.push({ stepIndex: i, channel, body: gen.text, ai: true });
      } catch (err) {
        out.push({ stepIndex: i, channel, body: render(step.text ?? "", contact), ai: false, note: `AI error: ${err instanceof Error ? err.message : err}` });
      }
    } else out.push({ stepIndex: i, channel, subject: channel === "Email" ? render(step.subject || "Following up", contact) : undefined, body: render(step.text ?? "", contact), ai: false });
  }
  return out;
}

/** GoHighLevel workflow webhook → engine events. */
export async function handleWebhook(secret: string, payload: Record<string, unknown>): Promise<{ ok: boolean; fired: number }> {
  if (!secret || secret !== db.read().settings.webhookSecret) throw Object.assign(new Error("Invalid webhook secret"), { status: 403 });
  const s = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
  const o = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const contactId = s(payload.contact_id) || s(payload.contactId) || s(o(payload.contact).id) || s(payload.id);
  if (!contactId) return { ok: false, fired: 0 };
  const message = o(payload.message);
  const body = s(message.body) || s(payload.body) || s(payload.messageBody);
  const type = s(message.type) || s(payload.messageType) || s(payload.type);
  if (body) {
    const channel = normalizeChannel(type || "SMS");
    const at = new Date().toISOString();
    return { ok: true, fired: await fire({ type: "inbound_message", contactId, channel, body, at, key: `wh:in:${contactId}:${body.slice(0, 40)}:${at.slice(0, 16)}` }) };
  }
  return { ok: true, fired: await fire({ type: "new_contact", contactId, key: `new:${contactId}` }) };
}

/** Latest inbound message time per channel for a contact ("*" = any channel). */
export function lastInboundFor(contactId: string): Record<string, string> {
  return db.read().watch.lastInbound[contactId] ?? {};
}

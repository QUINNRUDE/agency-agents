// Broadcasts: one text or email to a chosen group of contacts who have agreed to hear
// from you. Cold prospects, opted-out and DND contacts are always left out; texts get an
// opt-out line; sending is throttled and respects the automation sending window.
import { automationState, inQuietHours, noTextConsent, OPTED_OUT_TAGS, render } from "./automations.ts";
import { crm } from "./crm/index.ts";
import type { Contact, Opportunity, Pipeline } from "./crm/types.ts";
import { JsonFile, localDb, uid } from "./store.ts";

export type Audience =
  | { kind: "all" }
  | { kind: "tag"; tag: string }
  | { kind: "stage"; stageId: string }
  | { kind: "customers" }
  | { kind: "view"; viewId: string }
  | { kind: "contacts"; contactIds: string[] };

export type RecipientStatus = "pending" | "sent" | "demo" | "test_mode" | "skipped" | "failed";

export interface Recipient {
  contactId: string;
  name: string;
  status: RecipientStatus;
  reason?: string;
  at?: string;
}

export interface Broadcast {
  id: string;
  name: string;
  channel: "SMS" | "Email";
  message: string;
  subject: string;
  audience: Audience;
  audienceLabel: string;
  optOutLine: boolean;
  perMinute: number;
  status: "scheduled" | "sending" | "paused" | "done" | "cancelled";
  scheduledAt: string;
  createdAt: string;
  finishedAt?: string;
  excluded: Record<string, number>;
  recipients: Recipient[];
}

const file = new JsonFile<{ broadcasts: Broadcast[] }>("broadcasts.json", () => ({ broadcasts: [] }));
const OPT_OUT_LINE = "Reply STOP to opt out.";

function lower(tags: string[]) {
  return tags.map((t) => t.toLowerCase());
}

/** Why a contact can't receive this broadcast, or null if they can. */
export function exclusion(c: Contact, channel: "SMS" | "Email"): string | null {
  const tags = lower(c.tags);
  if (c.dnd || tags.some((t) => OPTED_OUT_TAGS.includes(t))) return "Opted out / DND";
  if (channel === "SMS" && !c.phone) return "No phone number";
  if (channel === "Email" && !c.email) return "No email address";
  if (channel === "SMS" && noTextConsent(c)) return "No permission to text";
  return null;
}

interface SavedFilters {
  q?: string;
  stage?: string;
  source?: string;
  tag?: string;
  owner?: string;
  idle?: string;
  added?: string;
  deal?: string;
}

const DAY = 86_400_000;

function applyView(contacts: Contact[], f: SavedFilters, opps: Opportunity[], pipelines: Pipeline[]): Contact[] {
  const stageName = new Map(pipelines.flatMap((p) => p.stages.map((s) => [s.id, s.name] as const)));
  const byContact = new Map<string, Opportunity[]>();
  for (const o of opps) byContact.set(o.contactId, [...(byContact.get(o.contactId) ?? []), o]);
  const term = (f.q ?? "").toLowerCase().trim();
  const now = Date.now();
  return contacts.filter((c) => {
    if (term && ![c.name, c.companyName, c.email, c.phone, c.city, ...c.tags].join(" ").toLowerCase().includes(term)) return false;
    if (f.tag && !c.tags.includes(f.tag)) return false;
    if (f.source && c.source !== f.source) return false;
    if (f.owner && f.owner !== "*" && c.assignedTo !== f.owner) return false;
    if (f.owner === "" && c.assignedTo) return false;
    if (f.added && now - Date.parse(c.dateAdded) > Number(f.added) * DAY) return false;
    if (f.idle && c.lastActivity && now - Date.parse(c.lastActivity) < Number(f.idle) * DAY) return false;
    const deals = byContact.get(c.id) ?? [];
    if (f.deal === "open" && !deals.some((o) => o.status === "open")) return false;
    if (f.deal === "won" && !deals.some((o) => o.status === "won")) return false;
    if (f.deal === "none" && deals.length) return false;
    if (f.stage && !deals.some((o) => o.status === "open" && stageName.get(o.stageId) === f.stage)) return false;
    return true;
  });
}

/** Contacts in the audience, split into who will get it and who is left out (with reasons). */
export async function resolveAudience(audience: Audience, channel: "SMS" | "Email") {
  const c = crm();
  const [contacts, opps, pipelines] = await Promise.all([c.listContacts({ limit: 2000 }), c.listOpportunities(), c.listPipelines()]);
  let picked: Contact[];
  let label: string;
  switch (audience.kind) {
    case "tag":
      picked = contacts.filter((x) => lower(x.tags).includes(audience.tag.toLowerCase()));
      label = `Tag “${audience.tag}”`;
      break;
    case "stage": {
      const ids = new Set(opps.filter((o) => o.stageId === audience.stageId && o.status === "open").map((o) => o.contactId));
      picked = contacts.filter((x) => ids.has(x.id));
      const st = pipelines.flatMap((p) => p.stages.map((s) => ({ ...s, pipeline: p.name }))).find((s) => s.id === audience.stageId);
      label = st ? `${st.pipeline} → ${st.name}` : "Pipeline stage";
      break;
    }
    case "customers": {
      const ids = new Set(opps.filter((o) => o.status === "won").map((o) => o.contactId));
      picked = contacts.filter((x) => ids.has(x.id));
      label = "Customers (won a deal)";
      break;
    }
    case "view": {
      const v = localDb.read().views.find((x) => x.id === audience.viewId);
      picked = v ? applyView(contacts, v.filters as SavedFilters, opps, pipelines) : [];
      label = v ? `Saved view “${v.name}”` : "Saved view";
      break;
    }
    case "contacts": {
      const ids = new Set(audience.contactIds);
      picked = contacts.filter((x) => ids.has(x.id));
      label = `${ids.size} selected contact${ids.size === 1 ? "" : "s"}`;
      break;
    }
    default:
      picked = contacts;
      label = "Everyone";
  }
  const eligible: Contact[] = [];
  const excluded: Record<string, number> = {};
  for (const x of picked) {
    const why = exclusion(x, channel);
    if (why) excluded[why] = (excluded[why] ?? 0) + 1;
    else eligible.push(x);
  }
  return { label, eligible, excluded, total: picked.length };
}

export function finalText(b: Pick<Broadcast, "channel" | "message" | "optOutLine">, c: Contact): string {
  let text = render(b.message, c);
  if (b.channel === "SMS" && b.optOutLine && !/\bstop\b/i.test(text)) text = `${text}\n${OPT_OUT_LINE}`;
  return text;
}

export function listBroadcasts() {
  return file
    .read()
    .broadcasts.map(({ recipients, ...b }) => ({
      ...b,
      counts: {
        total: recipients.length,
        sent: recipients.filter((r) => r.status === "sent" || r.status === "demo" || r.status === "test_mode").length,
        skipped: recipients.filter((r) => r.status === "skipped").length,
        failed: recipients.filter((r) => r.status === "failed").length,
        pending: recipients.filter((r) => r.status === "pending").length,
      },
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getBroadcast(id: string) {
  return file.read().broadcasts.find((b) => b.id === id) ?? null;
}

export async function createBroadcast(input: { name?: string; channel: "SMS" | "Email"; message: string; subject?: string; audience: Audience; scheduledAt?: string; optOutLine?: boolean; perMinute?: number }) {
  if (!input.message?.trim()) throw new Error("Write a message first.");
  const channel = input.channel === "Email" ? "Email" : "SMS";
  const { label, eligible, excluded } = await resolveAudience(input.audience, channel);
  if (!eligible.length) throw new Error("Nobody in this audience can receive it. Check the people left out.");
  const b: Broadcast = {
    id: uid("bc"),
    name: input.name?.trim() || `${channel} broadcast — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
    channel,
    message: input.message.trim(),
    subject: input.subject?.trim() ?? "",
    audience: input.audience,
    audienceLabel: label,
    optOutLine: input.optOutLine !== false,
    perMinute: Math.max(1, Math.min(120, Number(input.perMinute) || 30)),
    status: "scheduled",
    scheduledAt: input.scheduledAt && Date.parse(input.scheduledAt) > Date.now() ? new Date(input.scheduledAt).toISOString() : new Date().toISOString(),
    createdAt: new Date().toISOString(),
    excluded,
    recipients: eligible.map((c) => ({ contactId: c.id, name: c.name, status: "pending" })),
  };
  file.update((d) => d.broadcasts.push(b));
  void tickBroadcasts();
  return b;
}

export function setStatus(id: string, action: "pause" | "resume" | "cancel") {
  let out: Broadcast | undefined;
  file.update((d) => {
    const b = d.broadcasts.find((x) => x.id === id);
    if (!b || b.status === "done" || b.status === "cancelled") return;
    if (action === "pause") b.status = "paused";
    if (action === "resume") b.status = Date.parse(b.scheduledAt) > Date.now() ? "scheduled" : "sending";
    if (action === "cancel") {
      b.status = "cancelled";
      b.finishedAt = new Date().toISOString();
      for (const r of b.recipients) if (r.status === "pending") (r.status = "skipped"), (r.reason = "Broadcast cancelled");
    }
    out = b;
  });
  if (action === "resume") void tickBroadcasts();
  return out ?? null;
}

let running: Promise<void> | null = null;
const lastBatch = new Map<string, number>();

/** Sends the next slice of every due broadcast. Called every few seconds. */
export function tickBroadcasts(): Promise<void> {
  running ??= sendDue().finally(() => {
    running = null;
  });
  return running;
}

async function sendDue() {
  const settings = automationState().settings;
  const due = file.read().broadcasts.filter((b) => (b.status === "scheduled" || b.status === "sending") && Date.parse(b.scheduledAt) <= Date.now());
  for (const b of due) {
    if (!settings.enabled || inQuietHours(settings)) continue; // master switch off or outside the sending window: wait
    // Throttle: perMinute messages per minute, sent in slices.
    const since = Date.now() - (lastBatch.get(b.id) ?? 0);
    const allowance = Math.max(1, Math.floor((b.perMinute * Math.min(since, 60_000)) / 60_000));
    lastBatch.set(b.id, Date.now());
    const pending = b.recipients.filter((r) => r.status === "pending").slice(0, allowance);
    file.update((d) => {
      const x = d.broadcasts.find((y) => y.id === b.id);
      if (x && x.status === "scheduled") x.status = "sending";
    });
    for (const r of pending) {
      const current = getBroadcast(b.id);
      if (!current || current.status !== "sending") break; // paused or cancelled mid-batch
      const result = await sendOne(current, r.contactId, settings.dryRun);
      file.update((d) => {
        const x = d.broadcasts.find((y) => y.id === b.id);
        const rr = x?.recipients.find((y) => y.contactId === r.contactId);
        if (rr) Object.assign(rr, result, { at: new Date().toISOString() });
      });
    }
    file.update((d) => {
      const x = d.broadcasts.find((y) => y.id === b.id);
      if (x && x.status === "sending" && !x.recipients.some((y) => y.status === "pending")) {
        x.status = "done";
        x.finishedAt = new Date().toISOString();
      }
    });
  }
}

async function sendOne(b: Broadcast, contactId: string, dryRun: boolean): Promise<Pick<Recipient, "status" | "reason">> {
  const c = crm();
  const contact = await c.getContact(contactId).catch(() => null);
  if (!contact) return { status: "skipped", reason: "Contact no longer exists" };
  // Re-check at send time: people can opt out after the broadcast was created.
  const why = exclusion(contact, b.channel);
  if (why) return { status: "skipped", reason: why };
  const body = finalText(b, contact);
  if (dryRun) return { status: "test_mode", reason: "Test mode is on — not sent" };
  try {
    const res = await c.sendMessage({ contactId, channel: b.channel, body, subject: b.channel === "Email" ? render(b.subject || "A quick update", contact) : undefined });
    return res.delivered ? { status: "sent" } : { status: "demo", reason: "Demo workspace — recorded, not delivered" };
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Sends the broadcast to one contact (usually yourself) without creating a broadcast. */
export async function sendTest(input: { channel: "SMS" | "Email"; message: string; subject?: string; optOutLine?: boolean; contactId: string }) {
  const contact = await crm().getContact(input.contactId);
  if (!contact) throw new Error("Contact not found");
  const channel = input.channel === "Email" ? "Email" : "SMS";
  const body = finalText({ channel, message: input.message, optOutLine: input.optOutLine !== false }, contact);
  const res = await crm().sendMessage({ contactId: contact.id, channel, body, subject: channel === "Email" ? render(input.subject || "A quick update", contact) : undefined });
  return { delivered: res.delivered, body };
}

setInterval(() => void tickBroadcasts(), 5_000).unref();

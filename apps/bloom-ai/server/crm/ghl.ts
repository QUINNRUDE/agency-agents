// GoHighLevel (LeadConnector) API v2 adapter.
// Docs: https://highlevel.stoplight.io/docs/integrations
// Auth: a Private Integration Token (sub-account level) sent as a Bearer token,
// plus the required `Version` header.
import {
  CrmError,
  type Appointment,
  type Contact,
  type ContactInput,
  type ContactQuery,
  type Crm,
  type CrmInfo,
  type Conversation,
  type CustomField,
  normalizeChannel,
  type User,
  type Message,
  type Note,
  type Opportunity,
  type OpportunityInput,
  type OpportunityStatus,
  type Pipeline,
  type SendMessageInput,
  type Task,
  type TaskInput,
} from "./types.ts";

const BASE = process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

type Json = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function obj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}
function iso(v: unknown): string {
  if (typeof v === "number") return new Date(v).toISOString();
  const s = str(v);
  if (!s) return "";
  const d = new Date(/^\d+$/.test(s) ? Number(s) : s);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function toContact(raw: unknown): Contact {
  const c = obj(raw);
  const firstName = str(c.firstName);
  const lastName = str(c.lastName);
  const name =
    str(c.contactName) || str(c.name) || [firstName, lastName].filter(Boolean).join(" ") || str(c.companyName) || str(c.email) || str(c.phone) || "Unnamed";
  return {
    id: str(c.id),
    firstName,
    lastName,
    name: name.replace(/\b\w/g, (m) => m.toUpperCase()),
    email: str(c.email),
    phone: str(c.phone),
    companyName: str(c.companyName),
    website: str(c.website),
    city: str(c.city),
    state: str(c.state),
    source: str(c.source),
    tags: arr(c.tags).map(str).filter(Boolean),
    dateAdded: iso(c.dateAdded),
    lastActivity: iso(c.lastActivity) || iso(c.dateUpdated) || null,
    dnd: Boolean(c.dnd),
    assignedTo: str(c.assignedTo),
    customFields: arr(c.customFields ?? c.customField)
      .map((f) => {
        const fo = obj(f);
        const v = fo.value ?? fo.field_value ?? fo.fieldValue;
        return { id: str(fo.id), value: Array.isArray(v) ? v.map(str).join(", ") : str(v) };
      })
      .filter((f) => f.id),
  };
}

function toTask(raw: unknown, contactId?: string): Task {
  const t = obj(raw);
  const cd = obj(t.contactDetails);
  return {
    id: str(t.id) || str(t._id),
    contactId: contactId || str(t.contactId),
    title: str(t.title),
    body: str(t.body),
    dueDate: iso(t.dueDate),
    completed: Boolean(t.completed),
    assignedTo: str(t.assignedTo),
    contactName: [str(cd.firstName), str(cd.lastName)].filter(Boolean).join(" ").replace(/\b\w/g, (m) => m.toUpperCase()),
  };
}

function toStatus(v: unknown): OpportunityStatus {
  const s = str(v);
  return s === "won" || s === "lost" || s === "abandoned" ? s : "open";
}

function toOpportunity(raw: unknown): Opportunity {
  const o = obj(raw);
  const contact = obj(o.contact);
  return {
    id: str(o.id),
    name: str(o.name),
    pipelineId: str(o.pipelineId),
    stageId: str(o.pipelineStageId),
    status: toStatus(o.status),
    value: Number(o.monetaryValue ?? 0) || 0,
    contactId: str(o.contactId) || str(contact.id),
    contactName: str(contact.name),
    companyName: str(contact.companyName),
    createdAt: iso(o.createdAt),
    updatedAt: iso(o.updatedAt),
    lastStageChangeAt: iso(o.lastStageChangeAt) || null,
  };
}

export class GhlCrm implements Crm {
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    private token: string,
    private locationId: string,
  ) {}

  private async request<T = Json>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Version: API_VERSION,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    // GHL enforces burst limits (100 requests / 10s). Back off and retry.
    if (res.status === 429 && attempt < 3) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || 1500 * (attempt + 1);
      await new Promise((r) => setTimeout(r, wait));
      return this.request<T>(method, path, body, attempt + 1);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const d = obj(data);
      const msg = str(d.message) || (Array.isArray(d.message) ? d.message.join(", ") : "") || res.statusText;
      const hint =
        res.status === 401
          ? "GoHighLevel rejected the token. Check the Private Integration token and that it belongs to this sub-account."
          : res.status === 403
            ? "The token is missing a scope for this action. Edit the Private Integration and enable the scope."
            : `GoHighLevel error ${res.status}: ${msg}`;
      throw new CrmError(hint, res.status === 401 || res.status === 403 ? res.status : 502, data);
    }
    return data as T;
  }

  private async cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
    const value = await load();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  private bust(prefix: string) {
    for (const k of this.cache.keys()) if (k.startsWith(prefix)) this.cache.delete(k);
  }

  async info(): Promise<CrmInfo> {
    const data = await this.cached("location", 300_000, () =>
      this.request<Json>("GET", `/locations/${encodeURIComponent(this.locationId)}`),
    );
    const loc = obj(data.location);
    return { mode: "ghl", accountName: str(loc.name) || "GoHighLevel sub-account" };
  }

  async listContacts(q: ContactQuery): Promise<Contact[]> {
    const limit = Math.min(q.limit ?? 500, 2000);
    const key = `contacts:${q.query ?? ""}:${limit}`;
    return this.cached(key, 30_000, async () => {
      const out: Contact[] = [];
      let page = 1;
      const pageLimit = 100;
      while (out.length < limit) {
        let batch: unknown[];
        try {
          const data = await this.request<Json>("POST", "/contacts/search", {
            locationId: this.locationId,
            page,
            pageLimit,
            ...(q.query ? { query: q.query } : {}),
            sort: [{ field: "dateAdded", direction: "desc" }],
          });
          batch = arr(data.contacts);
        } catch (err) {
          // Older tokens/scopes sometimes lack the search endpoint; fall back to the list endpoint.
          if (page !== 1 || !(err instanceof CrmError) || err.status === 401) throw err;
          const params = new URLSearchParams({ locationId: this.locationId, limit: String(pageLimit) });
          if (q.query) params.set("query", q.query);
          const data = await this.request<Json>("GET", `/contacts/?${params}`);
          return arr(data.contacts).map(toContact);
        }
        out.push(...batch.map(toContact));
        if (batch.length < pageLimit) break;
        page += 1;
      }
      return out.slice(0, limit);
    });
  }

  async getContact(id: string): Promise<Contact | null> {
    try {
      const data = await this.request<Json>("GET", `/contacts/${encodeURIComponent(id)}`);
      return toContact(data.contact);
    } catch (err) {
      if (err instanceof CrmError && (err.status === 404 || err.status === 502)) return null;
      throw err;
    }
  }

  async createContact(input: ContactInput): Promise<Contact> {
    const data = await this.request<Json>("POST", "/contacts/", { locationId: this.locationId, ...clean(input) });
    this.bust("contacts:");
    return toContact(data.contact);
  }

  async updateContact(id: string, input: ContactInput): Promise<Contact> {
    const data = await this.request<Json>("PUT", `/contacts/${encodeURIComponent(id)}`, clean(input, true));
    this.bust("contacts:");
    return toContact(data.contact);
  }

  async addTags(id: string, tags: string[]): Promise<void> {
    await this.request("POST", `/contacts/${encodeURIComponent(id)}/tags`, { tags });
    this.bust("contacts:");
  }

  async removeTags(id: string, tags: string[]): Promise<void> {
    await this.request("DELETE", `/contacts/${encodeURIComponent(id)}/tags`, { tags });
    this.bust("contacts:");
  }

  async deleteContact(id: string): Promise<void> {
    await this.request("DELETE", `/contacts/${encodeURIComponent(id)}`);
    this.bust("contacts:");
    this.bust("opps:");
    this.bust("tasks:");
  }

  async listUsers(): Promise<User[]> {
    return this.cached("users", 300_000, async () => {
      try {
        const data = await this.request<Json>("GET", `/users/?locationId=${encodeURIComponent(this.locationId)}`);
        return arr(data.users).map((u) => {
          const uo = obj(u);
          return { id: str(uo.id), name: str(uo.name) || [str(uo.firstName), str(uo.lastName)].filter(Boolean).join(" ") || str(uo.email), email: str(uo.email) };
        });
      } catch (err) {
        // users.readonly is optional: without it, ownership just isn't shown.
        if (err instanceof CrmError && err.status === 403) return [];
        throw err;
      }
    });
  }

  async listCustomFields(): Promise<CustomField[]> {
    return this.cached("customFields", 300_000, async () => {
      try {
        const data = await this.request<Json>("GET", `/locations/${encodeURIComponent(this.locationId)}/customFields?model=contact`);
        return arr(data.customFields)
          .map((f) => {
            const fo = obj(f);
            return {
              id: str(fo.id),
              name: str(fo.name),
              dataType: str(fo.dataType) || "TEXT",
              options: arr(fo.picklistOptions ?? fo.options).map((o) => (typeof o === "string" ? o : str(obj(o).label) || str(obj(o).value))).filter(Boolean),
              model: str(fo.model),
            };
          })
          .filter((f) => f.id && (!f.model || f.model === "contact"))
          .map(({ model: _m, ...f }) => f);
      } catch (err) {
        if (err instanceof CrmError && err.status === 403) return [];
        throw err;
      }
    });
  }

  async listPipelines(): Promise<Pipeline[]> {
    return this.cached("pipelines", 120_000, async () => {
      const data = await this.request<Json>("GET", `/opportunities/pipelines?locationId=${encodeURIComponent(this.locationId)}`);
      return arr(data.pipelines).map((p) => {
        const po = obj(p);
        return {
          id: str(po.id),
          name: str(po.name),
          stages: arr(po.stages)
            .map((s, i) => {
              const so = obj(s);
              return { id: str(so.id), name: str(so.name), position: Number(so.position ?? i) };
            })
            .sort((a, b) => a.position - b.position),
        };
      });
    });
  }

  async listOpportunities(pipelineId?: string): Promise<Opportunity[]> {
    return this.cached(`opps:${pipelineId ?? "all"}`, 30_000, async () => {
      const out: Opportunity[] = [];
      for (let page = 1; page <= 20; page++) {
        const params = new URLSearchParams({ location_id: this.locationId, limit: "100", page: String(page) });
        if (pipelineId) params.set("pipeline_id", pipelineId);
        const data = await this.request<Json>("GET", `/opportunities/search?${params}`);
        const batch = arr(data.opportunities);
        out.push(...batch.map(toOpportunity));
        if (batch.length < 100) break;
      }
      return out;
    });
  }

  async createOpportunity(input: OpportunityInput): Promise<Opportunity> {
    const data = await this.request<Json>("POST", "/opportunities/", {
      locationId: this.locationId,
      pipelineId: input.pipelineId,
      pipelineStageId: input.stageId,
      contactId: input.contactId,
      name: input.name,
      status: input.status ?? "open",
      monetaryValue: input.value ?? 0,
    });
    this.bust("opps:");
    return toOpportunity(data.opportunity);
  }

  async updateOpportunity(id: string, input: OpportunityInput): Promise<Opportunity> {
    const body: Json = {};
    if (input.stageId) body.pipelineStageId = input.stageId;
    if (input.pipelineId) body.pipelineId = input.pipelineId;
    if (input.name) body.name = input.name;
    if (input.value !== undefined) body.monetaryValue = input.value;
    if (input.status) body.status = input.status;
    const data = await this.request<Json>("PUT", `/opportunities/${encodeURIComponent(id)}`, body);
    this.bust("opps:");
    return toOpportunity(data.opportunity);
  }

  async deleteOpportunity(id: string): Promise<void> {
    await this.request("DELETE", `/opportunities/${encodeURIComponent(id)}`);
    this.bust("opps:");
  }

  async listNotes(contactId: string): Promise<Note[]> {
    const data = await this.request<Json>("GET", `/contacts/${encodeURIComponent(contactId)}/notes`);
    return arr(data.notes)
      .map((n) => {
        const no = obj(n);
        return { id: str(no.id), contactId, body: str(no.body), dateAdded: iso(no.dateAdded) };
      })
      .sort((a, b) => b.dateAdded.localeCompare(a.dateAdded));
  }

  async addNote(contactId: string, body: string): Promise<Note> {
    const data = await this.request<Json>("POST", `/contacts/${encodeURIComponent(contactId)}/notes`, { body });
    const n = obj(data.note);
    return { id: str(n.id), contactId, body: str(n.body) || body, dateAdded: iso(n.dateAdded) || new Date().toISOString() };
  }

  async updateNote(contactId: string, noteId: string, body: string): Promise<Note> {
    const data = await this.request<Json>("PUT", `/contacts/${encodeURIComponent(contactId)}/notes/${encodeURIComponent(noteId)}`, { body });
    const n = obj(data.note);
    return { id: noteId, contactId, body: str(n.body) || body, dateAdded: iso(n.dateAdded) || new Date().toISOString() };
  }

  async deleteNote(contactId: string, noteId: string): Promise<void> {
    await this.request("DELETE", `/contacts/${encodeURIComponent(contactId)}/notes/${encodeURIComponent(noteId)}`);
  }

  async listTasks(contactId: string): Promise<Task[]> {
    const data = await this.request<Json>("GET", `/contacts/${encodeURIComponent(contactId)}/tasks`);
    return arr(data.tasks).map((t) => toTask(t, contactId));
  }

  async addTask(contactId: string, input: TaskInput): Promise<Task> {
    const data = await this.request<Json>("POST", `/contacts/${encodeURIComponent(contactId)}/tasks`, {
      title: input.title,
      body: input.body ?? "",
      dueDate: new Date(input.dueDate).toISOString(),
      completed: false,
      ...(input.assignedTo ? { assignedTo: input.assignedTo } : {}),
    });
    this.bust("tasks:");
    const t = toTask(data.task, contactId);
    return { ...t, title: t.title || input.title, dueDate: t.dueDate || input.dueDate, assignedTo: t.assignedTo || input.assignedTo || "" };
  }

  async completeTask(contactId: string, taskId: string, completed: boolean): Promise<void> {
    await this.request("PUT", `/contacts/${encodeURIComponent(contactId)}/tasks/${encodeURIComponent(taskId)}/completed`, { completed });
    this.bust("tasks:");
  }

  async updateTask(contactId: string, taskId: string, input: Partial<TaskInput>): Promise<Task> {
    const body: Json = {};
    if (input.title !== undefined) body.title = input.title;
    if (input.body !== undefined) body.body = input.body;
    if (input.dueDate) body.dueDate = new Date(input.dueDate).toISOString();
    if (input.assignedTo !== undefined) body.assignedTo = input.assignedTo || undefined;
    if (input.completed !== undefined) body.completed = input.completed;
    const data = await this.request<Json>("PUT", `/contacts/${encodeURIComponent(contactId)}/tasks/${encodeURIComponent(taskId)}`, body);
    this.bust("tasks:");
    return toTask(data.task, contactId);
  }

  async deleteTask(contactId: string, taskId: string): Promise<void> {
    await this.request("DELETE", `/contacts/${encodeURIComponent(contactId)}/tasks/${encodeURIComponent(taskId)}`);
    this.bust("tasks:");
  }

  async listAllTasks(opts: { completed?: boolean; limit?: number }): Promise<Task[]> {
    const limit = Math.min(opts.limit ?? 500, 1000);
    return this.cached(`tasks:${opts.completed ?? "any"}:${limit}`, 30_000, async () => {
      let tasks: Task[];
      try {
        // Location-wide task search.
        tasks = [];
        for (let skip = 0; skip < limit; skip += 100) {
          const data = await this.request<Json>("POST", `/locations/${encodeURIComponent(this.locationId)}/tasks/search`, {
            ...(opts.completed !== undefined ? { completed: opts.completed } : {}),
            limit: 100,
            skip,
          });
          const batch = arr(data.tasks).map((t) => toTask(t));
          tasks.push(...batch);
          if (batch.length < 100) break;
        }
      } catch (err) {
        if (err instanceof CrmError && err.status === 401) throw err;
        // Fallback for tokens without location task search: scan recently active contacts.
        const contacts = (await this.listContacts({ limit: 200 })).slice(0, 150);
        tasks = [];
        for (let i = 0; i < contacts.length; i += 5) {
          const chunk = contacts.slice(i, i + 5);
          const lists = await Promise.all(chunk.map((c) => this.listTasks(c.id).catch(() => [] as Task[])));
          lists.forEach((l, j) => tasks.push(...l.map((t) => ({ ...t, contactName: chunk[j].name }))));
        }
        if (opts.completed !== undefined) tasks = tasks.filter((t) => t.completed === opts.completed);
      }
      // Fill in contact names the search didn't include.
      if (tasks.some((t) => !t.contactName)) {
        const byId = new Map((await this.listContacts({ limit: 2000 })).map((c) => [c.id, c.name]));
        tasks = tasks.map((t) => ({ ...t, contactName: t.contactName || byId.get(t.contactId) || "" }));
      }
      return tasks.slice(0, limit);
    });
  }

  async listAppointments(fromIso: string, toIso: string): Promise<Appointment[]> {
    return this.cached(`appts:${fromIso.slice(0, 13)}:${toIso.slice(0, 13)}`, 60_000, async () => {
      const cals = await this.cached("calendars", 300_000, async () => {
        const data = await this.request<Json>("GET", `/calendars/?locationId=${encodeURIComponent(this.locationId)}`);
        return arr(data.calendars).map((c) => ({ id: str(obj(c).id), name: str(obj(c).name) }));
      });
      const start = String(new Date(fromIso).getTime());
      const end = String(new Date(toIso).getTime());
      const results = await Promise.all(
        cals.slice(0, 15).map(async (cal) => {
          const params = new URLSearchParams({ locationId: this.locationId, calendarId: cal.id, startTime: start, endTime: end });
          try {
            const data = await this.request<Json>("GET", `/calendars/events?${params}`);
            return arr(data.events).map((e) => {
              const eo = obj(e);
              return {
                id: str(eo.id),
                title: str(eo.title) || "Appointment",
                contactId: str(eo.contactId) || null,
                calendarName: cal.name,
                startTime: iso(eo.startTime),
                endTime: iso(eo.endTime),
                status: str(eo.appointmentStatus) || "confirmed",
              } satisfies Appointment;
            });
          } catch {
            return [];
          }
        }),
      );
      return results.flat().sort((a, b) => a.startTime.localeCompare(b.startTime));
    });
  }

  async listMessages(contactId: string): Promise<Message[]> {
    const params = new URLSearchParams({ locationId: this.locationId, contactId });
    const convs = await this.request<Json>("GET", `/conversations/search?${params}`);
    const ids = arr(convs.conversations).map((c) => str(obj(c).id)).filter(Boolean).slice(0, 3);
    const lists = await Promise.all(
      ids.map(async (cid) => {
        const data = await this.request<Json>("GET", `/conversations/${encodeURIComponent(cid)}/messages?limit=50`);
        const inner = obj(data.messages);
        return arr(inner.messages ?? data.messages).map((m) => {
          const mo = obj(m);
          return {
            id: str(mo.id),
            contactId,
            direction: str(mo.direction) === "inbound" ? "inbound" : "outbound",
            channel: normalizeChannel(str(mo.messageType) || str(mo.type)),
            body: str(mo.body),
            dateAdded: iso(mo.dateAdded),
          } satisfies Message;
        });
      }),
    );
    return lists.flat().sort((a, b) => b.dateAdded.localeCompare(a.dateAdded));
  }

  async listConversations(limit: number): Promise<Conversation[]> {
    const params = new URLSearchParams({ locationId: this.locationId, limit: String(Math.min(limit, 100)), sort: "desc", sortBy: "last_message_date" });
    const data = await this.request<Json>("GET", `/conversations/search?${params}`);
    return arr(data.conversations).map((c) => {
      const co = obj(c);
      return {
        id: str(co.id),
        contactId: str(co.contactId),
        contactName: (str(co.fullName) || str(co.contactName) || str(co.email) || str(co.phone) || "Unknown").replace(/\b\w/g, (m) => m.toUpperCase()),
        lastMessageBody: str(co.lastMessageBody),
        lastMessageDate: iso(co.lastMessageDate),
        lastMessageDirection: str(co.lastMessageDirection) === "inbound" ? "inbound" : "outbound",
        channel: normalizeChannel(str(co.lastMessageType) || str(co.type)),
        unread: Number(co.unreadCount ?? 0) || 0,
      } satisfies Conversation;
    });
  }

  async sendMessage(input: SendMessageInput): Promise<{ id: string; delivered: boolean }> {
    const body: Json = { type: input.channel, contactId: input.contactId, message: input.body };
    if (input.channel === "Email") {
      body.subject = input.subject || "Following up";
      body.html = input.body
        .split(/\n{2,}/)
        .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
        .join("");
    }
    const data = await this.request<Json>("POST", "/conversations/messages", body);
    return { id: str(data.messageId) || str(data.conversationId), delivered: true };
  }
}

function clean(input: ContactInput, keepEmpty = false): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(input)) {
    // GHL validates email/phone formats, so a blank one is left unchanged rather than sent.
    if (v === undefined || (v === "" && (!keepEmpty || k === "email" || k === "phone"))) continue;
    if (k === "customFields" && Array.isArray(v)) {
      out.customFields = v.map((f) => ({ id: f.id, field_value: f.value }));
      continue;
    }
    out[k] = v;
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

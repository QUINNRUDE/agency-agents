// Local CRM used until GoHighLevel is connected. Same interface as the GHL
// adapter, persisted to data/demo-crm.json, seeded with a realistic book of
// business so every screen has something to show on first run.
import { JsonFile, uid } from "../store.ts";
import type {
  Appointment,
  Contact,
  ContactInput,
  Conversation,
  ContactQuery,
  Crm,
  CrmInfo,
  CustomField,
  User,
  Message,
  Note,
  Opportunity,
  OpportunityInput,
  Pipeline,
  SendMessageInput,
  Task,
  TaskInput,
} from "./types.ts";
import { CrmError, normalizeChannel } from "./types.ts";

interface DemoDb {
  users: User[];
  customFields: CustomField[];
  contacts: Contact[];
  pipelines: Pipeline[];
  opportunities: Opportunity[];
  notes: Note[];
  tasks: Task[];
  appointments: Appointment[];
  messages: Message[];
  /** False once the user removed the sample business. Missing = the sample (older files). */
  sample?: boolean;
}

// Deterministic PRNG so the seed is identical on every machine.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Maya", "Daniel", "Priya", "Marcus", "Elena", "Jordan", "Sofia", "Andre", "Hannah", "Luis", "Grace", "Omar", "Chloe", "Ravi", "Natalie", "Tyler", "Isabel", "Kevin", "Amara", "Brett", "Leah", "Victor", "Jasmine", "Cole", "Nadia", "Ethan", "Rosa", "Felix", "Tessa", "Damon", "Yuki", "Caleb", "Monica", "Simon", "Dana", "Wes", "Ines", "Gavin", "Paige", "Arjun", "Lauren", "Nico", "Bianca", "Trent", "Mira", "Owen", "Celeste", "Reid"];
const LAST = ["Alvarez", "Brooks", "Chen", "Dawson", "Ellis", "Foster", "Garcia", "Hayes", "Iyer", "Jensen", "Kowalski", "Lopez", "Mendez", "Nguyen", "Okafor", "Patel", "Quinn", "Reyes", "Sullivan", "Torres", "Underwood", "Vasquez", "Walsh", "Xu", "Young", "Zimmer", "Barrett", "Castillo", "Duarte", "Fischer", "Holt", "Lambert", "Moreno", "Novak", "Price", "Ramos", "Shaw", "Tran", "Vance", "Ward", "Becker", "Cruz", "Delgado", "Ford", "Grant", "Hart", "Keller", "Lowe"];
const BUSINESSES: [string, string][] = [
  ["Brightline Dental", "Dentist"], ["Summit Roofing Co.", "Roofer"], ["Glow Aesthetics Med Spa", "Med spa"], ["Northside HVAC", "HVAC"],
  ["Riverbend Family Law", "Law firm"], ["Peak Performance PT", "Physical therapy"], ["Harbor Auto Detailing", "Auto detailing"], ["Evergreen Landscaping", "Landscaping"],
  ["Cornerstone Chiropractic", "Chiropractor"], ["Bluewater Pools", "Pool service"], ["Apex Plumbing & Drain", "Plumber"], ["Lumen Dermatology", "Dermatology"],
  ["Ironworks Fitness", "Gym"], ["Oakridge Realty Group", "Real estate"], ["Fresh Start Cleaning", "Cleaning"], ["Sterling Solar", "Solar"],
  ["Cedar & Stone Remodeling", "Remodeling"], ["Paws & Claws Vet Clinic", "Veterinary"], ["Main Street Insurance", "Insurance"], ["Velvet Hair Studio", "Salon"],
  ["Pinnacle Orthodontics", "Orthodontist"], ["Clearview Windows", "Windows & doors"], ["Rapid Restoration", "Water damage"], ["Golden Years Home Care", "Home care"],
  ["Elevate Wellness Clinic", "Wellness clinic"], ["Metro Movers", "Moving"], ["Keystone Accounting", "Accounting"], ["Lakeshore Pest Control", "Pest control"],
  ["Urban Smile Dental", "Dentist"], ["TrueNorth Electric", "Electrician"], ["Serenity Day Spa", "Spa"], ["Granite Countertops Plus", "Countertops"],
  ["Precision Garage Doors", "Garage doors"], ["Hilltop Animal Hospital", "Veterinary"], ["Coastal Kitchen & Bath", "Remodeling"], ["Prime Fence Co.", "Fencing"],
  ["Radiant Skin Bar", "Med spa"], ["Ascend Martial Arts", "Martial arts"], ["Willow Pediatric Dentistry", "Dentist"], ["Bolt Roofing & Gutters", "Roofer"],
  ["Haven Senior Living", "Senior living"], ["Crestline Tree Service", "Tree service"], ["Nova Laser Center", "Med spa"], ["Benchmark Builders", "Contractor"],
  ["Silverline Painting", "Painting"], ["Anchor Marine Repair", "Marine"], ["Fairway Physical Therapy", "Physical therapy"], ["Redwood Wealth Advisors", "Financial advisor"],
];
const CITIES: [string, string][] = [["Austin", "TX"], ["Denver", "CO"], ["Tampa", "FL"], ["Phoenix", "AZ"], ["Nashville", "TN"], ["Charlotte", "NC"], ["San Diego", "CA"], ["Raleigh", "NC"], ["Boise", "ID"], ["Columbus", "OH"]];
const SOURCES = ["Facebook Ads", "Google Ads", "Referral", "Cold outreach", "Website form", "Bloom AI Finder", "LinkedIn", "Google Ads", "Referral", "Website form"];

const USERS: User[] = [
  { id: "us_1", name: "Alex Morgan", email: "alex@youragency.com" },
  { id: "us_2", name: "Jamie Lee", email: "jamie@youragency.com" },
  { id: "us_3", name: "Riley Park", email: "riley@youragency.com" },
];

const CUSTOM_FIELDS: CustomField[] = [
  { id: "cf_budget", name: "Monthly marketing budget", dataType: "MONETORY", options: [] },
  { id: "cf_provider", name: "Current marketing provider", dataType: "SINGLE_OPTIONS", options: ["None / in-house", "Freelancer", "Another agency", "Franchise corporate"] },
  { id: "cf_decision", name: "Decision maker", dataType: "TEXT", options: [] },
  { id: "cf_renewal", name: "Contract renewal date", dataType: "DATE", options: [] },
  { id: "cf_goal", name: "Primary goal", dataType: "LARGE_TEXT", options: [] },
];

const NOTE_LINES = [
  "Owner handles marketing personally; time is the main constraint. Wants leads without managing an agency day to day.",
  "Currently spending ~$2k/mo on Google Ads with a freelancer. Unsure what the cost per lead is — no call tracking.",
  "Had a bad experience with a previous agency (locked into 12-month contract). Month-to-month is important.",
  "Front desk misses calls after 5pm. Interested in missed-call text-back and online booking.",
  "Reviews are strong (4.8) but only 40 of them; main competitor has 300+. Review automation is a clear angle.",
  "Decision is shared with business partner — need both on the next call.",
  "Asked for case studies in their niche before the proposal.",
  "Seasonal business; wants to ramp spend in March ahead of peak.",
  "Website built in 2019, not mobile friendly, no booking. Open to a rebuild if ROI is clear.",
  "Budget confirmed around $3k/mo all-in. Wants reporting they can read in 2 minutes.",
];

function defaultPipelines(): Pipeline[] {
  return [
    {
      id: "pl_acq",
      name: "Client Acquisition",
      stages: [
        { id: "st_new", name: "New Lead", position: 0 },
        { id: "st_contacted", name: "Contacted", position: 1 },
        { id: "st_discovery", name: "Discovery Booked", position: 2 },
        { id: "st_proposal", name: "Proposal Sent", position: 3 },
        { id: "st_negotiation", name: "Negotiation", position: 4 },
        { id: "st_won", name: "Closed Won", position: 5 },
      ],
    },
    {
      id: "pl_acct",
      name: "Account Management",
      stages: [
        { id: "st_onboard", name: "Onboarding", position: 0 },
        { id: "st_active", name: "Active", position: 1 },
        { id: "st_risk", name: "At Risk", position: 2 },
        { id: "st_renewal", name: "Renewal Due", position: 3 },
      ],
    },
  ];
}

/** A clean local workspace: the same pipelines and fields, and no sample clients. */
function emptyWorkspace(ownerName: string): DemoDb {
  return {
    users: [{ id: "us_me", name: ownerName || "Me", email: "" }],
    customFields: CUSTOM_FIELDS,
    contacts: [],
    pipelines: defaultPipelines(),
    opportunities: [],
    notes: [],
    tasks: [],
    appointments: [],
    messages: [],
    sample: false,
  };
}

function seed(): DemoDb {
  const r = rng(20261127);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const now = Date.now();
  const day = 86_400_000;
  const ago = (d: number) => new Date(now - d * day).toISOString();

  const [acquisition, accounts] = defaultPipelines();

  const contacts: Contact[] = BUSINESSES.map(([company, niche], i) => {
    const firstName = FIRST[i % FIRST.length];
    const lastName = LAST[(i * 7) % LAST.length];
    const [city, state] = CITIES[i % CITIES.length];
    const domain = company.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "").slice(0, 22);
    const added = Math.floor(r() * 120);
    return {
      id: `ct_${String(i + 1).padStart(3, "0")}`,
      firstName,
      lastName,
      name: `${firstName} ${lastName}`,
      email: `${firstName.toLowerCase()}@${domain}.com`,
      phone: `+1${["512", "303", "813", "602", "615", "704", "619", "919", "208", "614"][i % 10]}555${String(1000 + Math.floor(r() * 8999))}`,
      companyName: company,
      website: i % 6 === 3 ? "" : `https://www.${domain}.com`,
      city,
      state,
      source: SOURCES[i % SOURCES.length],
      tags: [niche.toLowerCase(), ...(i % 4 === 0 ? ["hot"] : []), ...(i % 5 === 1 ? ["referral-partner"] : [])],
      dateAdded: ago(added),
      lastActivity: ago(Math.max(0, added - Math.floor(r() * added))),
      dnd: false,
      assignedTo: i % 5 === 4 ? "" : USERS[i % 3].id,
      customFields: [
        { id: "cf_budget", value: String(1000 + (i % 6) * 750) },
        { id: "cf_provider", value: CUSTOM_FIELDS[1].options[i % 4] },
        ...(i % 2 === 0 ? [{ id: "cf_decision", value: i % 4 === 0 ? `${firstName} (owner)` : `${firstName} + business partner` }] : []),
        ...(i % 3 === 0 ? [{ id: "cf_goal", value: ["More booked jobs in the slow season", "Lower cost per lead", "Fill the new location's calendar", "More 5-star reviews than the competitor"][i % 4] }] : []),
      ],
    };
  });

  const opportunities: Opportunity[] = [];
  const stageWeights = ["st_new", "st_new", "st_contacted", "st_contacted", "st_discovery", "st_discovery", "st_proposal", "st_negotiation", "st_won"];
  contacts.slice(0, 38).forEach((c, i) => {
    const stageId = i < 30 ? stageWeights[i % stageWeights.length] : "st_won";
    const lost = i % 11 === 10;
    const value = Math.round((1500 + r() * 6500) / 250) * 250;
    const created = Math.min(Math.floor(r() * 90) + 2, 118);
    opportunities.push({
      id: `op_${String(i + 1).padStart(3, "0")}`,
      name: `${c.companyName} — ${pick(["Growth retainer", "Lead gen + CRM", "Paid ads management", "Website + funnel", "Reputation & reviews"])}`,
      pipelineId: acquisition.id,
      stageId,
      status: lost ? "lost" : stageId === "st_won" ? "won" : "open",
      value,
      contactId: c.id,
      contactName: c.name,
      companyName: c.companyName,
      createdAt: ago(created),
      updatedAt: ago(Math.floor(r() * created)),
      lastStageChangeAt: ago(Math.floor(r() * Math.min(created, 30))),
    });
  });
  contacts.slice(30, 44).forEach((c, i) => {
    opportunities.push({
      id: `op_a${i + 1}`,
      name: `${c.companyName} — Monthly retainer`,
      pipelineId: accounts.id,
      stageId: ["st_onboard", "st_active", "st_active", "st_active", "st_risk", "st_renewal"][i % 6],
      status: "open",
      value: Math.round((2000 + r() * 5000) / 250) * 250,
      contactId: c.id,
      contactName: c.name,
      companyName: c.companyName,
      createdAt: ago(60 + i * 5),
      updatedAt: ago(i * 2),
      lastStageChangeAt: ago(i * 3),
    });
  });

  const notes: Note[] = [];
  const tasks: Task[] = [];
  const messages: Message[] = [];
  contacts.forEach((c, i) => {
    const n = 1 + (i % 3);
    for (let k = 0; k < n; k++) {
      notes.push({ id: `nt_${i}_${k}`, contactId: c.id, body: NOTE_LINES[(i + k * 3) % NOTE_LINES.length], dateAdded: ago(k * 6 + (i % 9)) });
    }
    if (i % 3 !== 2) {
      tasks.push({
        id: `tk_${i}`,
        contactId: c.id,
        title: pick(["Follow-up call", "Send case study", "Send proposal", "Confirm discovery call", "Check in after onboarding", "Ask for referral"]),
        body: "",
        dueDate: new Date(now + (Math.floor(r() * 10) - 3) * day).toISOString(),
        completed: i % 7 === 0,
        assignedTo: c.assignedTo,
        contactName: c.name,
      });
    }
    messages.push({ id: `ms_${i}_o`, contactId: c.id, direction: "outbound", channel: "SMS", body: `Hi ${c.firstName}, thanks for reaching out about ${c.companyName}. Is now still a good time to chat about getting more booked jobs?`, dateAdded: ago(10 + (i % 7)) });
    if (i % 2 === 0) messages.push({ id: `ms_${i}_i`, contactId: c.id, direction: "inbound", channel: "SMS", body: pick(["Yes — tomorrow afternoon works.", "Can you send some info first?", "Call me after 3.", "We're interested, what does pricing look like?"]), dateAdded: ago(9 + (i % 7)) });
  });

  // A few recent Instagram / Messenger conversations (inside Meta's 24-hour window) for the inbox and DM automations.
  const DMS: [number, "IG" | "FB", string, number][] = [
    [3, "IG", "Hey! Saw your ad — do you work with businesses like ours?", 2],
    [7, "FB", "How much does it cost to get started?", 5],
    [12, "IG", "Can you send me some examples of your work?", 9],
    [18, "FB", "Do you have availability for a call this week?", 14],
  ];
  for (const [ci, ch, body, hoursAgo] of DMS) {
    const c = contacts[ci];
    messages.push({ id: `dm_${ci}`, contactId: c.id, direction: "inbound", channel: ch, body, dateAdded: new Date(now - hoursAgo * 3_600_000).toISOString() });
  }

  const appointments: Appointment[] = [];
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  [9.5, 11, 13.5, 15, 16.5].forEach((h, i) => {
    const c = contacts[(i * 5 + 2) % contacts.length];
    const start = new Date(startOfToday.getTime() + h * 3_600_000 + (i > 2 ? day : 0));
    appointments.push({
      id: `ap_${i}`,
      title: `${["Discovery call", "Proposal review", "Strategy session", "Onboarding kickoff", "Discovery call"][i]} — ${c.companyName}`,
      contactId: c.id,
      calendarName: i % 2 ? "Sales calls" : "Discovery",
      startTime: start.toISOString(),
      endTime: new Date(start.getTime() + 30 * 60_000).toISOString(),
      status: "confirmed",
    });
  });

  return { users: USERS, customFields: CUSTOM_FIELDS, contacts, pipelines: [acquisition, accounts], opportunities, notes, tasks, appointments, messages };
}

export class DemoCrm implements Crm {
  private file = new JsonFile<DemoDb>("demo-crm.json", seed);
  // Upgrades demo files created by earlier versions.
  private db = {
    read: (): DemoDb => {
      const d = this.file.read();
      if (!d.users) d.users = USERS;
      if (!d.customFields) d.customFields = CUSTOM_FIELDS;
      for (const c of d.contacts) {
        c.assignedTo ??= "";
        c.customFields ??= [];
      }
      for (const m of d.messages) m.channel = normalizeChannel(m.channel);
      for (const t of d.tasks) {
        t.assignedTo ??= "";
        t.contactName ??= d.contacts.find((c) => c.id === t.contactId)?.name ?? "";
      }
      return d;
    },
    update: (fn: (d: DemoDb) => void) => {
      const d = this.db.read();
      fn(d);
      this.file.write(d);
      return d;
    },
  };

  async info(): Promise<CrmInfo> {
    const sample = this.isSample();
    return { mode: "demo", accountName: sample ? "Demo workspace" : "Your workspace", sample };
  }

  isSample(): boolean {
    return this.db.read().sample !== false;
  }

  /** Ids of every contact in the local workspace (to tidy up records that point at them). */
  contactIds(): Set<string> {
    return new Set(this.db.read().contacts.map((c) => c.id));
  }

  /** Replaces the local workspace with an empty one. */
  startFresh(ownerName: string): void {
    this.file.write(emptyWorkspace(ownerName));
  }

  /** Replaces the local workspace with the sample business again. */
  loadSample(): void {
    this.file.write(seed());
  }

  async listContacts(q: ContactQuery): Promise<Contact[]> {
    const term = (q.query ?? "").toLowerCase().trim();
    const all = this.db.read().contacts;
    const hits = term
      ? all.filter((c) => [c.name, c.email, c.phone, c.companyName, c.city, ...c.tags].join(" ").toLowerCase().includes(term))
      : all;
    return [...hits].sort((a, b) => b.dateAdded.localeCompare(a.dateAdded)).slice(0, q.limit ?? 500);
  }

  async getContact(id: string): Promise<Contact | null> {
    return this.db.read().contacts.find((c) => c.id === id) ?? null;
  }

  async createContact(input: ContactInput): Promise<Contact> {
    const firstName = input.firstName ?? "";
    const lastName = input.lastName ?? "";
    const contact: Contact = {
      id: uid("ct"),
      firstName,
      lastName,
      name: [firstName, lastName].filter(Boolean).join(" ") || input.companyName || input.email || "New contact",
      email: input.email ?? "",
      phone: input.phone ?? "",
      companyName: input.companyName ?? "",
      website: input.website ?? "",
      city: input.city ?? "",
      state: input.state ?? "",
      source: input.source ?? "Manual",
      tags: input.tags ?? [],
      dateAdded: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      dnd: false,
      assignedTo: input.assignedTo ?? "",
      customFields: input.customFields ?? [],
    };
    this.db.update((d) => d.contacts.push(contact));
    return contact;
  }

  async updateContact(id: string, input: ContactInput): Promise<Contact> {
    let out: Contact | undefined;
    this.db.update((d) => {
      const c = d.contacts.find((x) => x.id === id);
      if (!c) return;
      const { customFields, ...rest } = input;
      Object.assign(c, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
      if (customFields) {
        const merged = new Map(c.customFields.map((f) => [f.id, f.value]));
        for (const f of customFields) merged.set(f.id, f.value);
        c.customFields = [...merged].filter(([, v]) => v !== "").map(([id, value]) => ({ id, value }));
      }
      c.name = [c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || c.name;
      c.lastActivity = new Date().toISOString();
      out = c;
    });
    if (!out) throw new CrmError("Contact not found", 404);
    return out;
  }

  async addTags(id: string, tags: string[]): Promise<void> {
    this.db.update((d) => {
      const c = d.contacts.find((x) => x.id === id);
      if (c) c.tags = [...new Set([...c.tags, ...tags])];
    });
  }

  async removeTags(id: string, tags: string[]): Promise<void> {
    this.db.update((d) => {
      const c = d.contacts.find((x) => x.id === id);
      if (c) c.tags = c.tags.filter((t) => !tags.includes(t));
    });
  }

  async deleteContact(id: string): Promise<void> {
    this.db.update((d) => {
      d.contacts = d.contacts.filter((c) => c.id !== id);
      d.opportunities = d.opportunities.filter((o) => o.contactId !== id);
      d.notes = d.notes.filter((n) => n.contactId !== id);
      d.tasks = d.tasks.filter((t) => t.contactId !== id);
      d.messages = d.messages.filter((m) => m.contactId !== id);
    });
  }

  async listUsers(): Promise<User[]> {
    return this.db.read().users;
  }

  async listCustomFields(): Promise<CustomField[]> {
    return this.db.read().customFields;
  }

  async listPipelines(): Promise<Pipeline[]> {
    return this.db.read().pipelines;
  }

  async listOpportunities(pipelineId?: string): Promise<Opportunity[]> {
    const all = this.db.read().opportunities;
    return pipelineId ? all.filter((o) => o.pipelineId === pipelineId) : all;
  }

  async createOpportunity(input: OpportunityInput): Promise<Opportunity> {
    const d = this.db.read();
    const contact = d.contacts.find((c) => c.id === input.contactId);
    const pipeline = d.pipelines.find((p) => p.id === input.pipelineId) ?? d.pipelines[0];
    const now = new Date().toISOString();
    const opp: Opportunity = {
      id: uid("op"),
      name: input.name ?? `${contact?.companyName || contact?.name || "New"} — Opportunity`,
      pipelineId: pipeline.id,
      stageId: input.stageId ?? pipeline.stages[0].id,
      status: input.status ?? "open",
      value: input.value ?? 0,
      contactId: input.contactId ?? "",
      contactName: contact?.name ?? "",
      companyName: contact?.companyName ?? "",
      createdAt: now,
      updatedAt: now,
      lastStageChangeAt: now,
    };
    this.db.update((x) => x.opportunities.push(opp));
    return opp;
  }

  async updateOpportunity(id: string, input: OpportunityInput): Promise<Opportunity> {
    let out: Opportunity | undefined;
    this.db.update((d) => {
      const o = d.opportunities.find((x) => x.id === id);
      if (!o) return;
      const now = new Date().toISOString();
      if (input.stageId && input.stageId !== o.stageId) {
        o.stageId = input.stageId;
        o.lastStageChangeAt = now;
        const stage = d.pipelines.flatMap((p) => p.stages).find((s) => s.id === input.stageId);
        if (stage && /won/i.test(stage.name)) o.status = "won";
      }
      if (input.name) o.name = input.name;
      if (input.value !== undefined) o.value = input.value;
      if (input.status) o.status = input.status;
      o.updatedAt = now;
      out = o;
    });
    if (!out) throw new CrmError("Opportunity not found", 404);
    return out;
  }

  async deleteOpportunity(id: string): Promise<void> {
    this.db.update((d) => {
      d.opportunities = d.opportunities.filter((o) => o.id !== id);
    });
  }

  async listNotes(contactId: string): Promise<Note[]> {
    return this.db.read().notes.filter((n) => n.contactId === contactId).sort((a, b) => b.dateAdded.localeCompare(a.dateAdded));
  }

  async addNote(contactId: string, body: string): Promise<Note> {
    const note: Note = { id: uid("nt"), contactId, body, dateAdded: new Date().toISOString() };
    this.db.update((d) => {
      d.notes.push(note);
      const c = d.contacts.find((x) => x.id === contactId);
      if (c) c.lastActivity = note.dateAdded;
    });
    return note;
  }

  async updateNote(_contactId: string, noteId: string, body: string): Promise<Note> {
    let out: Note | undefined;
    this.db.update((d) => {
      const n = d.notes.find((x) => x.id === noteId);
      if (n) n.body = body;
      out = n;
    });
    if (!out) throw new CrmError("Note not found", 404);
    return out;
  }

  async deleteNote(_contactId: string, noteId: string): Promise<void> {
    this.db.update((d) => {
      d.notes = d.notes.filter((n) => n.id !== noteId);
    });
  }

  async listTasks(contactId: string): Promise<Task[]> {
    return this.db.read().tasks.filter((t) => t.contactId === contactId);
  }

  async addTask(contactId: string, input: TaskInput): Promise<Task> {
    const contact = this.db.read().contacts.find((c) => c.id === contactId);
    const task: Task = {
      id: uid("tk"),
      contactId,
      title: input.title,
      body: input.body ?? "",
      dueDate: new Date(input.dueDate).toISOString(),
      completed: false,
      assignedTo: input.assignedTo ?? contact?.assignedTo ?? "",
      contactName: contact?.name ?? "",
    };
    this.db.update((d) => d.tasks.push(task));
    return task;
  }

  async completeTask(_contactId: string, taskId: string, completed: boolean): Promise<void> {
    this.db.update((d) => {
      const t = d.tasks.find((x) => x.id === taskId);
      if (t) t.completed = completed;
    });
  }

  async updateTask(_contactId: string, taskId: string, input: Partial<TaskInput>): Promise<Task> {
    let out: Task | undefined;
    this.db.update((d) => {
      const t = d.tasks.find((x) => x.id === taskId);
      if (!t) return;
      if (input.title !== undefined) t.title = input.title;
      if (input.body !== undefined) t.body = input.body;
      if (input.dueDate) t.dueDate = new Date(input.dueDate).toISOString();
      if (input.assignedTo !== undefined) t.assignedTo = input.assignedTo;
      if (input.completed !== undefined) t.completed = input.completed;
      out = t;
    });
    if (!out) throw new CrmError("Task not found", 404);
    return out;
  }

  async deleteTask(_contactId: string, taskId: string): Promise<void> {
    this.db.update((d) => {
      d.tasks = d.tasks.filter((t) => t.id !== taskId);
    });
  }

  async listAllTasks(opts: { completed?: boolean; limit?: number }): Promise<Task[]> {
    const d = this.db.read();
    const names = new Map(d.contacts.map((c) => [c.id, c.name]));
    return d.tasks
      .filter((t) => opts.completed === undefined || t.completed === opts.completed)
      .map((t) => ({ ...t, contactName: names.get(t.contactId) ?? t.contactName }))
      .slice(0, opts.limit ?? 1000);
  }

  async listAppointments(fromIso: string, toIso: string): Promise<Appointment[]> {
    return this.db
      .read()
      .appointments.filter((a) => a.startTime >= fromIso && a.startTime <= toIso)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  }

  async listMessages(contactId: string): Promise<Message[]> {
    return this.db.read().messages.filter((m) => m.contactId === contactId).sort((a, b) => b.dateAdded.localeCompare(a.dateAdded));
  }

  async listConversations(limit: number): Promise<Conversation[]> {
    const d = this.db.read();
    const byContact = new Map<string, Message[]>();
    for (const m of d.messages) byContact.set(m.contactId, [...(byContact.get(m.contactId) ?? []), m]);
    const names = new Map(d.contacts.map((c) => [c.id, c.name]));
    return [...byContact.entries()]
      .filter(([cid]) => names.has(cid))
      .map(([cid, list]) => {
        const last = list.sort((a, b) => b.dateAdded.localeCompare(a.dateAdded))[0];
        return {
          id: `conv_${cid}`,
          contactId: cid,
          contactName: names.get(cid) ?? "",
          lastMessageBody: last.body,
          lastMessageDate: last.dateAdded,
          lastMessageDirection: last.direction,
          channel: last.channel,
          unread: last.direction === "inbound" ? 1 : 0,
        };
      })
      .sort((a, b) => b.lastMessageDate.localeCompare(a.lastMessageDate))
      .slice(0, limit);
  }

  /** Demo only: pretend a contact sent us a message, so automations and the inbox can be tried without GoHighLevel. */
  simulateInbound(contactId: string, channel: string, body: string): Message {
    const msg: Message = { id: uid("ms"), contactId, direction: "inbound", channel: normalizeChannel(channel), body, dateAdded: new Date().toISOString() };
    this.db.update((d) => {
      d.messages.push(msg);
      const c = d.contacts.find((x) => x.id === contactId);
      if (c) c.lastActivity = msg.dateAdded;
    });
    return msg;
  }

  async sendMessage(input: SendMessageInput): Promise<{ id: string; delivered: boolean }> {
    const msg: Message = {
      id: uid("ms"),
      contactId: input.contactId,
      direction: "outbound",
      channel: input.channel,
      body: input.subject ? `${input.subject}\n\n${input.body}` : input.body,
      dateAdded: new Date().toISOString(),
    };
    this.db.update((d) => d.messages.push(msg));
    // Demo mode records the message but nothing leaves the machine.
    return { id: msg.id, delivered: false };
  }
}
